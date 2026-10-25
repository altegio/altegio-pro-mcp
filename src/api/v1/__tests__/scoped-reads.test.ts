/**
 * Reads whose URL does not name the location they belong to must still be
 * confined to it: the adapter passes the location explicitly instead of
 * letting the transport guess from the first number in the path.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { MembershipsAdapter } from '../memberships-adapter.js';
import { InventoryAdapter } from '../inventory-adapter.js';
import { FinanceAdapter } from '../finance-adapter.js';
import type { AltegioHttp } from '../../altegio-http.js';
import {
  requestContextFromHeaders,
  runWithContext,
} from '../../../request-context.js';
import {
  oauthGrantsCache,
  type OauthGrants,
} from '../../../auth/oauth-access.js';

type Seen = { path: string; scopedCompany: number | null | undefined };

function fakeHttp(answer: (path: string) => unknown): {
  http: AltegioHttp;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const http: AltegioHttp = {
    request: jest.fn(
      async (
        path: string,
        _init?: RequestInit,
        scopedCompany?: number | null
      ) => {
        seen.push({ path, scopedCompany });
        return new Response(
          JSON.stringify({ success: true, data: answer(path) }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }
        );
      }
    ) as AltegioHttp['request'],
    isAuthenticated: () => true,
  };
  return { http, seen };
}

describe('location-scoped reads without the location in the path', () => {
  it("memberships: the client membership list is confined to the client's location", async () => {
    const { http, seen } = fakeHttp((path) =>
      path.startsWith('/client/') ? { phone: '+1000' } : []
    );
    await new MembershipsAdapter(http).listClientMemberships(4564, 7);

    expect(seen.map((s) => s.path.split('?')[0])).toEqual([
      '/client/4564/7',
      '/loyalty/abonements',
    ]);
    expect(seen[1]!.scopedCompany).toBe(4564);
  });

  it("inventory: document lines are confined to the document's location", async () => {
    const { http, seen } = fakeHttp(() => []);
    await new InventoryAdapter(http).getDocumentLines(4564, 555);

    expect(seen[0]).toEqual({
      path: '/storage_operations/documents/goods_transactions/555',
      scopedCompany: 4564,
    });
  });

  it("finance: document transactions are confined to the document's location", async () => {
    const { http, seen } = fakeHttp(() => []);
    await new FinanceAdapter(http).listDocumentTransactions(4564, 555);

    expect(seen[0]).toEqual({
      path: '/storage_operations/documents/finance_transactions/555',
      scopedCompany: 4564,
    });
  });
});

describe('chain listing under an Altegio OAuth token', () => {
  const TOKEN = 'ag_at_scoped_reads';
  const grants: OauthGrants = {
    userId: 1,
    resources: [
      {
        type: 'chain',
        id: 100,
        mainChainId: null,
        scopes: new Set(['chain_loyalty:read']),
      },
    ],
    locationIds: new Set(),
    chainIds: new Set([100]),
    scopes: new Set(['chain_loyalty:read']),
    fetchedAt: 0,
  };
  const chains = [
    { id: 100, title: 'Granted', companies: [{ id: 1, title: 'A' }] },
    { id: 200, title: 'Other', companies: [{ id: 2, title: 'B' }] },
  ];

  beforeEach(() => oauthGrantsCache.set(TOKEN, grants));
  afterEach(() => oauthGrantsCache.clear());

  it('lists only the chains the consent covers', async () => {
    const { http } = fakeHttp(() => chains);
    const listed = await runWithContext(
      requestContextFromHeaders({ 'x-altegio-user-token': TOKEN }),
      () => new MembershipsAdapter(http).listChains()
    );
    expect(listed.map((c) => c.id)).toEqual([100]);
  });

  it('lists every chain when no consent confines the request', async () => {
    const { http } = fakeHttp(() => chains);
    const listed = await new MembershipsAdapter(http).listChains();
    expect(listed.map((c) => c.id)).toEqual([100, 200]);
  });
});
