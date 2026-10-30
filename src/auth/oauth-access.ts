/**
 * Altegio OAuth access tokens (`ag_at_…`) on the HTTP surface.
 *
 * A host that connected `/pro` through Altegio's own authorization server
 * presents an opaque access token the platform proxy passes straight through
 * as `x-altegio-user-token`. The server cannot read anything out of it, so it
 * asks Altegio twice per token: `GET /oauth/accessible-resources` says which
 * chains and locations the consent covers and which scopes the token carries
 * in each of them; `GET /api/v1/user/data` (the RND-1974 bridge) names the
 * person, which keys every piece of local state so a rotated token does not
 * lose it. Both answers are kept per token for at most an hour and dropped
 * the moment Altegio refuses the token anywhere.
 */
import crypto from 'node:crypto';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('oauth-access');

/** biz.erp `CredentialPrefix::AccessToken`. */
export const OAUTH_ACCESS_TOKEN_PREFIX = 'ag_at_';

export function isOauthAccessToken(token: string | undefined): boolean {
  return (
    typeof token === 'string' && token.startsWith(OAUTH_ACCESS_TOKEN_PREFIX)
  );
}

export type ResourceType = 'chain' | 'location';

/** One row of `GET /oauth/accessible-resources`, scopes as a set. */
export interface ResourceGrant {
  type: ResourceType;
  id: number;
  mainChainId: number | null;
  scopes: ReadonlySet<string>;
}

/** Everything the server knows about one access token. */
export interface OauthGrants {
  userId: number;
  /** The person's e-mail, when Altegio names one: handed to the proxy, never logged here. */
  email?: string;
  resources: readonly ResourceGrant[];
  locationIds: ReadonlySet<number>;
  chainIds: ReadonlySet<number>;
  /** Union of every resource's scopes — the fast pre-call gate. */
  scopes: ReadonlySet<string>;
  fetchedAt: number;
}

/** Altegio refused the token: expired, revoked, consent withdrawn, client frozen. */
export class OauthTokenRejectedError extends Error {
  readonly status = 401;
  constructor(message = 'The Altegio access token was not accepted.') {
    super(message);
    this.name = 'OauthTokenRejectedError';
  }
}

/** Altegio could not be asked; nothing is known about the token. */
export class OauthGrantsUnavailableError extends Error {
  readonly status = 503;
  constructor(
    message = 'Altegio could not verify the access token right now.'
  ) {
    super(message);
    this.name = 'OauthGrantsUnavailableError';
  }
}

/** `https://api.alteg.io/api/v1` → `https://api.alteg.io`, where `/oauth/*` lives. */
export function oauthOriginFromApiBase(apiBase: string): string {
  return new URL(apiBase).origin;
}

export interface FetchOauthGrantsInput {
  token: string;
  apiBase: string;
  partnerToken: string;
  fetchImpl?: typeof fetch;
}

function positiveInteger(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function grantFromRow(row: unknown): ResourceGrant | null {
  if (!row || typeof row !== 'object') return null;
  const { type, id, main_chain_id, scopes } = row as Record<string, unknown>;
  if (type !== 'chain' && type !== 'location') return null;
  const numericId = positiveInteger(id);
  if (numericId === null) return null;
  if (!Array.isArray(scopes)) return null;
  return {
    type,
    id: numericId,
    mainChainId: positiveInteger(main_chain_id),
    scopes: new Set(
      scopes.filter((scope): scope is string => typeof scope === 'string')
    ),
  };
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function call(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  what: string
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, { method: 'GET', headers });
  } catch {
    throw new OauthGrantsUnavailableError(
      `Altegio could not be reached to ${what}.`
    );
  }
  if (response.status === 401) {
    throw new OauthTokenRejectedError();
  }
  if (!response.ok) {
    logger.warn(
      { http_status: response.status, error_type: 'oauth_grants_unavailable' },
      `Unexpected status while trying to ${what}`
    );
    throw new OauthGrantsUnavailableError(
      `Altegio answered HTTP ${response.status} while trying to ${what}.`
    );
  }
  return readJson(response);
}

