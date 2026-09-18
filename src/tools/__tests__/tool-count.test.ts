/**
 * Documentation counts are computed, not remembered.
 *
 * CLAUDE.md claimed "69 total" for months while 72 tools were defined and 66
 * served; every session that read it started from a wrong number. A count a
 * human maintains is wrong again within a month, so these tests fail the build
 * the moment a document and the code disagree — the same posture as the
 * generated surface table (`./surface-doc.test.ts`).
 */
import { describe, it, expect } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { allToolEntries } from '../inventory.js';
import { toolCounts, toolCountSentence } from '../surface.js';
import { SURFACE_DOC_PATH } from '../surface-doc.js';

// `import.meta` is unavailable here — ts-jest transforms with module=CommonJS
// (see jest.config.js) — so the repository root comes from the working
// directory, which is where `npm test` and `npm run surface:build` both run.
const read = (name: string): string =>
  readFileSync(resolve(process.cwd(), name), 'utf8');

const README = read('README.md');
const CLAUDE_MD = read('CLAUDE.md');
const SURFACE_DOC = read(SURFACE_DOC_PATH);

const counts = toolCounts(allToolEntries());
const sentence = toolCountSentence(counts);
const inCategory = (category: string): number =>
  counts.byCategory.get(category) ?? 0;

describe('the totals the documents state', () => {
  it.each([
    ['README.md', README],
    ['CLAUDE.md', CLAUDE_MD],
    [SURFACE_DOC_PATH, SURFACE_DOC],
  ])('%s quotes the computed sentence verbatim', (_name, text) => {
    expect(text).toContain(sentence);
  });

  it('states a total that is actually reachable', () => {
    expect(counts.served).toBeGreaterThan(0);
    expect(counts.served).toBe(counts.defined - counts.disabled);
  });

  it('names the number of tools the report-builder closure withholds', () => {
    expect(CLAUDE_MD).toContain(`The ${counts.disabled} report-builder tools`);
  });
});

/**
 * CLAUDE.md lists the surface as `**[Tag] Label (N):** …`, one line per tool
 * category, and those `[Tag]` prefixes are the categories themselves — they
 * are what orders `tools/list`. So the list can be checked whole: no category
 * missing, none invented, every count right.
 */
describe('the per-category counts in CLAUDE.md', () => {
  const declared = new Map<string, number>(
    [...CLAUDE_MD.matchAll(/^\*\*\[(\w+)\][^(]*\((\d+)\)/gm)].map((match) => [
      match[1]!,
      Number(match[2]),
    ])
  );

  it('lists every category the server serves, and no others', () => {
    expect([...declared.keys()].sort()).toEqual(
      [...counts.byCategory.keys()].sort()
    );
  });

  it.each([...counts.byCategory])('counts %s correctly', (category, count) => {
    expect(declared.get(category)).toBe(count);
  });

  it('adds up to the served total', () => {
    expect([...declared.values()].reduce((a, b) => a + b, 0)).toBe(
      counts.served
    );
  });
});

describe('the pack sizes README advertises', () => {
  it('sizes the analytics pack, the API explorer and the wizard', () => {
    expect(README).toContain(`${inCategory('Analytics')}-tool analytics pack`);
    expect(README).toContain(`${inCategory('API')}-tool API explorer`);
    expect(README).toContain(
      `${inCategory('Onboarding')} onboarding wizard tools`
    );
  });
});
