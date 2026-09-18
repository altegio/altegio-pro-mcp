/**
 * **The surface table: one place that answers "why is tool X on address Y".**
 *
 * Six mechanisms decide where a tool appears, and two more decide whether the
 * call it receives there actually runs. Each was introduced for its own reason
 * and each of those reasons is still good, so this module does not collapse
 * them — it *joins* them. For every tool × every view it produces one cell:
 * served or withheld, the machine-readable reason, and the gates that can
 * still refuse the call.
 *
 * | Mechanism | Lives in | Question it answers |
 * |---|---|---|
 * | `DISABLED_TOOL_NAMES` | `./disabled-tools.ts` | Does this tool work at all? |
 * | `DEFAULT_FACET_EXCLUDED_PREFIXES` | `./facets.ts` | Does this pack fit in `/mcp`'s budget? |
 * | `DEFAULT_FACET_EXCLUDED_TOOLS` | `./facets.ts` | May a generic agent hold this right? |
 * | `DEFAULT_FACET_EXTRA_TOOLS` | `./facets.ts` | Does a session need this entry point? |
 * | `PASSWORD_LOGIN_TOOLS` + the switch | `./facets.ts` | Does this deployment ever need a password? |
 * | `READONLY_VIEW` + `readOnlyHint` | `./facets.ts` | May this agent change anything? |
 * | `TOOL_SCOPES` | `./scopes.ts` | Does the caller's token authorise this? |
 * | `confirm` on the definition | `./confirmation.ts` | Has a human approved this? |
 *
 * Nothing here is a second implementation of any of them: membership comes
 * from `decideView`, the only membership function in the server, and the gates
 * are read off the same declarations the `tools/call` handler enforces. The
 * table is therefore a *view* of the running configuration, and
 * `__tests__/surface.test.ts` plus the generated
 * `docs/architecture/tool-surface.md` make every change to it visible in a
 * reviewer's diff — which is what ADR-001 D4 and D7 ask of `tools/list`.
 */
import {
  decideView,
  READONLY_VIEW,
  VIEW_KEYS,
  type FacetIndexOptions,
  type FacetKey,
  type ViewAdmitReason,
  type ViewWithholdReason,
} from './facets.js';
import { allToolEntries, type ToolInventoryEntry } from './inventory.js';
import type { ToolScope } from './scopes.js';

/**
 * Tools whose handler refuses part of its own input regardless of the view.
 *
 * `altegio_call_operation` reaches the whole catalog under one tool name and
 * performs documented GETs only; any other method is refused with a pointer to
 * the curated tool (ADR-001 D2, and §8 open decision 5, answered: the executor
 * stays read-only). It is listed here because a reader asking "what can still
 * refuse this call" deserves the same answer for a tool-internal policy as for
 * a server-wide gate.
 */
const EXECUTOR_READ_ONLY_TOOLS: readonly string[] = ['altegio_call_operation'];

// ==========================================================================
// The cell
// ==========================================================================

/** Why a tool is served nowhere at all — the one reason no view can override. */
export type SurfaceDisabledReason = 'disabled-everywhere';

export type SurfaceReason =
  ViewAdmitReason | ViewWithholdReason | SurfaceDisabledReason;

/** Which refusal a caller reads for a tool a view does not serve. */
export type SurfaceRefusal =
  'unknown-tool' | 'out-of-view' | 'read-only-view-refusal';

/**
 * What still refuses a call at this address. Listed in the order
 * `registry.ts` checks them, so the cell reads as the call path.
 */
export type SurfaceGate =
  | {
      /** The tool is not on this view; the call never reaches a handler. */
      readonly kind: 'not-served';
      readonly refusal: SurfaceRefusal;
    }
  | {
      /** The caller's token must carry these (`./scopes.ts`). */
      readonly kind: 'scope';
      readonly scopes: readonly ToolScope[];
    }
  | {
      /** A human approves it first, by elicitation or a bound token. */
      readonly kind: 'human-confirmation';
    }
  | {
      /** The handler itself performs reads only (`./executor/call.ts`). */
      readonly kind: 'executor-read-only';
    };

export interface SurfaceCell {
  readonly tool: string;
  readonly view: FacetKey;
  readonly served: boolean;
  readonly reason: SurfaceReason;
  readonly gates: readonly SurfaceGate[];
}

export interface SurfaceTable {
  /** Views in render order: `all`, `default`, `readonly`, then the facets. */
  readonly views: readonly FacetKey[];
  /** Every defined tool, `tools/list` order, disabled ones included. */
  readonly tools: readonly ToolInventoryEntry[];
  /** Every cell, tool-major then view order. */
  readonly cells: readonly SurfaceCell[];
  cell(tool: string, view: FacetKey): SurfaceCell | undefined;
  /** The one row that answers "where does this tool live, and why". */
  forTool(tool: string): readonly SurfaceCell[];
  /** The one column that answers "what does this address serve, and why". */
  forView(view: FacetKey): readonly SurfaceCell[];
  /** Tool names served on a view — the same list `buildFacetIndex` produces. */
  servedOn(view: FacetKey): readonly string[];
}