/**
 * Ask Altegio what one access token may do and who holds it.
 *
 * `accessible-resources` answers with the v3 credential; `/user/data` goes
 * through the legacy bridge, so it needs the partner token and the V2 media
 * type (the MCP platform partner is a new one, which v1 accepts only with
 * `Accept: application/vnd.api.v2+json`).
 */
export async function fetchOauthGrants(
  input: FetchOauthGrantsInput
): Promise<OauthGrants> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const origin = oauthOriginFromApiBase(input.apiBase);

  const listing = await call(
    fetchImpl,
    `${origin}/oauth/accessible-resources`,
    { Authorization: `Bearer ${input.token}`, Accept: 'application/json' },
    'list the accessible resources'
  );
  const rows = (listing as { data?: unknown })?.data;
  const resources: ResourceGrant[] = [];
  if (Array.isArray(rows)) {
    for (const row of rows) {
      const grant = grantFromRow(row);
      if (grant) resources.push(grant);
      else
        logger.warn(
          { error_type: 'malformed_resource_row' },
          'Ignoring a malformed accessible-resources row'
        );
    }
  }

  const profile = await call(
    fetchImpl,
    `${input.apiBase.replace(/\/+$/, '')}/user/data`,
    {
      Authorization: `Bearer ${input.partnerToken}, User ${input.token}`,
      Accept: 'application/vnd.api.v2+json',
    },
    'read the current user'
  );
  const userId = positiveInteger(
    (profile as { data?: { id?: unknown } })?.data?.id
  );
  if (userId === null) {
    throw new OauthGrantsUnavailableError(
      'Altegio did not name the user behind the access token.'
    );
  }

  const rawEmail = (profile as { data?: { email?: unknown } })?.data?.email;
  const email = typeof rawEmail === 'string' ? rawEmail.trim() : '';

  const locationIds = new Set<number>();
  const chainIds = new Set<number>();
  const scopes = new Set<string>();
  for (const grant of resources) {
    (grant.type === 'location' ? locationIds : chainIds).add(grant.id);
    for (const scope of grant.scopes) scopes.add(scope);
  }

  return {
    userId,
    ...(email ? { email } : {}),
    resources,
    locationIds,
    chainIds,
    scopes,
    fetchedAt: Date.now(),
  };
}

export interface OauthGrantsCacheOptions {
  /** How long one token's grants are trusted; the token itself lives an hour. */
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 4096;

function tokenKey(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Grants per token, keyed by the token's hash so the token string itself is
 * never held in a long-lived structure. Insertion-ordered, so a full cache
 * drops its oldest entry.
 */
export class OauthGrantsCache {
  private readonly entries = new Map<
    string,
    { grants: OauthGrants; expiresAt: number }
  >();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: OauthGrantsCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  get(token: string): OauthGrants | undefined {
    const key = tokenKey(token);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.grants;
  }

  set(token: string, grants: OauthGrants): void {
    const key = tokenKey(token);
    this.entries.delete(key);
    this.entries.set(key, { grants, expiresAt: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  evict(token: string): void {
    this.entries.delete(tokenKey(token));
  }

  clear(): void {
    this.entries.clear();
  }
}

/** The one cache the HTTP server and the request context share. */
export const oauthGrantsCache = new OauthGrantsCache();

/** Cached grants for the token, fetched once per token otherwise. */
export async function resolveOauthGrants(
  input: FetchOauthGrantsInput,
  cache: OauthGrantsCache = oauthGrantsCache
): Promise<OauthGrants> {
  const cached = cache.get(input.token);
  if (cached) return cached;
  const grants = await fetchOauthGrants(input);
  cache.set(input.token, grants);
  return grants;
}
