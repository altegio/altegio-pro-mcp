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

describe('V1ClientsAdapter.listClientProfiles', () => {
  it('maps the full paged list and its narrower legacy filters', async () => {
    const { api, calls } = adapter([
      [/^\/clients\/4564\?/, 'clients-profiles'],
    ]);
    const result = await api.listClientProfiles({
      location_id: 4564,
      page: 2,
      page_size: 50,
      name: 'Jam',
      client_ids: [66, 67],
      total_paid_min: 100,
      changed_after: '2026-09-01T00:00:00Z',
    });
    const url = new URL(calls[0]!.path, 'https://example.com');
    expect(calls[0]!.method).toBe('GET');
    expect(url.pathname).toBe('/clients/4564');
    expect(url.searchParams.get('count')).toBe('50');
    expect(url.searchParams.get('fullname')).toBe('Jam');
    expect(url.searchParams.getAll('id[]')).toEqual(['66', '67']);
    expect(url.searchParams.get('paid_min')).toBe('100');
    // An absent paid_max reads as 0 upstream and would exclude every payer.
    expect(url.searchParams.get('paid_max')).toBe(
      String(Number.MAX_SAFE_INTEGER)
    );
    expect(url.searchParams.get('changed_after')).toBe('2026-09-01T00:00:00Z');
    expect(result.total_count).toBe(101);
    expect(result.rows[0]).toMatchObject({
      id: 66,
      patronymic: 'A',
      gender: 'male',
      total_spent: 1250.5,
      total_paid: 1200,
      loyalty_card_number: '000123',
      tags: [{ id: 3, title: 'VIP' }],
      custom_fields: { preferred_day: 'Monday' },
    });
  });

  it('sends a lone maximum as is and no paid bounds when none were asked', async () => {
    const { api, calls } = adapter([
      [/^\/clients\/4564\?/, 'clients-profiles'],
    ]);
    await api.listClientProfiles({
      location_id: 4564,
      page: 1,
      page_size: 25,
      total_paid_max: 5000,
    });
    await api.listClientProfiles({ location_id: 4564, page: 1, page_size: 25 });
    const bounded = new URL(calls[0]!.path, 'https://example.com');
    expect(bounded.searchParams.get('paid_min')).toBeNull();
    expect(bounded.searchParams.get('paid_max')).toBe('5000');
    const unbounded = new URL(calls[1]!.path, 'https://example.com');
    expect(unbounded.searchParams.get('paid_min')).toBeNull();
    expect(unbounded.searchParams.get('paid_max')).toBeNull();
  });

  it.each([
    ['a row below total_paid_min', { total_paid_min: 1500 }],
    ['a row above total_paid_max', { total_paid_max: 1000 }],
    [
      'a row outside the requested client ids',
      { client_ids: [67], total_paid_min: 100 },
    ],
  ])('refuses the unfiltered fallback page: %s', async (_label, filters) => {
    // The fixture row is client 66 with total_paid 1200.
    const { api } = adapter([[/^\/clients\//, 'clients-profiles']]);
    await expect(
      api.listClientProfiles({
        location_id: 4564,
        page: 1,
        page_size: 25,
        ...filters,
      })
    ).rejects.toThrow('drops these filters entirely when no client matches');
  });

  it('refuses a paid-filtered row whose paid total is missing', async () => {
    const { api } = adapter([
      [
        /^\/clients\//,
        {
          status: 200,
          body: {
            success: true,
            data: [{ id: 5, name: 'No paid total' }],
            meta: { total_count: 1 },
          },
        },
      ],
    ]);
    await expect(
      api.listClientProfiles({
        location_id: 1,
        page: 1,
        page_size: 25,
        total_paid_min: 1,
      })
    ).rejects.toThrow('No profiles were returned');
  });

  it('rejects malformed pages instead of returning incomplete results', async () => {
    const { api } = adapter([
      [
        /^\/clients\//,
        {
          status: 200,
          body: {
            success: true,
            data: [{ name: 'No id' }],
            meta: { total_count: 1 },
          },
        },
      ],
    ]);
    await expect(
      api.listClientProfiles({ location_id: 1, page: 1, page_size: 25 })
    ).rejects.toThrow('valid id');
  });
});

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
    expect(body.fields).toEqual(['id', 'name']);
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

  it('refuses a search with no authoritative total count', async () => {
    const { api } = adapter([
      [/\/clients\/search/, { status: 200, body: { success: true, data: [] } }],
    ]);
    await expect(
      api.searchClients({
        location_id: 1,
        filters: {},
        match: 'all',
        page: 1,
        page_size: 25,
      })
    ).rejects.toThrow('no valid total count');
  });
});

describe('V1ClientsAdapter.searchClientReport', () => {
  it('requests report fields in one paged search and maps only canonical fields', async () => {
    const { api, calls } = adapter([
      [/\/clients\/search/, 'clients-segment-report'],
    ]);
    const report = await api.searchClientReport({
      location_id: 4564,
      filters: { total_spent: { from: 100 } },
      match: 'all',
      page: 2,
      page_size: 50,
      order_by: 'total_spent',
      order_direction: 'desc',
    });

    expect(calls).toHaveLength(1);
    const body = JSON.parse(calls[0]!.body!);
    expect(body.fields).toEqual([
      'id',
      'name',
      'first_visit_date',
      'last_visit_date',
      'sold_amount',
      'visits_count',
      'discount',
      'deposit_balance',
    ]);
    expect(body.page).toBe(2);
    expect(body.page_size).toBe(50);
    expect(body.order_by).toBe('sold_amount');
    expect(report.total_count).toBe(908);
    expect(report.rows[0]).toEqual({
      id: 2,
      name: 'James Smith',
      first_visit_date: '2025-02-02',
      last_visit_date: '2026-08-07',
      total_spent: 1240.5,
      visit_count: 9,
      discount: 10,
      client_account_balance: 55,
    });
    expect(JSON.stringify(report)).not.toContain('13155550177');
    expect(report.rows[1]?.last_visit_date).toBeNull();
  });
});

describe('V1ClientsAdapter.searchReactivationCandidates', () => {
  it('composes canonical filters with inclusive inactivity and engagement predicates', async () => {
    const { api, calls } = adapter([
      [/\/clients\/search/, 'client-reactivation-search'],
    ]);

    const result = await api.searchReactivationCandidates({
      location_id: 4564,
      last_visit_on_or_before: '2026-06-30',
      inactive_from: '2026-07-01',
      minimum_historical_visits: 3,
      minimum_total_spent: 500,
      filters: {
        total_spent: { from: 100, to: 5000 },
        importance: ['gold'],
        tag_ids: [7],
        mass_notification_allowed: true,
      },
      page: 2,
      page_size: 20,
      include_contacts: false,
    });

    expect(result).toEqual({
      total_count: 12,
      page: 2,
      page_size: 20,
      candidates: [
        {
          client_id: 41,
          client_name: 'Alex',
          first_visit_date: '2024-01-10',
          last_visit_date: '2026-06-30',
          visit_count: 5,
          total_spent: 1250.5,
        },
      ],
    });

    const body = JSON.parse(calls[0]!.body!);
    expect(body).toMatchObject({
      page: 2,
      page_size: 20,
      operation: 'AND',
      order_by: 'id',
      order_by_direction: 'ASC',
      fields: [
        'name',
        'first_visit_date',
        'last_visit_date',
        'visits_count',
        'sold_amount',
      ],
    });
    expect(body.filters).toEqual([
      { type: 'importance', state: { value: [3] } },
      { type: 'category', state: { value: [7] } },
      {
        type: 'is_mass_notification_allowed',
        state: { value: true },
      },
      { type: 'sold_amount', state: { from: 500, to: 5000 } },
      {
        type: 'record',
        state: {
          status: { value: [3] },
          created: { to: '2026-06-30' },
          records_count: { from: 3 },
        },
      },
      {
        type: 'record',
        state: {
          status: { value: [3] },
          created: { from: '2026-07-01' },
          invert: true,
        },
      },
    ]);
  });

  it('requests contacts only when explicitly enabled and preserves an empty result', async () => {
    const { api, calls } = adapter([
      [
        /\/clients\/search/,
        {
          status: 200,
          body: { success: true, data: [], meta: { total_count: 0 } },
        },
      ],
    ]);
    const result = await api.searchReactivationCandidates({
      location_id: 1,
      last_visit_on_or_before: '2026-02-28',
      inactive_from: '2026-03-01',
      minimum_historical_visits: 1,
      filters: {},
      page: 1,
      page_size: 25,
      include_contacts: true,
    });

    expect(result.total_count).toBe(0);
    expect(result.candidates).toEqual([]);
    const body = JSON.parse(calls[0]!.body!);
    expect(body.fields).toEqual(expect.arrayContaining(['phone', 'email']));
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
