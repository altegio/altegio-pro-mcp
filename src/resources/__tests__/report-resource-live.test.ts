/**
 * A stored report CSV is served from memory, without any call to Altegio. On
 * an OAuth connection that is the one place a revoked consent could still be
 * read from, so the read asks Altegio for a fresh verdict first.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { readAnalyticsResource } from '../analytics.resources.js';
import {
  clearReportStore,
  putReportCsv,
} from '../../capabilities/analytics/report-store.js';
import { oauthGrantsCache, type OauthGrants } from '../../auth/oauth-access.js';
import {
  requestContextFromHeaders,
  runWithContext,
} from '../../request-context.js';
import { AuthenticationError } from '../../utils/errors.js';

const TOKEN = 'ag_at_report_resource';
const grants: OauthGrants = {
  userId: 42,
  resources: [
    {
      type: 'location',
      id: 4564,
      mainChainId: null,
      scopes: new Set(['analytics:read']),
    },
  ],
  locationIds: new Set([4564]),
  chainIds: new Set(),
  scopes: new Set(['analytics:read']),
  fetchedAt: 0,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('reading a stored report on an OAuth connection', () => {
  const nativeFetch = global.fetch;
  let verdict: number;

  beforeEach(() => {
    clearReportStore();
    oauthGrantsCache.clear();
    oauthGrantsCache.set(TOKEN, grants);
    verdict = 200;
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/oauth/accessible-resources')) {
        return verdict === 200
          ? json({
              object: 'list',
              data: [
                {
                  type: 'location',
                  id: 4564,
                  main_chain_id: null,
                  scopes: ['analytics:read'],
                },
              ],
            })
          : json({}, verdict);
      }
      if (url.endsWith('/user/data'))
        return json({ success: true, data: { id: 42 } });
      return nativeFetch(input, init);
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    clearReportStore();
    oauthGrantsCache.clear();
  });

  const asOauth = <T>(fn: () => Promise<T>) =>
    runWithContext(
      requestContextFromHeaders({ 'x-altegio-user-token': TOKEN }),
      fn
    );

  it('serves the CSV after Altegio confirms the token', async () => {
    const stored = await asOauth(async () =>
      putReportCsv({
        location_id: 4564,
        name: 'sales',
        csv: 'a,b\n1,2',
        row_count: 1,
      })
    );
    const read = await asOauth(() => readAnalyticsResource(stored.uri));
    expect(read?.contents[0]?.text).toBe('a,b\n1,2');
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([url]) =>
        String(url).includes('/oauth/accessible-resources')
      )
    ).toBe(true);
  });

  it('refuses the CSV once Altegio refuses the token', async () => {
    const stored = await asOauth(async () =>
      putReportCsv({
        location_id: 4564,
        name: 'sales',
        csv: 'a,b\n1,2',
        row_count: 1,
      })
    );
    verdict = 401;
    await expect(
      asOauth(() => readAnalyticsResource(stored.uri))
    ).rejects.toBeInstanceOf(AuthenticationError);
  });
});