/**
 * The refusal a caller reads for a tool this view does not serve.
 *
 * A disabled tool is not registered at all, so the handler lookup in
 * `registry.ts` fails before the view check and the caller gets
 * `Unknown tool: …`. Everything else is registered and hits the view check:
 * the read-only address answers with its own policy message, every other view
 * with the out-of-facet error that names the paths which do serve it.
 */
function refusalFor(view: FacetKey, disabled: boolean): SurfaceRefusal {
  if (disabled) return 'unknown-tool';
  return view === READONLY_VIEW ? 'read-only-view-refusal' : 'out-of-view';
}

function gatesFor(
  entry: ToolInventoryEntry,
  view: FacetKey,
  served: boolean
): SurfaceGate[] {
  if (!served) {
    return [{ kind: 'not-served', refusal: refusalFor(view, entry.disabled) }];
  }
  const gates: SurfaceGate[] = [];
  if (entry.requiredScopes.length > 0) {
    gates.push({ kind: 'scope', scopes: entry.requiredScopes });
  }
  if (entry.requiresConfirmation) gates.push({ kind: 'human-confirmation' });
  if (EXECUTOR_READ_ONLY_TOOLS.includes(entry.name)) {
    gates.push({ kind: 'executor-read-only' });
  }
  return gates;
}

/**
 * Build the whole table for one deployment configuration.
 *
 * `options` are the same switches `buildFacetIndex` takes, so a deployment can
 * render the table it actually serves. The defaults describe the public HTTP
 * deployment: password login off, onboarding on `/mcp`.
 */
export function buildSurfaceTable(
  entries: readonly ToolInventoryEntry[] = allToolEntries(),
  options: FacetIndexOptions = {}
): SurfaceTable {
  const cells: SurfaceCell[] = [];
  for (const entry of entries) {
    for (const view of VIEW_KEYS) {
      // A disabled tool never reaches the registry, so no view can serve it —
      // this is the one exclusion that outranks `decideView` entirely.
      const decision = entry.disabled
        ? ({ served: false, reason: 'disabled-everywhere' } as const)
        : decideView(view, entry, options);
      cells.push({
        tool: entry.name,
        view,
        served: decision.served,
        reason: decision.reason,
        gates: gatesFor(entry, view, decision.served),
      });
    }
  }

  const byTool = new Map<string, Map<FacetKey, SurfaceCell>>();
  for (const cell of cells) {
    const row = byTool.get(cell.tool) ?? new Map<FacetKey, SurfaceCell>();
    row.set(cell.view, cell);
    byTool.set(cell.tool, row);
  }

  return {
    views: VIEW_KEYS,
    tools: entries,
    cells,
    cell: (tool, view) => byTool.get(tool)?.get(view),
    forTool: (tool) => [...(byTool.get(tool)?.values() ?? [])],
    forView: (view) => cells.filter((cell) => cell.view === view),
    servedOn: (view) =>
      cells
        .filter((cell) => cell.view === view && cell.served)
        .map((cell) => cell.tool),
  };
}

// ==========================================================================
// Counts — the numbers the documentation is allowed to state
// ==========================================================================

export interface ToolCounts {
  /** Tools this build defines, disabled ones included. */
  readonly defined: number;
  /** Tools withheld from every view (`./disabled-tools.ts`). */
  readonly disabled: number;
  /** Tools a view can serve: `defined - disabled`. */
  readonly served: number;
  /** Tools defined in `src/tools/definitions/*.tools.ts`. */
  readonly factoryDefined: number;
  /** Hand-written onboarding specs in `./onboarding-registry.ts`. */
  readonly onboardingDefined: number;
  /** Served tools per category, in `tools/list` order. */
  readonly byCategory: ReadonlyMap<string, number>;
}

/** The category the hand-written onboarding specs share. */
const ONBOARDING_CATEGORY = 'Onboarding';

/**
 * The tool counts, computed. Every number the README, CLAUDE.md and the
 * generated surface doc state comes from here, and
 * `__tests__/tool-count.test.ts` fails the build when a document disagrees —
 * a hand-maintained count is wrong again within a month.
 */
export function toolCounts(
  entries: readonly ToolInventoryEntry[] = allToolEntries()
): ToolCounts {
  const served = entries.filter((entry) => !entry.disabled);
  const byCategory = new Map<string, number>();
  for (const entry of served) {
    byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1);
  }
  const onboardingDefined = entries.filter(
    (entry) => entry.category === ONBOARDING_CATEGORY
  ).length;
  return {
    defined: entries.length,
    disabled: entries.length - served.length,
    served: served.length,
    factoryDefined: entries.length - onboardingDefined,
    onboardingDefined,
    byCategory,
  };
}

/**
 * The one sentence the documentation is allowed to state about tool counts.
 *
 * README.md, CLAUDE.md and the generated surface doc all carry this literal
 * string, and `__tests__/tool-count.test.ts` fails the build when one of them
 * does not — which is the only way a hand-written "69 tools" stays honest.
 */
export function toolCountSentence(counts: ToolCounts = toolCounts()): string {
  return `${counts.served} tools served (${counts.defined} defined, ${counts.disabled} withheld from every view)`;
}
