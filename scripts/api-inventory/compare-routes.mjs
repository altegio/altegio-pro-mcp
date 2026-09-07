#!/usr/bin/env node
/**
 * Compare documented operations (openapi-inventory.mjs) with backend routes
 * (dump-slim-routes.php) and report the undocumented `/api/v1` surface.
 *
 * Usage:
 *   node scripts/api-inventory/compare-routes.mjs \
 *     [--documented .inventory/documented-ops.tsv] \
 *     [--routes .inventory/backend-routes.tsv] \
 *     [--out .inventory/undocumented-v1.tsv]
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null))
    .filter(Boolean)
);
const documentedFile = path.resolve(args.documented ?? '.inventory/documented-ops.tsv');
const routesFile = path.resolve(args.routes ?? '.inventory/backend-routes.tsv');
const outFile = path.resolve(args.out ?? '.inventory/undocumented-v1.tsv');

const readTsv = (f) =>
  fs
    .readFileSync(f, 'utf8')
    .trim()
    .split('\n')
    .map((l) => l.split('\t'));

// Normalize both sides: drop optional trailing slash markers, collapse every
// path parameter to `{}` so `{salonId:\d+}` and `{location_id}` compare equal.
const norm = (p) =>
  p
    .replace(/\[\/\]$/, '')
    .replace(/\/$/, '')
    .replace(/\{[^}]*\}/g, '{}')
    .toLowerCase();

const documented = readTsv(documentedFile);
const backend = readTsv(routesFile);

// public + developers + b2b-v1 all live under /api/v1 on the backend.
const docKeys = new Set(
  documented
    .filter((r) => ['b2b-v1', 'public', 'developers'].includes(r[0]))
    .map((r) => `${r[1]} ${norm(r[2])}`)
);

const v1 = backend
  .filter((r) => r[2].startsWith('/api/v1'))
  .map((r) => [r[0], r[1], norm(r[2].replace(/^\/api\/v1/, ''))]);
const seen = new Set();
const unique = v1.filter((r) => {
  if (r[1] === 'OPTIONS' || r[1] === 'REDIRECT') return false;
  const k = `${r[1]} ${r[2]}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

const matched = unique.filter((r) => docKeys.has(`${r[1]} ${r[2]}`));
const undocumented = unique.filter((r) => !docKeys.has(`${r[1]} ${r[2]}`));

console.log(`backend /api/v1 unique method+path: ${unique.length}`);
console.log(`documented (v1 + public + developers) operations: ${docKeys.size}`);
console.log(`backend routes matched by docs: ${matched.length}`);
console.log(`backend routes NOT documented: ${undocumented.length}`);

const byFile = {};
for (const r of undocumented) byFile[r[0]] = (byFile[r[0]] ?? 0) + 1;
console.log('undocumented by route file:', byFile);

const bySegment = {};
for (const r of undocumented) {
  const key = r[2].split('/').filter(Boolean).slice(0, 2).join('/');
  bySegment[key] = (bySegment[key] ?? 0) + 1;
}
console.log('--- undocumented by first two path segments (top 40) ---');
Object.entries(bySegment)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 40)
  .forEach(([k, v]) => console.log(String(v).padStart(4), k));

const backendKeys = new Set(unique.map((r) => `${r[1]} ${r[2]}`));
const stale = [...docKeys].filter((k) => !backendKeys.has(k));
console.log(`documented operations with no exact backend route (aliases or stale): ${stale.length}`);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, undocumented.map((r) => r.join('\t')).join('\n') + '\n');
console.log(`written ${outFile}`);
