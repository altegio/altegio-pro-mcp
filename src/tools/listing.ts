/**
 * A view's `tools/list` exactly as the server serves it.
 *
 * The registry answers `tools/list` with the result of `listView`, and the
 * byte budget (`./listing-budget.ts`) and the generated surface document
 * measure the same result, so the size a reviewer reads is the size a host
 * pays on every connection. Nothing here depends on a connection: the list is
 * fixed per view and deployment (ADR-001 D7).
 */
import { DEFAULT_PUBLIC_BASE_URL } from '../config/schema.js';
import {
  buildFacetIndex,
  facetToolsFromSpecs,
  viewUrl,
  DEFAULT_FACET,
  type FacetIndex,
  type FacetIndexOptions,
  type FacetKey,
} from './facets.js';
import type { McpToolSpec } from './factory.js';
import { orderedToolEntries, type ToolEntry } from './inventory.js';
import { listedOnView, type ServingView } from './serving-view.js';

export interface ViewListingOptions extends FacetIndexOptions {
  /**
   * Public address of the complete surface. Descriptions that name a tool the
   * view does not serve say where it is served, as an absolute address, so the
   * listing depends on it. Defaults to the published public endpoint.
   */
  readonly publicBaseUrl?: string;
}

/** A tool as one view lists it (`listedOnView`). */
export type ListedTool = Omit<McpToolSpec, 'outputSchema'>;

export interface ViewListing {
  readonly view: FacetKey;
  /** Membership of every view, for refusals that name another address. */
  readonly facetIndex: FacetIndex;
  /** What a reply or a description may name as callable on this view. */
  readonly servingView: ServingView;
  /** The `tools/list` result's `tools`, in registry order. */
  readonly tools: readonly ListedTool[];
}

/**
 * Absolute addresses of this endpoint's views that serve a tool the current
 * view does not: the named facets first, then the complete surface. Absolute,
 * because a relative /mcp/<view> is wrong on the short customer address, where
 * /pro/mcp/… is the internal lane.
 */
export function addressesServing(
  name: string,
  index: FacetIndex,
  publicBaseUrl: string
): string[] {
  return [
    ...index.facetsProviding(name).map((f) => viewUrl(publicBaseUrl, f)),
    // Only offer the complete surface when it actually serves the tool: a tool
    // withheld from the default view (access management, password login) must
    // not be advertised back to the caller as available one path up.
    ...(index.includes(DEFAULT_FACET, name)
      ? [viewUrl(publicBaseUrl, DEFAULT_FACET)]
      : []),
  ];
}

/** The listing of one view, from the served tools in `tools/list` order. */
export function listView(
  view: FacetKey,
  options: ViewListingOptions = {},
  entries: readonly ToolEntry[] = orderedToolEntries()
): ViewListing {
  const publicBaseUrl = options.publicBaseUrl ?? DEFAULT_PUBLIC_BASE_URL;
  const facetIndex = buildFacetIndex(
    facetToolsFromSpecs(entries.map((entry) => entry.spec)),
    {
      excludeOnboardingFromDefault: options.excludeOnboardingFromDefault,
      exposePasswordLogin: options.exposePasswordLogin,
    }
  );
  const visible = new Set(facetIndex.members(view));
  const servingView: ServingView = {
    serves: (name) => visible.has(name),
    addressesServing: (name) =>
      addressesServing(name, facetIndex, publicBaseUrl),
  };
  const toolNames = entries.map((entry) => entry.spec.name);
  const tools = entries
    .filter((entry) => visible.has(entry.spec.name))
    .map((entry) => listedOnView(entry.spec, servingView, toolNames));
  return { view, facetIndex, servingView, tools };
}

/**
 * What a host receives for `tools/list`: the UTF-8 length of the serialized
 * result, `{"tools":[…]}`. The JSON-RPC envelope adds a constant ~35 bytes.
 */
export function listingBytes(tools: readonly ListedTool[]): number {
  return Buffer.byteLength(JSON.stringify({ tools }), 'utf8');
}
