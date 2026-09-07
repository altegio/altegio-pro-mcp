/**
 * The narrow HTTP port the API adapters are written against (ADR-001 D5).
 *
 * `AltegioClient` owns the one implementation of token resolution that matters:
 * per-identity tokens behind the OAuth proxy in HTTP mode, the legacy
 * single-user credential file in stdio mode. Adapters must not duplicate that
 * logic, so they take this port instead of building requests themselves, and
 * `httpFromClient` bridges an `AltegioClient` to it.
 *
 * The bridge reaches the client's internal request method structurally. That
 * method is `private` in TypeScript only — a compile-time marker, not a runtime
 * barrier — and promoting it to a public port belongs to the transport work in
 * flight, so this module keeps the coupling in one documented place and fails
 * loudly if the plumbing ever moves. `src/api/__tests__/altegio-http.test.ts`
 * guards the assumption.
 */
import type { AltegioClient } from '../providers/altegio-client.js';
import { AuthenticationError } from '../utils/errors.js';

/** Everything an adapter needs from the transport. */
export interface AltegioHttp {
  /**
   * Perform one request against the Altegio API.
   *
   * @param path  path below the API base, e.g. `/company/1/analytics/overall`.
   * @param init  standard fetch options; `Accept`, `Accept-Language` and
   *              `Authorization` are supplied by the transport.
   */
  request(path: string, init?: RequestInit): Promise<Response>;
  /** Whether the current request has a usable user token. */
  isAuthenticated(): boolean;
}

/** Shape of the internal request plumbing the bridge borrows. */
interface ClientInternals {
  apiRequest?: (path: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Name of the internal method the bridge depends on. Exported so the contract
 * test can assert its presence without repeating the string.
 */
export const CLIENT_REQUEST_METHOD = 'apiRequest';

export function httpFromClient(client: AltegioClient): AltegioHttp {
  const internals = client as unknown as ClientInternals;
  const request = internals[CLIENT_REQUEST_METHOD];
  if (typeof request !== 'function') {
    throw new Error(
      `AltegioClient no longer exposes ${CLIENT_REQUEST_METHOD}; update src/api/altegio-http.ts to the new transport port.`
    );
  }
  return {
    request: (path, init) => request.call(client, path, init),
    isAuthenticated: () => client.isAuthenticated(),
  };
}

/** Throw the shared authentication error when no user token is available. */
export function requireUserToken(http: AltegioHttp, action: string): void {
  if (!http.isAuthenticated()) {
    throw new AuthenticationError(
      `Not authenticated. Call altegio_login before trying to ${action}.`
    );
  }
}

/** Build a query string from a sparse parameter map, skipping empty values. */
export function queryString(
  params: Record<string, string | number | boolean | undefined | null>
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.append(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : '';
}

/** Append a repeated `include[]` parameter, the form the API validates. */
export function includeParams(includes: readonly string[]): string {
  return includes.map((i) => `include[]=${encodeURIComponent(i)}`).join('&');
}

/**
 * Prefix that reaches the internal `/api/v2` tree through a transport bound to
 * the `/api/v1` base.
 *
 * The WHATWG URL parser — which `fetch` uses — normalizes the `..` segment, so
 * `<base>/api/v1` + `/../v2/locations/1/...` resolves to `/api/v2/locations/1/…`.
 * Only one endpoint needs this (per-client visit counts); everything else lives
 * under v1. `src/api/__tests__/altegio-http.test.ts` pins the normalization.
 */
export const V2_PATH_PREFIX = '/../v2';

/** Build a path below `/api/v2` for a transport bound to `/api/v1`. */
export function v2Path(suffix: string): string {
  return `${V2_PATH_PREFIX}${suffix.startsWith('/') ? suffix : `/${suffix}`}`;
}
