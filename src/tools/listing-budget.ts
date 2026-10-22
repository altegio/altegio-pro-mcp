/**
 * What each HTTP view's `tools/list` may cost — ADR-001 D3.
 *
 * A host that does not defer tools pays a view's whole listing on every
 * connection, so the limit is on bytes, not on a tool count: one heavy schema
 * costs as much as five small tools. Each budget is the view's measured size
 * plus about 5 % headroom, rounded up to 500 bytes.
 * `__tests__/listing-budget.test.ts` (run by `npm test`) and
 * `npm run surface:check` fail when a view grows past it, and the generated
 * `docs/architecture/tool-surface.md` prints every view's size, so a reviewer
 * sees what a surface change costs.
 *
 * Raising a budget is a reviewed decision in this file, never a side effect of
 * a new tool. When a view shrinks — a demotion, a trimmed schema — lower its
 * budget in the same change, so the headroom stays about 5 %.
 *
 * The sizes are for the default deployment: password login withheld, the
 * compact listing on `/mcp`, the published public address. stdio's unfiltered
 * view has no budget; it is the complete surface by definition.
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
 * Where `/mcp` was headed: about 25k tokens, which a host that loads the whole
 * list (ChatGPT) can afford next to a conversation. Met on 2026-10-21, when
 * `/mcp` adopted the compact listing (ADR-001 D3, step 3); kept as the line
 * the default view must stay under. Not enforced; the budget below is.
 */
export const DEFAULT_VIEW_TARGET_BYTES = 100_000;

/** Bytes of `tools/list` result per view; see the module comment. */
export const LISTING_BUDGETS: Readonly<Record<HttpViewKey, number>> = {
  // 50,528 bytes, 37 tools on 2026-10-21: the compact listing, which `/mcp`
  // serves by default (`MCP_DEFAULT_VIEW`); 121,576 bytes and 96 tools before.
  [DEFAULT_FACET]: 53_500,
  // Today's flat list, kept for gateways: 121,576 bytes, 96 tools on
  // 2026-10-21, after six low-use groups moved to their facets
  // (DEFAULT_FACET_DEMOTED_GROUPS) and the listing trims; 148,042 bytes on
  // `/mcp` before those. 126,111 and 101 on 2026-10-22, with the Salon AI
  // writes (positions, service categories) and no headroom left.
  full: 132_500,
  readonly: 123_000, // 116,761 bytes, 84 tools on 2026-10-20
  // The same listing as `/mcp`: 50,528 bytes, 37 tools on 2026-10-21, with ten
  // more tools and `tools_call_destructive`; 36,194 and 26 before. Reaches 155.
  compact: 53_500,
  ops: 74_500, // 71,074 bytes, 53 tools
  // 25,511 bytes, 34 tools; 28,061 and 37 with position and service category
  // updates on 2026-10-21; 28,721 and 38 with service_categories_create.
  catalog: 30_000,
  // 99,943 bytes, 58 tools; 109,499 and 65 with the product catalog (products
  // and categories) on 2026-10-21; 114,188 and 67 with editing and
  // paying inventory documents the same day.
  finance: 118_000,
  marketing: 24_000, // 22,856 bytes, 17 tools
  analytics: 66_000, // 62,445 bytes, 33 tools
  onboarding: 13_500, // 12,387 bytes, 15 tools
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
