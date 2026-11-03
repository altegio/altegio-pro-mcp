import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const revision = process.argv[2];
assert.match(
  revision ?? '',
  /^[a-f0-9]{40}$/,
  'Pass the exact source commit SHA'
);
const lockfile = await readFile(
  new URL('../../package-lock.json', import.meta.url)
);
await writeFile(
  new URL('../../dist/build-provenance.json', import.meta.url),
  JSON.stringify(
    {
      revision,
      node: process.version,
      lockfileSha256: createHash('sha256').update(lockfile).digest('hex'),
    },
    null,
    2
  ) + '\n'
);
