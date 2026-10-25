/**
 * `AltegioClient` under an Altegio OAuth access token: the RND-1974 header
 * contract on the ERP web part, chain and location confinement from the
 * token's grants, and the cache eviction that turns a refused token into a
 * fresh sign-in on the next request.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { AltegioClient } from '../providers/altegio-client.js';
import {
  requestContextFromHeaders,
  runWithContext,
  runWithRequiredScopes,
} from '../request-context.js';
import { oauthGrantsCache, type OauthGrants } from '../auth/oauth-access.js';
import { AuthenticationError } from '../utils/errors.js';

const TOKEN = 'ag_at_client_test_token';
const LEGACY = 'legacy-users-hash';

const grants: OauthGrants = {
  userId: 42,
  resources: [
    {
      type: 'location',
      id: 4564,
      mainChainId: 100,
      scopes: new Set(['locations:read', 'analytics:read', 'loyalty:read']),
    },
    {
      type: 'location',
      id: 720441,
      mainChainId: null,
      scopes: new Set(['locations:read']),
    },
    {
      type: 'chain',
      id: 100,
      mainChainId: null,
      scopes: new Set(['chain_loyalty:read']),
    },
  ],
  locationIds: new Set([4564, 720441]),
  chainIds: new Set([100]),
  scopes: new Set([
    'locations:read',
    'analytics:read',
    'loyalty:read',
    'chain_loyalty:read',
  ]),
  fetchedAt: 0,
};

const mockedFetch = jest.fn<typeof fetch>();
global.fetch = mockedFetch as typeof fetch;

const ok = (body: unknown, init: ResponseInit = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

const lastRequest = () => {
  const call = mockedFetch.mock.calls.at(-1)!;
  const url = String(call[0]);
  const headers = new Headers(call[1]?.headers);
  return { url, headers };
};

describe('AltegioClient with an Altegio OAuth access token', () => {
  let client: AltegioClient;
  let testDir: string;

  const asOauth = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithContext(
      requestContextFromHeaders({ 'x-altegio-user-token': TOKEN }),
      fn
    );
  const asLegacy = <T>(fn: () => Promise<T>): Promise<T> =>
    runWithContext(
      requestContextFromHeaders({ 'x-altegio-user-token': LEGACY }),
      fn
    );

  beforeEach(() => {
    testDir = join(tmpdir(), `altegio-oauth-client-${Date.now()}`);
    client = new AltegioClient(
      {
        apiBase: 'https://api.alteg.io/api/v1',
        legacyWebBase: 'https://app.alteg.io',
        partnerToken: 'test-partner-token',
      },
      testDir
    );
    mockedFetch.mockReset();
    oauthGrantsCache.clear();
    oauthGrantsCache.set(TOKEN, grants);
  });

  afterEach(async () => {
    oauthGrantsCache.clear();
    await fs
      .rm(testDir, { recursive: true, force: true })
      .catch(() => undefined);
  });

  describe('ERP web part (RND-1974 contract)', () => {
    it('sends the token in the Authorization header and never in user_hash', async () => {
      mockedFetch.mockResolvedValueOnce(ok({ success: true }));

      await asOauth(() =>
        client.requestLegacyWebReport({
          locationId: 4564,
          path: '/analytics_clients/clients_search/4564/',
          query: { page: 1 },
        })
      );

      const { url, headers } = lastRequest();
      expect(url).toBe(
        'https://app.alteg.io/analytics_clients/clients_search/4564/?page=1'
      );
      expect(url).not.toContain('user_hash');
      expect(headers.get('authorization')).toBe(
        `Bearer test-partner-token, User ${TOKEN}`
      );
      expect(headers.get('x-requested-with')).toBe('XMLHttpRequest');
    });

    it('keeps the user_hash query for a legacy users.hash', async () => {
      mockedFetch.mockResolvedValueOnce(ok({ success: true }));

      await asLegacy(() =>
        client.requestLegacyWebReport({
          locationId: 4564,
          path: '/analytics_clients/clients_search/4564/',
        })
      );

      const { url, headers } = lastRequest();
      expect(url).toContain(`user_hash=${LEGACY}`);
      expect(headers.get('authorization')).toBeNull();
    });

    it('reads the interface language with the same header', async () => {
      mockedFetch.mockResolvedValueOnce(
        ok("<script>ms.iso2 = 'pt';</script>", {
          headers: { 'content-type': 'text/html' },
        })
      );

      const language = await asOauth(() =>
        client.getCurrentUserLanguageFromWeb()
      );

      expect(language).toBe('pt');
      const { url, headers } = lastRequest();
      expect(url).toBe('https://app.alteg.io/personal_account');
      expect(headers.get('authorization')).toBe(
        `Bearer test-partner-token, User ${TOKEN}`
      );
    });

    it('forgets the token when the web part refuses it', async () => {
      mockedFetch.mockResolvedValueOnce(
        ok(
          { success: false, meta: { message: 'Authorization required' } },
          { status: 401 }
        )
      );

      await expect(
        asOauth(() =>
          client.requestLegacyWebReport({
            locationId: 4564,
            path: '/analytics_clients/clients_search/4564/',
          })
        )
      ).rejects.toThrow(/401|not accepted|Refresh/);
      expect(oauthGrantsCache.get(TOKEN)).toBeUndefined();
    });
  });

  describe('chains and locations from the grants', () => {
    it('refuses a chain the consent does not cover before any request', async () => {
      await expect(
        asOauth(() => client.request('GET', '/chains/101/loyalty/abonements'))
      ).rejects.toThrow(/chain 101/);
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('lets a granted chain through with the chain id untouched', async () => {
      mockedFetch.mockResolvedValueOnce(ok({ success: true, data: [] }));

      await asOauth(() =>
        runWithRequiredScopes(['chain_loyalty:read'], () =>
          client.request('GET', '/chains/100/loyalty/abonements')
        )
      );

      expect(lastRequest().url).toBe(
        'https://api.alteg.io/api/v1/chains/100/loyalty/abonements'
      );
    });

    it('lists only granted locations from one my=1 call', async () => {
      mockedFetch.mockResolvedValueOnce(
        ok({
          success: true,
          data: [
            { id: 4564, title: 'A' },
            { id: 999, title: 'Not granted' },
            { id: 720441, title: 'B' },
          ],
        })
      );

      const companies = await asOauth(() => client.getCompanies());

      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(lastRequest().url).toBe(
        'https://api.alteg.io/api/v1/locations?my=1'
      );
      expect(companies.map((c) => c.id)).toEqual([4564, 720441]);
    });

    it('refuses a location whose grant lacks the scope the call needs', async () => {
      await expect(
        asOauth(() =>
          runWithRequiredScopes(['analytics:read'], () =>
            client.request('GET', '/locations/720441/analytics/overall')
          )
        )
      ).rejects.toThrow(/location 720441.*analytics:read/);
      expect(mockedFetch).not.toHaveBeenCalled();
    });
  });

  describe('a refused token', () => {
    it('is evicted so the next request is challenged at the door', async () => {
      mockedFetch.mockResolvedValueOnce(
        ok(
          { success: false, meta: { message: 'Authorization required' } },
          { status: 401 }
        )
      );

      await expect(
        asOauth(() => client.request('GET', '/locations/4564'))
      ).rejects.toBeInstanceOf(AuthenticationError);
      expect(oauthGrantsCache.get(TOKEN)).toBeUndefined();
    });

    it('cannot be replaced by a password login on the same connection', async () => {
      const result = await asOauth(() => client.login('a@b.c', 'secret'));

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/OAuth|Altegio sign-in/);
      expect(mockedFetch).not.toHaveBeenCalled();
    });
  });
});
