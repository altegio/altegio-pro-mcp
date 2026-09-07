#!/usr/bin/env node
/**
 * Inventory of documented API operations in the OpenAPI spec repository.
 *
 * Reads every top-level spec (public, b2b-v1, b2b-v2, developers, b2b-v3),
 * resolves `$ref`-ed path files, and writes one row per operation:
 *   spec \t METHOD \t path \t operationId \t tags \t DEPRECATED? \t x-altegio-status
 *
 * Usage:
 *   node scripts/api-inventory/openapi-inventory.mjs [--docs ../biz.erp.api.docs] [--out .inventory/documented-ops.tsv]
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a, i, arr) => (a.startsWith('--') ? [a.slice(2), arr[i + 1]] : null))
    .filter(Boolean)
);
const docsRoot = path.resolve(args.docs ?? '../biz.erp.api.docs');
const outFile = path.resolve(args.out ?? '.inventory/documented-ops.tsv');

const SPECS = {
  public: 'docs/en/public/openapi.yaml',
  'b2b-v1': 'docs/en/b2b-v1/openapi.yaml',
  'b2b-v2': 'docs/en/b2b-v2/openapi.yaml',
  developers: 'docs/en/developers/openapi.yaml',
  'b2b-v3': 'docs/en/b2b-v3/openapi.yaml',
};
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

const rows = [];
for (const [name, rel] of Object.entries(SPECS)) {
  const file = path.join(docsRoot, rel);
  if (!fs.existsSync(file)) {
    console.error(`skip ${name}: ${file} not found`);
    continue;
  }
  const doc = yaml.load(fs.readFileSync(file, 'utf8'));
  let ops = 0;
  const tagCounts = new Map();
  for (const [p, item] of Object.entries(doc.paths ?? {})) {
    let pathItem = item;
    if (item && item.$ref) {
      const refFile = path.resolve(path.dirname(file), item.$ref);
      if (!fs.existsSync(refFile)) {
        console.error(`  missing ref for ${p}: ${item.$ref}`);
        continue;
      }
      pathItem = yaml.load(fs.readFileSync(refFile, 'utf8'));
    }
    for (const m of METHODS) {
      const op = pathItem?.[m];
      if (!op) continue;
      ops++;
      const tags = (op.tags ?? []).join('|');
      for (const t of op.tags ?? []) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      rows.push([
        name,
        m.toUpperCase(),
        p,
        op.operationId ?? '',
        tags,
        op.deprecated ? 'DEPRECATED' : '',
        op['x-altegio-status'] ?? '',
      ]);
    }
  }
  console.log(`${name.padEnd(12)} paths=${String(Object.keys(doc.paths ?? {}).length).padStart(4)}  ops=${String(ops).padStart(4)}`);
  if (name === 'b2b-v1') {
    console.log('  by tag:');
    [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([t, n]) => console.log(`    ${String(n).padStart(4)}  ${t}`));
  }
}
const deprecated = rows.filter((r) => r[5] === 'DEPRECATED').length;
console.log(`total ops=${rows.length}  deprecated=${deprecated}`);

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, rows.map((r) => r.join('\t')).join('\n') + '\n');
console.log(`written ${outFile}`);
