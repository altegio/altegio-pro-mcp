import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

async function regularTree(root, directory) {
  // Check every ancestor too: bind mounts must not resolve through a symlink.
  for (
    let item = path.resolve(root);
    item !== path.dirname(item);
    item = path.dirname(item)
  ) {
    assert.ok(
      !(await lstat(item)).isSymbolicLink(),
      'Candidate mount contains a link'
    );
  }
  const stat = await lstat(root);
  assert.ok(directory ? stat.isDirectory() : stat.isFile());
  if (!directory)
    assert.equal(stat.nlink, 1, 'Candidate mount contains a hard link');
  if (directory) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      assert.ok(
        entry.isFile() || entry.isDirectory(),
        'Candidate mount contains a special file'
      );
      await regularTree(path.join(root, entry.name), entry.isDirectory());
    }
  }
}

/** Run only candidate generator inputs; compare bytes exclusively on the host. */
export async function runSandbox({
  candidate,
  snapshot,
  image,
  name,
  timeoutMs = 120_000,
  outputLimit = 16 * 1024 * 1024,
}) {
  assert.match(name, /^catalog-[a-zA-Z0-9_-]+$/);
  // Normalize trusted host aliases (macOS /var and /tmp). Links inside the
  // candidate tree remain forbidden by regularTree below.
  candidate = await realpath(candidate);
  const mounts = [
    ['scripts/catalog', '/app/scripts/catalog'],
    ['catalog/overlay', '/app/catalog/overlay'],
  ];
  for (const [relative] of mounts)
    await regularTree(path.resolve(candidate, relative), true);
  const expectedPath = path.resolve(candidate, 'src/generated/catalog.json');
  await regularTree(expectedPath, false);
  assert.ok((await lstat(expectedPath)).size <= outputLimit);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'catalog-output-'));
  const outputPath = path.join(temp, 'output');
  const output = await open(outputPath, 'wx', 0o600);
  let child;
  let timer;
  try {
    const args = [
      'run',
      '--rm',
      '--name',
      name,
      '--log-driver=none',
      '--network=none',
      '--ipc=none',
      '--read-only',
      '--user=65534:65534',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=64',
      '--memory=512m',
      '--cpus=1',
      '--ulimit=nofile=128:128',
      '--ulimit=fsize=16777216:16777216',
      '--tmpfs=/tmp:rw,noexec,nosuid,size=32m,uid=65534,gid=65534',
      '--mount',
      `type=bind,src=${path.resolve(snapshot)},dst=/spec,readonly`,
      ...mounts.flatMap(([relative, destination]) => [
        '--mount',
        `type=bind,src=${path.resolve(candidate, relative)},dst=${destination},readonly`,
      ]),
      image,
      'sh',
      '-c',
      'node scripts/catalog/build.mjs --docs /spec --out /tmp/catalog.json --quiet && cat /tmp/catalog.json',
    ];
    child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code));
    });
    // Install the handler immediately, including when stdout fails before close.
    void exited.catch(() => {});
    let timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    let size = 0;
    for await (const chunk of child.stdout) {
      size += chunk.length;
      assert.ok(
        size <= outputLimit,
        'Candidate output exceeds the private limit'
      );
      await output.writeFile(chunk);
    }
    assert.equal(await exited, 0, 'Candidate sandbox failed');
    assert.ok(!timedOut, 'Candidate sandbox timed out');
    await output.close();
    assert.ok(
      (await readFile(outputPath)).equals(await readFile(expectedPath)),
      'Pinned catalog drift'
    );
  } finally {
    clearTimeout(timer);
    child?.kill('SIGKILL');
    // Killing the Docker client alone does not reliably stop the container.
    spawnSync('docker', ['rm', '--force', name], {
      stdio: 'ignore',
      timeout: 15_000,
    });
    await output.close();
    await rm(temp, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runSandbox({
      candidate: process.argv[2],
      snapshot: process.argv[3],
      image: process.argv[4],
      name: process.argv[5],
    });
    console.log('Pinned-spec generator comparison passed.');
  } catch {
    console.error(
      'Private catalog sandbox/comparison failed; candidate output was discarded.'
    );
    process.exitCode = 1;
  }
}
