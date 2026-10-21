/**
 * The view a tool call is answered on, for the replies that name another tool.
 *
 * `tools/list` already shows only what a view serves, but a reply can still
 * point at a tool: a describe naming the curated tool that performs a write, a
 * preview handing over to its apply step, an authentication failure telling
 * the caller to log in. On a narrower view — the read-only address, and every
 * HTTP view where password login is withheld — that tool does not exist, and a
 * model told to call it gets a refusal or stalls. A reply that names a tool
 * reads the running call's view from here and, when this view does not serve
 * the tool, says which addresses do.
 *
 * The registry binds the view around each `tools/call` (`runOnView`), the same
 * way it binds the caller's identity. Outside a call — unit tests, a handler
 * used directly — nothing is bound and every tool counts as served, which is
 * what stdio's unfiltered view serves.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface ServingView {
  /**
   * Whether a call on this view reaches the tool: listed, or run through the
   * view's dispatcher (`tools_call_read`, `tools_call_write`,
   * `tools_call_destructive`).
   */
  serves(toolName: string): boolean;
  /**
   * Whether this view's `tools/list` carries the tool. Absent means every
   * served tool is listed, which holds for every view but the compact listing.
   */
  lists?(toolName: string): boolean;
  /**
   * Absolute addresses of this endpoint's other views that serve the tool,
   * the complete surface last; empty when this deployment serves it nowhere.
   */
  addressesServing(toolName: string): readonly string[];
}

/** Whether the view's `tools/list` carries the tool (`ServingView.lists`). */
export function listedOn(view: ServingView, toolName: string): boolean {
  return view.lists ? view.lists(toolName) : view.serves(toolName);
}

const UNFILTERED_VIEW: ServingView = {
  serves: () => true,
  addressesServing: () => [],
};

const storage = new AsyncLocalStorage<ServingView>();

/** Run `fn` with `view` as the view its replies are written for. */
export function runOnView<T>(view: ServingView, fn: () => T): T {
  return storage.run(view, fn);
}

/** The view of the running call; unfiltered outside one. */
export function currentView(): ServingView {
  return storage.getStore() ?? UNFILTERED_VIEW;
}

/**
 * Where a tool this view does not serve can be reached, as a clause to follow
 * "this address does not serve it" — or `undefined` when this view serves it.
 */
export function elsewhereClause(toolName: string): string | undefined {
  const view = currentView();
  if (view.serves(toolName)) return undefined;
  const addresses = view.addressesServing(toolName);
  if (addresses.length === 0) return 'this deployment does not serve it';
  return `it is served on ${addresses.join(' and ')}`;
}

/** Password login is the only tool that signs a connection in. */
const LOGIN_TOOL = 'auth_login';

/**
 * What to tell a caller whose Altegio session is missing or expired.
 *
 * Where the view serves password login, the caller signs in with it. Every
 * other HTTP view is signed in by the host that opened the connection (OAuth
 * through the platform proxy, or a user token it was given), so naming
 * `auth_login` there sends the model after a tool it does not have.
 */
export function signInInstruction(toolName: string): string {
  if (currentView().serves(LOGIN_TOOL)) {
    return `Authentication required. Call ${LOGIN_TOOL} before using ${toolName}.`;
  }
  return (
    `Authentication required: this connection has no valid Altegio sign-in for ${toolName}. ` +
    'The app this connection runs in signs it in — reconnect Altegio there, then retry.'
  );
}

/** Whether the running call's view offers password login. */
export function servesPasswordLogin(): boolean {
  return currentView().serves(LOGIN_TOOL);
}

/** Whether `text` names `toolName` as a whole word (tool names are `[a-z_]`). */
function names(text: string, toolName: string): boolean {
  return new RegExp(`\\b${toolName}\\b`).test(text);
}

/**
 * Tool annotations without the hints that only repeat the protocol default
 * (`openWorldHint: true`, `idempotentHint: false`, `readOnlyHint: false`), and
 * without `destructiveHint` on a read-only tool, where MCP says it is
 * meaningless. What a host concludes is unchanged; the list is shorter.
 */
function listedAnnotations(
  annotations: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!annotations) return undefined;
  const out = { ...annotations };
  if (out.openWorldHint === true) delete out.openWorldHint;
  if (out.idempotentHint === false) delete out.idempotentHint;
  if (out.readOnlyHint === false) delete out.readOnlyHint;
  if (out.readOnlyHint === true) delete out.destructiveHint;
  return out;
}

