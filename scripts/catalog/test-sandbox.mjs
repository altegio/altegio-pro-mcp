/** Explicit Docker regression checks. Only public synthetic data is mounted. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSandbox } from './run-trusted.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const image = process.argv[2];
assert.ok(
  image,
  'Usage: node scripts/catalog/test-sandbox.mjs <trusted-image>'
);
const temp = await mkdtemp(path.join(os.tmpdir(), 'catalog-containment-'));
const candidate = path.join(temp, 'candidate');
const snapshot = path.join(root, 'scripts/catalog/__tests__/fixtures/spec');
let index = 0;
async function check(options = {}) {
  const name = `catalog-test-${process.pid}-${index++}`;
  try {
    await runSandbox({ candidate, snapshot, image, name, ...options });
  } finally {
    const inspect = spawnSync('docker', ['container', 'inspect', name], {
      stdio: 'ignore',
    });
    assert.notEqual(inspect.status, 0, 'Sandbox container survived cleanup');
  }
}
try {
  await mkdir(path.join(candidate, 'src/generated'), { recursive: true });
  await mkdir(path.join(candidate, 'catalog'), { recursive: true });
  await mkdir(path.join(candidate, 'scripts'), { recursive: true });
  await cp(
    path.join(root, 'scripts/catalog'),
    path.join(candidate, 'scripts/catalog'),
    { recursive: true }
  );
  await cp(
    path.join(root, 'scripts/catalog/__tests__/fixtures/overlay'),
    path.join(candidate, 'catalog/overlay'),
    { recursive: true }
  );
  const expected = path.join(candidate, 'src/generated/catalog.json');
  const generator = path.join(candidate, 'scripts/catalog/build.mjs');
  const build = spawnSync(
    process.execPath,
    [
      path.join(root, 'scripts/catalog/build.mjs'),
      '--docs',
      snapshot,
      '--overlay',
      path.join(candidate, 'catalog/overlay'),
      '--out',
      expected,
      '--quiet',
    ],
    { cwd: root, encoding: 'utf8' }
  );
  assert.equal(build.status, 0, 'Synthetic baseline build failed');
  await check();
  console.log('PASS: real generator equals the committed synthetic catalog');
  const bytes = await readFile(expected);
  await writeFile(expected, '{}');
  await assert.rejects(check());
  await writeFile(expected, bytes);
  console.log('PASS: mismatched expected bytes fail');

  await writeFile(expected, '{"contained":true}\n');
  process.env.CATALOG_HOST_SENTINEL = 'host-secret-synthetic-only';
  await writeFile(
    generator,
    `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    assert.equal(process.getuid(),65534);
    assert.equal(process.env.CATALOG_HOST_SENTINEL,undefined);
    assert.equal(fs.existsSync('/expected/catalog.json'),false);
    for(const file of ['/spec/new','/app/catalog/overlay/new','/app/scripts/catalog/new','/app/node_modules/new']) {
      assert.throws(()=>fs.writeFileSync(file,'forbidden'));
    }
    await assert.rejects(fetch('https://example.com',{signal:AbortSignal.timeout(1500)}));
    assert.throws(()=>fs.writeFileSync('/tmp/too-large',Buffer.alloc(34*1024*1024)));
    fs.writeFileSync('/tmp/catalog.json','{"contained":true}\\n');
  `
  );
  await check();
  console.log(
    'PASS: UID, environment, expected-file, mount, network and file-size containment'
  );

  await writeFile(
    generator,
    "process.stdout.write('PRIVATE_SYNTHETIC_OUTPUT'); process.exit(1);"
  );
  await assert.rejects(check());
  console.log('PASS: candidate failure/output stays private');
  await writeFile(
    generator,
    "while(true) process.stdout.write('PRIVATE_SYNTHETIC_OUTPUT'.repeat(1024));"
  );
  await assert.rejects(check({ outputLimit: 4096 }));
  console.log('PASS: excessive output is bounded and cleaned up');
  await writeFile(generator, 'setInterval(()=>{},1000);');
  await assert.rejects(check({ timeoutMs: 1500 }));
  console.log('PASS: timeout removes the running container');
  await symlink('/etc/passwd', path.join(candidate, 'catalog/overlay/link'));
  await assert.rejects(check());
  await unlink(path.join(candidate, 'catalog/overlay/link'));
  await link(expected, path.join(candidate, 'catalog/overlay/hardlink'));
  await assert.rejects(check());
  console.log('PASS: linked candidate input rejected');
} finally {
  delete process.env.CATALOG_HOST_SENTINEL;
  await rm(temp, { recursive: true, force: true });
}
