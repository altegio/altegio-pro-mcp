/**
 * Playbook cross-check — the reasoning layer must point only at tools that exist.
 *
 * A weak model follows the playbook literally, so a tool name typed wrong in a
 * diagnostic step or a routing row sends it to a dead end. This test extracts
 * every `analytics_*` token the playbook mentions and asserts it is a real tool
 * name, and checks the rendered resource carries each section.
 */
import * as definitions from '../../../tools/definitions/index.js';
import type { DefinedTool } from '../../../tools/factory.js';
import {
  DIAGNOSTIC_PLAYS,
  METRIC_RELATIONSHIPS,
  QUESTION_ROUTES,
  SLICING_NOTES,
  ANALYSIS_NOTES,
  BENCHMARKS,
} from '../playbook.js';
import { renderPlaybook } from '../../../resources/analytics.resources.js';

const analyticsToolNames = new Set(
  (Object.values(definitions) as unknown[])
    .filter(
      (value): value is DefinedTool =>
        !!value &&
        typeof value === 'object' &&
        'toMcpTool' in value &&
        'meta' in value
    )
    .map((tool) => tool.meta.name)
    .filter((name) => name.startsWith('analytics_'))
);

/** Every `analytics_<verb>` token mentioned anywhere in the playbook data. */
function referencedTools(): string[] {
  const haystack = [
    ...QUESTION_ROUTES.map((route) => route.tool),
    ...DIAGNOSTIC_PLAYS.flatMap((play) => play.steps),
    ...SLICING_NOTES.map((note) => note.how),
  ].join('\n');
  return [...haystack.matchAll(/analytics_[a-z_]+/g)].map((match) => match[0]);
}

describe('analytics playbook', () => {
  it('references only tools that exist', () => {
    const unknown = referencedTools().filter(
      (name) => !analyticsToolNames.has(name)
    );
    expect(unknown).toEqual([]);
  });

  it('routes every common question to an analytics tool', () => {
    for (const route of QUESTION_ROUTES) {
      expect(route.tool).toMatch(/^analytics_[a-z_]+/);
    }
  });

  it('carries content for every section', () => {
    expect(METRIC_RELATIONSHIPS.length).toBeGreaterThanOrEqual(5);
    expect(DIAGNOSTIC_PLAYS.length).toBeGreaterThanOrEqual(5);
    expect(ANALYSIS_NOTES.length).toBeGreaterThanOrEqual(3);
    expect(BENCHMARKS.length).toBeGreaterThanOrEqual(3);
  });

  it('frames benchmarks as a spread, not a target', () => {
    const text = renderPlaybook();
    expect(text).toContain('Benchmarks (observed spread, not targets)');
    // Each benchmark must tell the model how to read it, not just the number.
    for (const benchmark of BENCHMARKS) {
      expect(benchmark.read.length).toBeGreaterThan(20);
    }
  });

  it('renders each section into the resource', () => {
    const text = renderPlaybook();
    expect(text).toContain('How the metrics relate');
    expect(text).toContain('Which tool answers which question');
    expect(text).toContain('Diagnostic plays');
    expect(text).toContain('What you can slice by');
    expect(text).toContain('Analysis technique');
    // A decomposition identity a weak model can lean on.
    expect(text).toContain('revenue_total');
  });
});
