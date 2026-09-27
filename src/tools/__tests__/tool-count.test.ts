import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { allToolEntries } from '../inventory.js';
import { toolCounts, toolCountSentence } from '../surface.js';
import { SURFACE_DOC_PATH } from '../surface-doc.js';

describe('published tool inventory', () => {
  const counts = toolCounts(allToolEntries());
  it.each(['README.md', SURFACE_DOC_PATH])(
    '%s states the generated totals',
    (name) => {
      expect(readFileSync(resolve(process.cwd(), name), 'utf8')).toContain(
        toolCountSentence(counts)
      );
    }
  );
  it('counts only reachable tools', () => {
    expect(counts.served).toBeGreaterThan(0);
    expect(counts.served).toBe(counts.defined - counts.disabled);
  });
});
