import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadOverlay } from './build.mjs';

// Public validation of the actual overlay, independent of the private schema.
// This catches a typo or missed rebuild in a fork, not just fixture regressions.
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const overlay = loadOverlay(path.join(root, 'catalog/overlay'));
const catalog = JSON.parse(
  await readFile(path.join(root, 'src/generated/catalog.json'), 'utf8')
);
const byId = new Map(
  catalog.operations.map((operation) => [operation.operationId, operation])
);
for (const [id, entry] of overlay) {
  assert.ok(
    byId.has(id),
    `Overlay entry ${id} is absent from the committed catalog`
  );
  assert.deepEqual(
    byId.get(id).curation,
    entry,
    `Overlay drift for ${id}; regenerate the catalog with a reviewed spec`
  );
}
for (const operation of catalog.operations) {
  if (operation.curation)
    assert.ok(
      overlay.has(operation.operationId),
      `Stale curation: ${operation.operationId}`
    );
}
console.log(`Public overlay check OK: ${overlay.size} validated entries`);
