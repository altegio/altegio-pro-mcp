/**
 * What each HTTP view's `tools/list` may cost — ADR-001 D3.
 *
 * A host that does not defer tools pays a view's whole listing on every
 * connection, so the limit is on bytes, not on a tool count: one heavy schema
 * costs as much as five small tools. Each budget is the view's measured size
 * plus about 5 % headroom, rounded up to 500 bytes; `__tests__/listing-budget.test.ts` (run by
 * `npm test`) and `npm run surface:check` fail when a view grows past it, and
 * the generated `docs/architecture/tool-surface.md` prints every view's size,
 * so a reviewer sees what a surface change costs.
 *
 * Raising a budget is a reviewed decision in this file, never a side effect of
 * a new tool. When a view shrinks — a demotion, a trimmed schema — lower its
 * budget in the same change, so the headroom stays about 5 %.
 *
 * The sizes are for the default deployment: password login withheld,
 * onboarding on `/mcp`, the published public address. stdio's unfiltered view
 * has no budget; it is the complete surface by definition.
 */
import {
  ALL_TOOLS_FACET,
  DEFAULT_FACET,
  VIEW_KEYS,
  type FacetKey,
} from './facets.js';
import { orderedToolEntries, type ToolEntry } from './inventory.js';
import { listingBytes, listView } from './listing.js';

/** A view with an HTTP address: every view except stdio's unfiltered one. */
export type HttpViewKey = Exclude<FacetKey, typeof ALL_TOOLS_FACET>;

/**
 * Where `/mcp` is headed: about 25k tokens, which a host that loads the whole
 * list (ChatGPT, Codex) can afford next to a conversation. Reached by moving
 * rarely used packs to their facet and trimming the heaviest schemas — not by
 * raising the budget. Not enforced; the budget below is.
 */
export const DEFAULT_VIEW_TARGET_BYTES = 100_000;

/** Bytes of `tools/list` result per view; see the module comment. */
export const LISTING_BUDGETS: Readonly<Record<HttpViewKey, number>> = {
  // 147,705 bytes, 121 tools on 2026-10-20, after back-office finance joined.
  // Target: DEFAULT_VIEW_TARGET_BYTES.
  [DEFAULT_FACET]: 155_500,
  readonly: 126_000, // 119,808 bytes, 84 tools on 2026-10-20
  ops: 78_000, // 73,816 bytes, 53 tools
  catalog: 28_000, // 26,622 bytes, 34 tools
  finance: 105_500, // 100,470 bytes, 57 tools
  marketing: 25_500, // 24,235 bytes, 17 tools
  analytics: 67_500, // 63,825 bytes, 33 tools
  onboarding: 13_500, // 12,463 bytes, 15 tools
};

export interface ViewSize {
  readonly view: FacetKey;
  readonly tools: number;
  /** UTF-8 bytes of the serialized `tools/list` result. */
  readonly bytes: number;
  /** Undefined for stdio's unfiltered view. */
  readonly budget?: number;
}

/** Every view's listing size in the default deployment, in `VIEW_KEYS` order. */
export function viewSizes(
  entries: readonly ToolEntry[] = orderedToolEntries()
): ViewSize[] {
  return VIEW_KEYS.map((view) => {
    const { tools } = listView(view, {}, entries);
    return {
      view,
      tools: tools.length,
      bytes: listingBytes(tools),
      ...(view === ALL_TOOLS_FACET
        ? {}
        : { budget: LISTING_BUDGETS[view as HttpViewKey] }),
    };
  });
}

/** One line per view over its budget; empty when every view fits. */
export function budgetViolations(sizes: readonly ViewSize[]): string[] {
  return sizes
    .filter((size) => size.budget !== undefined && size.bytes > size.budget)
    .map(
      (size) =>
        `${size.view}: tools/list is ${size.bytes} bytes, over its budget of ${size.budget} ` +
        `(${size.bytes - size.budget!} bytes over). Move a rarely used tool to its facet or ` +
        'trim a schema; raise the budget in src/tools/listing-budget.ts only as a reviewed decision.'
    );
}
