/**
 * Per-request delegated identity context.
 *
 * In the HTTP deployment every MCP request arrives behind the platform's
 * OAuth 2.1 proxy, which forwards the verified caller identity as
 * `x-mcp-auth-*` headers. This module parses those headers and exposes the
 * identity to downstream code through an AsyncLocalStorage, so a single
 * long-lived server/client instance can act as the correct identity for each
 * individual request instead of "whoever logged in last".
 *
 * Local stdio usage has no HTTP context at all: `getRequestIdentity()` returns
 * `undefined` there, which callers treat as today's single-user behavior.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { createLogger } from './utils/logger.js';
import { AltegioApiError } from './utils/errors.js';

const logger = createLogger('request-context');

export interface RequestIdentity {
  kind: 'user' | 'machine';
  email?: string;
  sub?: string;
  clientId?: string;
  scope?: string;
  machineName?: string;
}

type HeaderBag = Record<string, string | string[] | undefined>;

/**
 * Case-insensitive single-value header lookup.
 * Express lowercases header keys already, but accept any casing defensively.
 */
function headerValue(headers: HeaderBag, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const value = headers[key];
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

/**
 * Case-insensitive multi-value header lookup — every value sent under `name`.
 *
 * A header can arrive more than once: Node folds most repeated request headers
 * into one comma-joined string, but a proxy or a test may still present them as
 * an array. This returns each raw value so a caller can parse a *set* (see
 * `parseCompanyIds`), where `headerValue`'s "first value only" would silently
 * drop the rest.
 */
function headerValues(headers: HeaderBag, name: string): string[] {
  const target = name.toLowerCase();
  const values: string[] = [];
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      const value = headers[key];
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (typeof entry === 'string') values.push(entry);
        }
      } else if (typeof value === 'string') {
        values.push(value);
      }
    }
  }
  return values;
}

/**
 * Parse the proxy's `x-mcp-auth-*` identity headers.
 *
 * Returns `null` when no identity is present (`x-mcp-auth-kind` absent), or
 * when a `user` identity is missing both `email` and `sub` (nothing stable to
 * key a token by). A `null` result means "HTTP context, but anonymous".
 */
export function parseIdentityHeaders(
  headers: HeaderBag
): RequestIdentity | null {
  const kind = headerValue(headers, 'x-mcp-auth-kind');
  if (!kind) {
    return null;
  }

  if (kind === 'user') {
    const email = headerValue(headers, 'x-mcp-auth-email');
    const sub = headerValue(headers, 'x-mcp-auth-sub');
    if (!email && !sub) {
      logger.warn(
        'Received a user identity header without email or sub; treating request as anonymous'
      );
      return null;
    }
    return {
      kind: 'user',
      email,
      sub,
      clientId: headerValue(headers, 'x-mcp-auth-client-id'),
      scope: headerValue(headers, 'x-mcp-auth-scope'),
    };
  }

  if (kind === 'machine') {
    return {
      kind: 'machine',
      machineName: headerValue(headers, 'x-mcp-auth-machine-name'),
      scope: headerValue(headers, 'x-mcp-auth-scope'),
    };
  }

  logger.warn(
    { kind },
    'Unknown x-mcp-auth-kind value; treating request as anonymous'
  );
  return null;
}

/** Header carrying a per-request Altegio user (technical-user) token. */
const USER_TOKEN_HEADER = 'x-altegio-user-token';

/**
 * Extract a directly-supplied Altegio user token from the request headers.
 *
 * This is the multi-client path: instead of logging in once and keying a token
 * by proxy identity, a deployment that serves many Altegio clients sends the
 * specific client's technical-user token on every request. Returns `undefined`
 * when the header is absent or blank.
 */
export function parseUserToken(headers: HeaderBag): string | undefined {
  const value = headerValue(headers, USER_TOKEN_HEADER)?.trim();
  return value ? value : undefined;
}

/** Header carrying a per-request Altegio partner token (UC2). */
const PARTNER_TOKEN_HEADER = 'x-altegio-partner-token';

/**
 * Extract a per-request Altegio partner token from the request headers.
 *
 * This header is the fork selector between the server's two authentication use
 * cases:
 *
 *  - **UC1 — human via a generic agent (header ABSENT):** the server signs
 *    upstream calls with its OWN partner token (`ALTEGIO_API_TOKEN`) and the
 *    caller reaches Altegio through `altegio_login` (email + password → user
 *    token).
 *  - **UC2 — application agent (header PRESENT):** the caller is itself an
 *    Altegio application and sends its own partner token per request, alongside
 *    `X-Altegio-User-Token`. The upstream credential is built from the
 *    per-request partner token, never the server's.
 *
 * Returns `undefined` when the header is absent or blank — which keeps the
 * request on the UC1 path.
 */
export function parsePartnerToken(headers: HeaderBag): string | undefined {
  const value = headerValue(headers, PARTNER_TOKEN_HEADER)?.trim();
  return value ? value : undefined;
}

/** Header declaring the set of company (location) IDs a request may touch. */
const COMPANY_ID_HEADER = 'x-altegio-company-id';

/**
 * Extract the declared company (location) scope from the request headers.
 *
 * A caller confines a request to a set of companies by sending
 * `X-Altegio-Company-Id`. Multiple IDs are supported two ways, and may be
 * combined:
 *   - the header repeated (`X-Altegio-Company-Id: 1` then `: 2`), and/or
 *   - a comma-separated value (`X-Altegio-Company-Id: 1,2,3`).
 *
 * The set is trusted exactly as declared: the server does not validate,
 * compute, or resolve which companies belong to the caller — deciding that is
 * the caller's responsibility. Every operation is then confined to this set
 * (`assertCompanyAllowed`, and the `list_locations` filter).
 *
 * Returns `undefined` when the header is absent or carries no positive integer,
 * meaning "no scope declared" — no confinement is applied (today's behaviour for
 * every other caller). Non-integer fragments are ignored and logged; a bad
 * fragment never silently widens scope. When at least one valid ID is present,
 * a set of exactly the valid IDs is returned.
 */
