/**
 * Regenerate `docs/architecture/tool-surface.md` from the tool surface.
 *
 * Run it after anything that changes where a tool is served or what its
 * listing costs: a new tool, a description or schema, a facet rule, a
 * disabled-tools entry, a scope map entry or a confirmation.
 * `npm run surface:build` writes the file; `npm run surface:check` (and the
 * test suite) fails when the committed copy is stale or when a view's
 * `tools/list` is over its byte budget (`src/tools/listing-budget.ts`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { budgetViolations, viewSizes } from '../../src/tools/listing-budget.js';
import {
  renderSurfaceDoc,
  SURFACE_DOC_PATH,
} from '../../src/tools/surface-doc.js';

const target = resolve(process.cwd(), SURFACE_DOC_PATH);
const rendered = renderSurfaceDoc();
const check = process.argv.includes('--check');

const overBudget = budgetViolations(viewSizes());
if (overBudget.length > 0) {
  console.error(overBudget.join('\n'));
  if (check) process.exit(1);
}

if (check) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    console.error(`${SURFACE_DOC_PATH} is missing. Run: npm run surface:build`);
    process.exit(1);
  }
  if (current !== rendered) {
    console.error(
      `${SURFACE_DOC_PATH} is out of date with the tool surface. Run: npm run surface:build`
    );
    process.exit(1);
  }
  console.log(`${SURFACE_DOC_PATH} is up to date.`);
} else {
  writeFileSync(target, rendered);
  console.log(`Wrote ${SURFACE_DOC_PATH}`);
}
