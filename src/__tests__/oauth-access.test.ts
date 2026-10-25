/**
 * Altegio OAuth access tokens (`ag_at_…`): what the server learns about one
 * from `GET /oauth/accessible-resources` and `GET /user/data`, and how long it
 * keeps it.
 */
import { describe, expect, it, jest } from '@jest/globals';
import {
  OauthGrantsCache,
  OauthGrantsUnavailableError,
  OauthTokenRejectedError,
  fetchOauthGrants,
  isOauthAccessToken,
  oauthOriginFromApiBase,
  resolveOauthGrants,
} from '../auth/oauth-access.js';

const TOKEN = 'ag_at_0123456789abcdef';
const API_BASE = 'https://api.alteg.io/api/v1';
const PARTNER = 'partner-token';

const accessibleResources = {
  object: 'list',
  data: [
    {
      object: 'accessible_resource',
      type: 'location',
      id: 4564,
      main_chain_id: 100,
      scopes: ['clients:read', 'finance:read'],
    },
    {
      object: 'accessible_resource',
      type: 'location',
      id: 720441,
      main_chain_id: null,
      scopes: ['clients:read'],
    },
    {
      object: 'accessible_resource',
      type: 'chain',
      id: 100,
      main_chain_id: null,
      scopes: ['chain_loyalty:read'],
    },
  ],
};

type Call = { url: string; headers: Headers };

