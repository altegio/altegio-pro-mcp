/**
 * The committed `docs/architecture/tool-surface.md` is the snapshot of the
 * tool surface: one file a reviewer reads in the diff to see that a PR moved a
 * tool from one address to another, or changed what refuses a call.
 *
 * It is generated, so the only thing to test is that it is not stale — the
 * same contract `src/generated/catalog.json` has (ADR-001 D4).
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderSurfaceDoc, SURFACE_DOC_PATH } from '../surface-doc.js';
import { buildSurfaceTable } from '../surface.js';

// `import.meta` is unavailable here — ts-jest transforms with module=CommonJS
// (see jest.config.js) — so the repository root comes from the working
// directory, which is where `npm test` and `npm run surface:build` both run.
const committed = readFileSync(
  resolve(process.cwd(), SURFACE_DOC_PATH),
  'utf8'
);

describe('the generated surface document', () => {
  it('matches the surface the code serves', () => {
    expect(committed).toBe(renderSurfaceDoc());
  });

  it('renders again identically (no timestamps, no set iteration order)', () => {
    expect(renderSurfaceDoc()).toBe(renderSurfaceDoc());
  });

  it('names every tool and every view', () => {
    const surface = buildSurfaceTable();
    for (const entry of surface.tools) {
      expect(committed).toContain(`\`${entry.name}\``);
    }
    for (const view of surface.views) {
      expect(committed).toContain(`\`${view}\``);
    }
  });

  it('says it is generated, so nobody edits it by hand', () => {
    expect(committed).toContain('npm run surface:build');
    expect(committed).toContain('Do not edit by hand');
  });
});
