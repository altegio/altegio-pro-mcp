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
  /** Whether this view serves the tool. */
  serves(toolName: string): boolean;
  /**
   * Absolute addresses of this endpoint's other views that serve the tool,
   * the complete surface last; empty when this deployment serves it nowhere.
   */
  addressesServing(toolName: string): readonly string[];
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

/**
 * The input schema without the top-level `additionalProperties: false`. The
 * server still refuses an unknown argument — and names the accepted ones in
 * the refusal — so repeating the rule on every tool only costs tokens.
 */
function listedInputSchema(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return schema;
  }
  const { additionalProperties, ...rest } = schema as Record<string, unknown>;
  return additionalProperties === false ? rest : schema;
}

/**
 * A tool's spec as one view lists it.
 *
 * Three things differ from the definition:
 *
 * - **Annotations** drop hints equal to the protocol default
 *   (`listedAnnotations`), and the input schema its top-level
 *   `additionalProperties: false` (`listedInputSchema`).
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
