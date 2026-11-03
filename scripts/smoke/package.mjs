import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { smokeStdio } from './stdio.mjs';

const tarball = path.resolve(process.argv[2] ?? '');
const revision = process.argv[3];
assert.match(
  revision ?? '',
  /^[a-f0-9]{40}$/,
  'Pass the expected source commit SHA'
);
assert.ok(
  tarball.endsWith('.tgz'),
  'Usage: node scripts/smoke/package.mjs <built-package.tgz> <commit-sha>'
);
const digest = async () =>
  createHash('sha256')
    .update(await readFile(tarball))
    .digest('hex');
const before = await digest();
const files = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
  .trim()
  .split('\n');
for (const required of [
  'dist/index.js',
  'dist/http-server.js',
  'dist/generated/catalog.json',
  'dist/build-provenance.json',
  'docs/product-logic.md',
  'docs/onboarding-guide.md',
]) {
  assert.ok(
    files.includes(`package/${required}`),
    `Missing runtime file: ${required}`
  );
}
for (const file of files) {
  assert.ok(
    !/(^|\/)(?:\.env(?:\..*)?|credentials\.json|__tests__|__fixtures__|fixtures|\.claude|\.agents)(\/|$)/.test(
      file
    ),
    `Unexpected packaged file: ${file}`
  );
  assert.ok(
    file.startsWith('package/') && !file.split('/').includes('..'),
    'Unexpected archive path'
  );
}
const temp = await mkdtemp(path.join(os.tmpdir(), 'altegio-package-smoke-'));
try {
  await writeFile(
    path.join(temp, 'package.json'),
    JSON.stringify({ private: true, type: 'module' })
  );
  execFileSync(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
      tarball,
    ],
    {
      cwd: temp,
      env: {
        ...process.env,
        HOME: temp,
        CREDENTIALS_DIR: path.join(temp, 'credentials'),
      },
      stdio: 'pipe',
      timeout: 120_000,
    }
  );
  const packageRoot = path.join(temp, 'node_modules/@altegio/mcp-server-pro');
  const source = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8')
  );
  const installed = JSON.parse(
    await readFile(path.join(packageRoot, 'package.json'), 'utf8')
  );
  assert.equal(installed.name, source.name, 'Packaged name');
  assert.equal(installed.version, source.version, 'Packaged version');
  const provenance = JSON.parse(
    await readFile(path.join(packageRoot, 'dist/build-provenance.json'), 'utf8')
  );
  assert.equal(provenance.revision, revision, 'Packaged source revision');
  assert.equal(
    provenance.lockfileSha256,
    createHash('sha256')
      .update(
        await readFile(new URL('../../package-lock.json', import.meta.url))
      )
      .digest('hex'),
    'Packaged lockfile provenance'
  );
  const result = await smokeStdio(packageRoot);
  assert.equal(await digest(), before, 'Tested tarball changed');
  console.log(
    JSON.stringify({
      artifact: path.basename(tarball),
      sha256: before,
      node: process.version,
      ...result,
    })
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
