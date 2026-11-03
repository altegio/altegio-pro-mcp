import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Hash every regular file under docs/en without publishing names or contents. */
export async function specDigest(root) {
  const hash = createHash('sha256');
  async function visit(relative) {
    const entries = await readdir(path.join(root, relative), {
      withFileTypes: true,
    });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else {
        assert.ok(
          entry.isFile(),
          'Pinned specification must contain regular files only'
        );
        const bytes = await readFile(path.join(root, name));
        hash
          .update(name)
          .update('\0')
          .update(createHash('sha256').update(bytes).digest())
          .update('\0');
      }
    }
  }
  await visit('docs/en');
  return hash.digest('hex');
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = process.argv[2];
  assert.ok(
    root,
    'Usage: node scripts/catalog/verify-spec.mjs <snapshot-root> [--print-digest]'
  );
  const sha256 = await specDigest(root);
  if (process.argv.includes('--print-digest')) console.log(sha256);
  else {
    const pin = JSON.parse(
      await readFile(new URL('./spec-pin.json', import.meta.url), 'utf8')
    );
    assert.equal(
      sha256,
      pin.sha256,
      'Private spec content differs from the reviewed pin'
    );
    console.log(
      `Pinned specification verified: ${pin.revision} (sha256:${sha256})`
    );
  }
}
