/**
 * The inventory: every tool this build defines, with the facts that decide
 * where it is served and what refuses it when it is called.
 *
 * This module knows nothing about views. It is the one place that enumerates
 * the tool surface — factory definitions discovered from the definitions
 * barrel plus the hand-written onboarding specs — so that `./registry.ts`
 * (what the server serves) and `./surface.ts` (the table that explains it)
 * cannot disagree about what exists.
 *
 * It deliberately includes tools withheld from every view (see
 * `./disabled-tools.ts`): "why is this tool nowhere?" is exactly the question
 * the surface table has to answer, and it cannot answer it about a tool the
 * inventory has already dropped. `orderedToolEntries()` is the filtered view
 * the registry consumes.
 */
import * as definitions from './definitions/index.js';
import { isToolDisabled } from './disabled-tools.js';
import type { DefinedTool, McpToolSpec } from './factory.js';
import {
  onboardingConfirmations,
  onboardingTools,
} from './onboarding-registry.js';
import { requiredScopesFor, type ToolScope } from './scopes.js';

/** A tool spec plus the category that orders it in `tools/list`. */
export interface ToolEntry {
  readonly spec: McpToolSpec;
  readonly category: string;
}

/** One tool with everything the surface table needs to explain it. */
export interface ToolInventoryEntry extends ToolEntry {
  readonly name: string;
  /** `annotations.readOnlyHint === true`, and nothing else (fail-closed). */
  readonly readOnly: boolean;
  /** `annotations.destructiveHint === true` — a hint, never a boundary. */
  readonly destructive: boolean;
  /** Withheld from every view, stdio included (`./disabled-tools.ts`). */
  readonly disabled: boolean;
  /** Scopes the caller's token must carry to execute it (`./scopes.ts`). */
  readonly requiredScopes: readonly ToolScope[];
  /** Stops until a human approves it (`./confirmation.ts`). */
  readonly requiresConfirmation: boolean;
}

/**
 * Auto-discover every `DefinedTool` exported from the definitions barrel,
 * disabled ones included.
 */
function collectDefinedTools(): DefinedTool[] {
  return (Object.values(definitions) as unknown[]).filter(
    (v): v is DefinedTool =>
      !!v &&
      typeof v === 'object' &&
      'toMcpTool' in v &&
      'createHandler' in v &&
      'meta' in v
  );
}

/** The factory-defined tools the registry serves, minus the disabled ones. */
export function servedDefinedTools(): DefinedTool[] {
  return collectDefinedTools().filter(
    (tool) => !isToolDisabled(tool.meta.name)
  );
}

/**
 * Total order over tools: category first, then name — both compared as plain
 * code-unit strings so the result never depends on the host's locale. A
 * deterministic `tools/list` is required by MCP 2026-07-28 (ADR-001 D7) and
 * makes tool-surface changes readable in a diff.
 */
function compareToolEntries(a: ToolEntry, b: ToolEntry): number {
  if (a.category !== b.category) {
    return a.category < b.category ? -1 : 1;
  }
  if (a.spec.name !== b.spec.name) {
    return a.spec.name < b.spec.name ? -1 : 1;
  }
  return 0;
}

/** Every defined tool, disabled ones included, in `tools/list` order. */
export function allToolEntries(): ToolInventoryEntry[] {
  const factoryEntries = collectDefinedTools().map((tool) => ({
    spec: tool.toMcpTool(),
    category: tool.meta.category,
    name: tool.meta.name,
    requiresConfirmation: tool.prepareConfirmation !== undefined,
  }));
  // The onboarding wizard keeps hand-written specs; they all share one
  // category, and declare their confirmations in a map beside them.
  const onboardingEntries = onboardingTools.map((spec) => ({
    spec,
    category: 'Onboarding',
    name: spec.name,
    requiresConfirmation: spec.name in onboardingConfirmations,
  }));

  return [...factoryEntries, ...onboardingEntries]
    .sort(compareToolEntries)
    .map((entry) => ({
      ...entry,
      readOnly: entry.spec.annotations?.readOnlyHint === true,
      destructive: entry.spec.annotations?.destructiveHint === true,
      disabled: isToolDisabled(entry.name),
      requiredScopes: requiredScopesFor(entry.name),
    }));
}

/** The ordered tool list exactly as `tools/list` returns it on the `all` view. */
export function orderedToolEntries(): ToolEntry[] {
  return allToolEntries()
    .filter((entry) => !entry.disabled)
    .map((entry) => ({ spec: entry.spec, category: entry.category }));
}
