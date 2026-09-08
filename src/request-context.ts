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

/**
 * Everything bound to a single request's async context.
 *
 * `identity` is the proxy-verified caller (`null` when anonymous). `userToken`
 * is an Altegio user token supplied directly on the request
 * (`X-Altegio-User-Token`); when present it takes precedence over identity- and
 * file-scoped tokens (see `AltegioClient.resolveUserToken`).
 */
export interface RequestContext {
  identity: RequestIdentity | null;
  userToken?: string;
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
