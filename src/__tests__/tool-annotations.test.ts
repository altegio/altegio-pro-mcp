import { describe, it, expect } from '@jest/globals';
import * as definitions from '../tools/definitions/index.js';
import { onboardingTools } from '../tools/onboarding-registry.js';
import type {
  DefinedTool,
  McpToolSpec,
  ToolAnnotations,
} from '../tools/factory.js';

/**
 * Annotation hygiene over the whole tool surface.
 *
 * MCP annotations are a UX layer — the spec forbids a client from treating them
 * as a security boundary — but they decide how loudly a host interrupts the
 * person on the other side. `destructiveHint` defaults to `true` for every tool
 * that is not `readOnlyHint: true`, so a write tool that simply omits it is
 * advertised as destructive: creating an appointment then looks exactly as
 * alarming as deleting a staff member, and the person stops reading the
 * prompts. This test makes the default unreachable — a new domain pack has to
 * state what its writes do.
 *
 * Every defined tool is checked, including the ones withheld from every view by
 * `disabled-tools.ts`, so a tool that is switched back on cannot slip in on a
 * silent default.
 */

/** Every tool this repo defines: the factory barrel plus the onboarding wizard. */
function allToolSpecs(): McpToolSpec[] {
  const defined = (Object.values(definitions) as unknown[])
    .filter(
      (value): value is DefinedTool =>
        !!value &&
        typeof value === 'object' &&
        'toMcpTool' in value &&
        'createHandler' in value &&
        'meta' in value
    )
    .map((tool) => tool.toMcpTool());
  return [...defined, ...onboardingTools];
}

const specs = allToolSpecs();
const annotationsOf = (spec: McpToolSpec): ToolAnnotations =>
  spec.annotations ?? {};
const isReadOnly = (spec: McpToolSpec): boolean =>
  annotationsOf(spec).readOnlyHint === true;

describe('tool annotations', () => {
  it('defines at least the tool surface this server ships', () => {
    expect(specs.length).toBeGreaterThan(60);
  });

  it('gives every tool an annotations block', () => {
    const missing = specs
      .filter((spec) => spec.annotations === undefined)
      .map((spec) => spec.name);
    expect(missing).toEqual([]);
  });

  it('states destructiveHint explicitly on every tool that is not read-only', () => {
    const silent = specs
      .filter((spec) => !isReadOnly(spec))
      .filter(
        (spec) => typeof annotationsOf(spec).destructiveHint !== 'boolean'
      )
      .map((spec) => spec.name);
    expect(silent).toEqual([]);
  });

  it('marks deletions and unlinks destructive', () => {
    const shouldBeDestructive = specs
      .map((spec) => spec.name)
      .filter(
        (name) =>
          name.startsWith('delete_') ||
          name.startsWith('unlink_') ||
          name.startsWith('remove_') ||
          name.endsWith('_delete') ||
          name === 'onboarding_rollback_phase' ||
          name === 'analytics_delete_assistant_report'
      );
    expect(shouldBeDestructive.length).toBeGreaterThan(0);

    const notMarked = shouldBeDestructive.filter((name) => {
      const spec = specs.find((candidate) => candidate.name === name);
      return annotationsOf(spec as McpToolSpec).destructiveHint !== true;
    });
    expect(notMarked).toEqual([]);
  });

  it('keeps creates, updates and links non-destructive', () => {
    const safeWrites = specs.filter(
      (spec) =>
        !isReadOnly(spec) &&
        (spec.name.startsWith('create_') ||
          spec.name.startsWith('update_') ||
          spec.name.startsWith('link_') ||
          spec.name.startsWith('onboarding_add_') ||
          spec.name === 'onboarding_import_clients' ||
          spec.name === 'onboarding_create_test_appointments' ||
          spec.name === 'onboarding_set_schedules')
    );
    expect(safeWrites.length).toBeGreaterThan(0);

    const wronglyDestructive = safeWrites
      .filter((spec) => annotationsOf(spec).destructiveHint !== false)
      .map((spec) => spec.name);
    expect(wronglyDestructive).toEqual([]);
  });

  it('never claims a read-only tool is destructive', () => {
    const contradictory = specs
      .filter(isReadOnly)
      .filter((spec) => annotationsOf(spec).destructiveHint === true)
      .map((spec) => spec.name);
    expect(contradictory).toEqual([]);
  });
});
