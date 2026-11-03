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
import { UpstreamBudget } from '../utils/upstream-budget.js';
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
  timeoutMs?: number;
  signal?: AbortSignal;
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
  budget: UpstreamBudget,
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  what: string
): Promise<unknown> {
  let response: Response;
  try {
    response = await budget.fetch(url, { method: 'GET', headers }, fetchImpl);
  } catch {
    throw new OauthGrantsUnavailableError(
      `Altegio could not be reached to ${what}.`
    );
  }
  if (!response.ok) await response.body?.cancel().catch(() => undefined);
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

  const budget = new UpstreamBudget(input.timeoutMs ?? 10_000, input.signal);
  try {
    const listing = await call(
      budget,
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
      budget,
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
  } catch (error) {
    if (error instanceof OauthTokenRejectedError) throw error;
    throw new OauthGrantsUnavailableError();
  } finally {
    budget.close();
  }
}

export interface OauthGrantsCacheOptions {
  /** How long one token's grants are trusted; the token itself lives an hour. */
  ttlMs?: number;
  maxEntries?: number;
  maxConcurrent?: number;
  timeoutMs?: number;
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
  private readonly pending = new Map<
    string,
    { promise: Promise<OauthGrants>; abort: AbortController }
  >();
  private activeLookups = 0;
  private readonly maxConcurrent: number;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: OauthGrantsCacheOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? 32;
    this.timeoutMs = options.timeoutMs ?? 10_000;
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
    const key = tokenKey(token);
    this.entries.delete(key);
    this.pending.get(key)?.abort.abort();
    this.pending.delete(key);
  }

  clear(): void {
    this.entries.clear();
    for (const entry of this.pending.values()) entry.abort.abort();
    this.pending.clear();
  }

  resolve(input: FetchOauthGrantsInput, fresh = false): Promise<OauthGrants> {
    const cached = this.get(input.token);
    if (cached && !fresh) return Promise.resolve(cached);
    const key = tokenKey(input.token);
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    if (this.activeLookups >= this.maxConcurrent)
      return Promise.reject(
        new OauthGrantsUnavailableError(
          'OAuth verification capacity reached; retry later.'
        )
      );
    this.activeLookups++;
    const abort = new AbortController();
    const promise = fetchOauthGrants({
      ...input,
      timeoutMs: this.timeoutMs,
      signal: abort.signal,
    })
      .then((grants) => {
        abort.signal.throwIfAborted();
        this.set(input.token, grants);
        return grants;
      })
      .finally(() => {
        this.activeLookups--;
        if (this.pending.get(key)?.promise === promise)
          this.pending.delete(key);
      });
    this.pending.set(key, { promise, abort });
    return promise;
  }
}

/** The one cache the HTTP server and the request context share. */
export const oauthGrantsCache = new OauthGrantsCache();

/** Cached grants for the token, fetched once per token otherwise. */
export async function resolveOauthGrants(
  input: FetchOauthGrantsInput,
  cache: OauthGrantsCache = oauthGrantsCache
): Promise<OauthGrants> {
  return cache.resolve(input);
}

/** Revalidate local state access, sharing in-flight work but ignoring completed grants. */
export function refreshOauthGrants(
  input: FetchOauthGrantsInput,
  cache: OauthGrantsCache = oauthGrantsCache
): Promise<OauthGrants> {
  return cache.resolve(input, true);
}