function fakeFetch(
  answers: Record<string, () => Response | Error>,
  calls: Call[] = []
): { fetchImpl: typeof fetch; calls: Call[] } {
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    const key = Object.keys(answers).find((prefix) => url.startsWith(prefix));
    if (!key) throw new Error(`unexpected fetch ${url}`);
    const answer = answers[key]!();
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const happyAnswers = {
  'https://api.alteg.io/oauth/accessible-resources': () =>
    json(accessibleResources),
  'https://api.alteg.io/api/v1/user/data': () =>
    json({ success: true, data: { id: 42, name: 'Owner' } }),
};

describe('isOauthAccessToken', () => {
  it('recognises the ag_at_ prefix only', () => {
    expect(isOauthAccessToken(TOKEN)).toBe(true);
    expect(isOauthAccessToken('0123456789abcdef0123456789abcdef')).toBe(false);
    expect(isOauthAccessToken('ag_key_abc')).toBe(false);
    expect(isOauthAccessToken(undefined)).toBe(false);
  });
});

describe('oauthOriginFromApiBase', () => {
  it('drops the API version path', () => {
    expect(oauthOriginFromApiBase('https://api.alteg.io/api/v1')).toBe(
      'https://api.alteg.io'
    );
    expect(
      oauthOriginFromApiBase('https://api.sbx01.altegio.dev/api/v1/')
    ).toBe('https://api.sbx01.altegio.dev');
  });
});

describe('fetchOauthGrants', () => {
  it('reads resources, scopes and the user id with the RND-1974 headers', async () => {
    const { fetchImpl, calls } = fakeFetch(happyAnswers);

    const grants = await fetchOauthGrants({
      token: TOKEN,
      apiBase: API_BASE,
      partnerToken: PARTNER,
      fetchImpl,
    });

    expect(grants.userId).toBe(42);
    expect([...grants.locationIds].sort()).toEqual([4564, 720441]);
    expect([...grants.chainIds]).toEqual([100]);
    expect([...grants.scopes].sort()).toEqual([
      'chain_loyalty:read',
      'clients:read',
      'finance:read',
    ]);
    const location = grants.resources.find((r) => r.id === 4564);
    expect(location).toMatchObject({ type: 'location', mainChainId: 100 });
    expect([...location!.scopes].sort()).toEqual([
      'clients:read',
      'finance:read',
    ]);

    const [resources, user] = calls;
    expect(resources!.url).toBe(
      'https://api.alteg.io/oauth/accessible-resources'
    );
    expect(resources!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(user!.url).toBe('https://api.alteg.io/api/v1/user/data');
    expect(user!.headers.get('authorization')).toBe(
      `Bearer ${PARTNER}, User ${TOKEN}`
    );
    expect(user!.headers.get('accept')).toBe('application/vnd.api.v2+json');
  });

  it('rejects the token when accessible-resources answers 401', async () => {
    const { fetchImpl } = fakeFetch({
      ...happyAnswers,
      'https://api.alteg.io/oauth/accessible-resources': () =>
        json({ type: 'invalid_token' }, 401),
    });

    await expect(
      fetchOauthGrants({
        token: TOKEN,
        apiBase: API_BASE,
        partnerToken: PARTNER,
        fetchImpl,
      })
    ).rejects.toBeInstanceOf(OauthTokenRejectedError);
  });

  it('rejects the token when the legacy API refuses it', async () => {
    const { fetchImpl } = fakeFetch({
      ...happyAnswers,
      'https://api.alteg.io/api/v1/user/data': () =>
        json(
          { success: false, meta: { message: 'Authorization required' } },
          401
        ),
    });

    await expect(
      fetchOauthGrants({
        token: TOKEN,
        apiBase: API_BASE,
        partnerToken: PARTNER,
        fetchImpl,
      })
    ).rejects.toBeInstanceOf(OauthTokenRejectedError);
  });

  it('reports an outage instead of deciding on a 5xx or a network error', async () => {
    const outage = fakeFetch({
      ...happyAnswers,
      'https://api.alteg.io/oauth/accessible-resources': () => json({}, 503),
    });
    await expect(
      fetchOauthGrants({
        token: TOKEN,
        apiBase: API_BASE,
        partnerToken: PARTNER,
        fetchImpl: outage.fetchImpl,
      })
    ).rejects.toBeInstanceOf(OauthGrantsUnavailableError);

    const network = fakeFetch({
      ...happyAnswers,
      'https://api.alteg.io/oauth/accessible-resources': () =>
        new TypeError('fetch failed'),
    });
    await expect(
      fetchOauthGrants({
        token: TOKEN,
        apiBase: API_BASE,
        partnerToken: PARTNER,
        fetchImpl: network.fetchImpl,
      })
    ).rejects.toBeInstanceOf(OauthGrantsUnavailableError);
  });

  it('keeps only well-formed rows and refuses a token with no resources', async () => {
    const { fetchImpl } = fakeFetch({
      ...happyAnswers,
      'https://api.alteg.io/oauth/accessible-resources': () =>
        json({
          object: 'list',
          data: [
            { type: 'location', id: 'x', scopes: ['clients:read'] },
            { type: 'planet', id: 1, scopes: ['clients:read'] },
            { type: 'location', id: 7, scopes: 'clients:read' },
          ],
        }),
    });

    const grants = await fetchOauthGrants({
      token: TOKEN,
      apiBase: API_BASE,
      partnerToken: PARTNER,
      fetchImpl,
    });
    expect(grants.resources).toEqual([]);
    expect(grants.locationIds.size).toBe(0);
    expect(grants.scopes.size).toBe(0);
  });
});

describe('OauthGrantsCache', () => {
  const grants = {
    userId: 1,
    resources: [],
    locationIds: new Set<number>(),
    chainIds: new Set<number>(),
    scopes: new Set<string>(),
    fetchedAt: 0,
  };

  it('returns an entry until its TTL passes, never by the raw token', () => {
    let now = 1_000;
    const cache = new OauthGrantsCache({ ttlMs: 100, now: () => now });
    cache.set(TOKEN, grants);
    expect(cache.get(TOKEN)).toBe(grants);
    expect(cache.get('ag_at_other')).toBeUndefined();
    now = 1_099;
    expect(cache.get(TOKEN)).toBe(grants);
    now = 1_100;
    expect(cache.get(TOKEN)).toBeUndefined();
  });

  it('forgets an evicted token', () => {
    const cache = new OauthGrantsCache();
    cache.set(TOKEN, grants);
    cache.evict(TOKEN);
    expect(cache.get(TOKEN)).toBeUndefined();
  });

  it('drops the oldest entry when full', () => {
    const cache = new OauthGrantsCache({ maxEntries: 2 });
    cache.set('ag_at_1', grants);
    cache.set('ag_at_2', grants);
    cache.set('ag_at_3', grants);
    expect(cache.get('ag_at_1')).toBeUndefined();
    expect(cache.get('ag_at_3')).toBe(grants);
  });
});

describe('resolveOauthGrants', () => {
  it('fetches once per token and serves the cache afterwards', async () => {
    const { fetchImpl, calls } = fakeFetch(happyAnswers);
    const cache = new OauthGrantsCache();
    const input = {
      token: TOKEN,
      apiBase: API_BASE,
      partnerToken: PARTNER,
      fetchImpl,
    };

    const first = await resolveOauthGrants(input, cache);
    const second = await resolveOauthGrants(input, cache);

    expect(second).toBe(first);
    expect(calls).toHaveLength(2);
    expect(cache.get(TOKEN)).toBe(first);
  });

  it('fetches again for a rotated token', async () => {
    const { fetchImpl, calls } = fakeFetch(happyAnswers);
    const cache = new OauthGrantsCache();
    await resolveOauthGrants(
      { token: TOKEN, apiBase: API_BASE, partnerToken: PARTNER, fetchImpl },
      cache
    );
    await resolveOauthGrants(
      {
        token: 'ag_at_rotated',
        apiBase: API_BASE,
        partnerToken: PARTNER,
        fetchImpl,
      },
      cache
    );
    expect(calls).toHaveLength(4);
    expect(jest.isMockFunction(fetchImpl)).toBe(false);
  });
});