/** Keys whose value is one schema, or an array of schemas. */
const SUBSCHEMA_KEYS = new Set([
  'items',
  'prefixItems',
  'anyOf',
  'oneOf',
  'allOf',
  'not',
]);

/** Keys whose value maps names to schemas. */
const SCHEMA_MAP_KEYS = new Set(['properties', '$defs', 'definitions']);

/**
 * Whether an integer argument's `minimum: 1` only restates that ids and pages
 * count from one: `id`, `*_id`, the items of `*_ids`, `page`, `page_size`.
 */
function countsFromOne(name: string | undefined): boolean {
  return (
    name !== undefined &&
    (name === 'id' ||
      name === 'page' ||
      name === 'page_size' ||
      name.endsWith('_id') ||
      name.endsWith('_ids'))
  );
}

/**
 * One node of the input schema as listed, at any depth: without
 * `additionalProperties: false`, and without `minimum: 1` on an integer id or
 * page. The server still refuses an unknown argument, a zero id or page, and
 * names the rule in the refusal, so repeating either on every tool only costs
 * tokens — about 4 KB of `/mcp` in October 2026. `name` is the argument the
 * node describes; array items and union branches inherit it.
 */
function listedSchemaNode(node: unknown, name?: string): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => listedSchemaNode(item, name));
  }
  if (!node || typeof node !== 'object') return node;
  const schema = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties' && value === false) continue;
    if (
      key === 'minimum' &&
      value === 1 &&
      schema.type === 'integer' &&
      countsFromOne(name)
    ) {
      continue;
    }
    if (
      SCHEMA_MAP_KEYS.has(key) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = Object.fromEntries(
        Object.entries(value).map(([prop, sub]) => [
          prop,
          listedSchemaNode(sub, prop),
        ])
      );
    } else if (SUBSCHEMA_KEYS.has(key)) {
      out[key] = listedSchemaNode(value, name);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The input schema as listed; see `listedSchemaNode`. */
function listedInputSchema(schema: unknown): unknown {
  return listedSchemaNode(schema);
}

/**
 * A tool's spec as one view lists it.
 *
 * Three things differ from the definition:
 *
 * - **Annotations** drop hints equal to the protocol default
 *   (`listedAnnotations`), and the input schema every
 *   `additionalProperties: false` and the `minimum: 1` of ids and pages
 *   (`listedSchemaNode`).
 * - **No `outputSchema`.** It is optional in MCP, results still carry
 *   `structuredContent`, and it was the largest part of `tools/list` (up to
 *   44% of the read-only view) — paid by every host on every connection, for a
 *   schema no host shows a model before the call. The schemas stay in the
 *   definitions as the tested contract of `structuredContent`.
 * - **Unserved neighbours named.** Descriptions point at neighbouring tools —
 *   "for day-by-day numbers use analytics_get_daily_series", "find the service
 *   with services_list" — and a narrower view may not serve the neighbour.
 *   When the description or the input schema names a tool this view does not
 *   serve, one sentence is appended saying where each is served, so a view's
 *   `tools/list` never offers a name it would refuse without saying so.
 */
export function listedOnView<
  T extends {
    name: string;
    description?: string;
    inputSchema: unknown;
    outputSchema?: unknown;
  },
>(
  spec: T,
  view: ServingView,
  toolNames: readonly string[]
): Omit<T, 'outputSchema'> {
  const { outputSchema: _contractOnly, ...rest } = spec;
  void _contractOnly;
  const annotations = listedAnnotations(
    (rest as { annotations?: Record<string, unknown> }).annotations
  );
  const listed = {
    ...rest,
    inputSchema: listedInputSchema(rest.inputSchema),
    ...(annotations ? { annotations } : {}),
  } as Omit<T, 'outputSchema'>;
  const text = JSON.stringify([listed.description, listed.inputSchema]);
  const unserved = toolNames.filter(
    (name) => name !== listed.name && !view.serves(name) && names(text, name)
  );
  if (unserved.length === 0) return listed;

  const byAddress = new Map<string, string[]>();
  for (const name of unserved) {
    // The narrowest view that serves it; the complete surface is the fallback.
    const where = view.addressesServing(name)[0] ?? '';
    byAddress.set(where, [...(byAddress.get(where) ?? []), `\`${name}\``]);
  }
  const clauses = [...byAddress].map(
    ([where, tools]) =>
      `${tools.join(', ')} (${where ? `served on ${where}` : 'not served by this deployment'})`
  );
  return {
    ...listed,
    description: `${listed.description ?? ''} Not served on this address: ${clauses.join('; ')}.`,
  };
}
