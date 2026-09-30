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
 * A tool's spec as one view lists it.
 *
 * Descriptions point at neighbouring tools — "for day-by-day numbers use
 * analytics_get_daily_series", "find the service with services_list" — and a
 * narrower view may not serve the neighbour. When the description or the input
 * schema names a tool this view does not serve, one sentence is appended saying
 * where each is served, so a view's `tools/list` never offers a name it would
 * refuse without saying so. A spec whose references are all served here is
 * returned unchanged, which is every spec on the complete surface.
 */
export function listedOnView<
  T extends { name: string; description?: string; inputSchema: unknown },
>(spec: T, view: ServingView, toolNames: readonly string[]): T {
  const text = JSON.stringify([spec.description, spec.inputSchema]);
  const unserved = toolNames.filter(
    (name) => name !== spec.name && !view.serves(name) && names(text, name)
  );
  if (unserved.length === 0) return spec;

  const byAddress = new Map<string, string[]>();
  for (const name of unserved) {
    const where = view.addressesServing(name).join(' and ');
    byAddress.set(where, [...(byAddress.get(where) ?? []), `\`${name}\``]);
  }
  const clauses = [...byAddress].map(
    ([where, tools]) =>
      `${tools.join(', ')} (${where ? `served on ${where}` : 'not served by this deployment'})`
  );
  return {
    ...spec,
    description: `${spec.description ?? ''} Not served on this address: ${clauses.join('; ')}.`,
  };
}
