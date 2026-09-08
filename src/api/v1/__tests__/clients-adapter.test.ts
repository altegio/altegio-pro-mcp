/**
 * Golden contract tests for the v1 clients adapter.
 *
 * Each endpoint the clients pack calls is replayed from a recorded, sanitized
 * fixture in `./fixtures`. The tests assert both directions: the request body the
 * adapter builds (so the canonical → wire filter translation is pinned) and the
 * canonical DTO it parses back. Fixtures carry no real personal data.
 *
 * `./clients-live.test.ts` records live reference payloads under `fixtures/live/`
 * against the demo location when `ALTEGIO_E2E=1` is set, so a backend change is
 * caught as a fixture diff rather than a silent production failure.
 */
import * as fs from 'fs';
import * as path from 'path';
import { V1ClientsAdapter } from '../clients-adapter.js';
import type { AltegioHttp } from '../../altegio-http.js';

const FIXTURES = path.join(__dirname, 'fixtures');

function fixture(name: string): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')
  );
}

interface Recorded {
  path: string;
  method: string;
  body?: string;
}

function http(
  routes: Array<[RegExp, string | { status: number; body?: unknown }]>
): { http: AltegioHttp; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    http: {
      isAuthenticated: () => true,
      request: async (requestPath, init) => {
        calls.push({
          path: requestPath,
          method: (init?.method as string) ?? 'GET',
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        });
        for (const [pattern, target] of routes) {
          if (!pattern.test(requestPath)) continue;
          if (typeof target === 'string') {
            return new Response(JSON.stringify(fixture(target)), {
              status: 200,
            });
          }
          return new Response(JSON.stringify(target.body ?? {}), {
            status: target.status,
          });
        }
        throw new Error(`no fixture routed for ${requestPath}`);
      },
    },
  };
}

function adapter(
  routes: Array<[RegExp, string | { status: number; body?: unknown }]>
) {
  const transport = http(routes);
  return { api: new V1ClientsAdapter(transport.http), calls: transport.calls };
}

describe('V1ClientsAdapter.searchClients', () => {
  it('sends the translated filter payload and returns the segment', async () => {
    const { api, calls } = adapter([[/\/clients\/search/, 'clients-search']]);
    const segment = await api.searchClients({
      location_id: 4564,
      filters: { importance: ['gold'], total_spent: { from: 50000 } },
      match: 'all',
      page: 1,
      page_size: 25,
      order_by: 'total_spent',
      order_direction: 'desc',
    });

    expect(segment.total_count).toBe(908);
    expect(segment.rows).toHaveLength(2);
    expect(segment.rows[0]).toMatchObject({ id: 2, name: 'James Smith' });

    const body = JSON.parse(calls[0]!.body!);
    expect(calls[0]!.method).toBe('POST');
    expect(body.operation).toBe('AND');
    expect(body.order_by).toBe('sold_amount'); // total_spent → sold_amount
    expect(body.order_by_direction).toBe('DESC');
    expect(body.filters).toEqual([
      { type: 'sold_amount', state: { from: 50000 } },
      { type: 'importance', state: { value: [3] } },
    ]);
  });

  it('reads total_count from meta even when data is empty', async () => {
    const { api } = adapter([
      [
        /\/clients\/search/,
        {
          status: 200,
          body: { success: true, data: [], meta: { total_count: 0 } },
        },
      ],
    ]);
    const segment = await api.searchClients({
      location_id: 1,
      filters: {},
      match: 'all',
      page: 1,
      page_size: 25,
    });
    expect(segment.total_count).toBe(0);
    expect(segment.rows).toEqual([]);
  });
});

describe('V1ClientsAdapter.getClientCard', () => {
  it('maps the legacy card fields to canonical ones', async () => {
    const { api } = adapter([[/\/client\/4564\/16/, 'client-card']]);
    const card = await api.getClientCard({ location_id: 4564, client_id: 16 });

    expect(card).toMatchObject({
      id: 16,
      patronymic: 'A', // middle_name
      gender: 'male', // gender_id 1
      importance: 'gold', // importance_id 3
      loyalty_card_number: '123456789', // card
      total_spent: 71842, // spent
      client_account_balance: -200, // balance
      visit_count: 34, // visits
      sms_birthday_greeting: true, // sms_check 1
      sms_excluded_from_campaigns: false, // sms_not 0
      last_changed_at: '2026-02-01T12:00:00-0500',
    });
    expect(card.tags).toEqual([
      { id: 3, title: 'VIP', color: '#e8d313' },
      { id: 4, title: 'Black list', color: '#0f0f0f' },
    ]);
    expect(card.custom_fields).toEqual({ vip_note: 'prefers mornings' });
  });
});

describe('V1ClientsAdapter.getVisitHistory', () => {
  it('translates the request and flattens records and product sales', async () => {
    const { api, calls } = adapter([
      [/\/clients\/visits\/search/, 'client-visits'],
    ]);
    const history = await api.getVisitHistory({
      location_id: 4564,
      client_id: 16,
      payment_statuses: ['fully_paid', 'partly_paid'],
      outcome: 'arrived',
    });

    const body = JSON.parse(calls[0]!.body!);
    // Every field is required-but-nullable and must be present.
    expect(body).toMatchObject({
      client_id: 16,
      client_phone: null,
      from: null,
      to: null,
      payment_statuses: ['paid_full', 'paid_not_full'],
      attendance: 1, // arrived → 1 in the attendance numbering (not 3)
    });

    // One appointment record + one product sale.
    expect(history.items).toHaveLength(2);
    const record = history.items.find((i) => i.services.length > 0)!;
    expect(record).toMatchObject({
      visit_id: 123,
      outcome: 'arrived', // attendance 1 → arrived
      team_member_name: 'James Smith',
      total_cost: 1000,
      total_paid: 600,
      payment_status: 'partly_paid', // paid_not_full
    });
    const sale = history.items.find((i) => i.products.length > 0)!;
    expect(sale.products[0]).toEqual({ title: 'Shampoo', cost: 500 });

    expect(history.has_more).toBe(true);
    expect(history.next_to).toBe('2026-01-29');
    expect(history.next_from).toBe('2026-01-05');
  });
});

describe('V1ClientsAdapter.lookupClients', () => {
  it('reads the raw array and maps fullname to name', async () => {
    const { api, calls } = adapter([
      [/\/clients\/autocomplete/, 'clients-autocomplete'],
    ]);
    const rows = await api.lookupClients({
      location_id: 4564,
      query: 'James',
      limit: 5,
    });

    expect(calls[0]!.path).toContain('name=James');
    expect(calls[0]!.path).toContain('limit=5');
    expect(rows).toEqual([
      { id: 16, name: 'James Smith', phone: '13155550178' },
      { id: 21, name: 'James Brown', phone: '13155550190' },
    ]);
  });
});