export function parseCompanyIds(
  headers: HeaderBag
): ReadonlySet<number> | undefined {
  const raw = headerValues(headers, COMPANY_ID_HEADER);
  if (raw.length === 0) {
    return undefined;
  }

  const ids = new Set<number>();
  for (const fragment of raw.flatMap((value) => value.split(','))) {
    const trimmed = fragment.trim();
    if (trimmed === '') continue;
    const id = Number(trimmed);
    if (!Number.isInteger(id) || id <= 0) {
      logger.warn(
        { fragment: trimmed },
        'Ignoring non-integer X-Altegio-Company-Id fragment'
      );
      continue;
    }
    ids.add(id);
  }

  return ids.size > 0 ? ids : undefined;
}

/**
 * Everything bound to a single request's async context.
 *
 * `identity` is the proxy-verified caller (`null` when anonymous). `userToken`
 * is an Altegio user token supplied directly on the request
 * (`X-Altegio-User-Token`); when present it takes precedence over identity- and
 * file-scoped tokens (see `AltegioClient.resolveUserToken`). `partnerToken` is a
 * per-request Altegio partner token (`X-Altegio-Partner-Token`, UC2); when
 * present it replaces the server's own partner token when signing upstream
 * calls. `companyIds` is the declared company (location) scope
 * (`X-Altegio-Company-Id`); when present every operation is confined to it.
 */
export interface RequestContext {
  identity: RequestIdentity | null;
  userToken?: string;
  partnerToken?: string;
  companyIds?: ReadonlySet<number>;
}

/** Build the complete request context from HTTP headers in one place. */
export function requestContextFromHeaders(headers: HeaderBag): RequestContext {
  return {
    identity: parseIdentityHeaders(headers),
    userToken: parseUserToken(headers),
    partnerToken: parsePartnerToken(headers),
    companyIds: parseCompanyIds(headers),
  };
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Run `fn` with a full request context (identity + optional direct token)
 * bound to the current async context.
 */
export function runWithContext<T>(context: RequestContext, fn: () => T): T {
  return storage.run(context, fn);
}

/**
 * Run `fn` with just an identity bound (no direct user token).
 * `null` binds an "anonymous HTTP request" context (distinct from stdio).
 */
export function runWithIdentity<T>(
  identity: RequestIdentity | null,
  fn: () => T
): T {
  return storage.run({ identity }, fn);
}

/**
 * Resolve the identity for the current async context.
 * - `undefined` — no HTTP context at all (stdio / local single-user usage).
 * - `null`      — HTTP context, but the request was anonymous.
 * - object      — the proxy-verified identity for this request.
 */
export function getRequestIdentity(): RequestIdentity | null | undefined {
  const context = storage.getStore();
  return context === undefined ? undefined : context.identity;
}

/**
 * The Altegio user token supplied directly on the current request, if any.
 * `undefined` outside a request context or when the header was absent/blank.
 */
export function getRequestUserToken(): string | undefined {
  return storage.getStore()?.userToken;
}

/**
 * The per-request Altegio partner token (`X-Altegio-Partner-Token`, UC2), if
 * any. `undefined` outside a request context or when the header was absent —
 * in which case the server signs upstream calls with its own partner token
 * (UC1).
 */
export function getRequestPartnerToken(): string | undefined {
  return storage.getStore()?.partnerToken;
}

/**
 * The declared company (location) scope for this request, if any. `undefined`
 * outside a request context or when no `X-Altegio-Company-Id` header was sent —
 * in which case no company confinement is applied (today's behaviour for every
 * other caller).
 */
export function getRequestCompanyIds(): ReadonlySet<number> | undefined {
  return storage.getStore()?.companyIds;
}

/**
 * Whether `companyId` is reachable under the current request's declared scope.
 *
 * `true` when no scope is declared (stdio, or a request without the header), so
 * every existing caller is unaffected; otherwise `true` only for a company in
 * the declared set. Used to filter `list_locations` down to the allowed set.
 */
export function isCompanyAllowed(companyId: number): boolean {
  const scope = getRequestCompanyIds();
  return scope === undefined || scope.has(companyId);
}

/**
 * Enforce the current request's declared company (location) scope.
 *
 * When a request declares a scope via `X-Altegio-Company-Id`, acting on any
 * company OUTSIDE that set is rejected with a 403 — and only that company:
 * every ID in the set is allowed. Unscoped requests (no header, or stdio) are a
 * no-op, so every existing caller is unaffected. This is the single guard every
 * upstream request passes through (`AltegioClient.apiRequest`), so a new tool is
 * confined without having to remember to add a check.
 */
export function assertCompanyAllowed(companyId: number): void {
  const scope = getRequestCompanyIds();
  if (scope !== undefined && !scope.has(companyId)) {
    const allowed = [...scope].sort((a, b) => a - b).join(', ');
    throw new AltegioApiError(
      `This request is scoped to compan${scope.size === 1 ? 'y' : 'ies'} ` +
        `${allowed}; company ${companyId} is not in scope.`,
      403
    );
  }
}

/**
 * Stable, non-reversible key for an identity, used to scope stored tokens.
 * Prefers the opaque subject, then email, then the machine name.
 */
export function identityKey(identity: RequestIdentity): string {
  const material =
    identity.sub || identity.email || `machine:${identity.machineName ?? ''}`;
  return crypto
    .createHash('sha256')
    .update(material)
    .digest('hex')
    .slice(0, 16);
}
