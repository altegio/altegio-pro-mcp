import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from '@e965/xlsx';
import type {
  AltegioClient,
  LegacyWebRequest,
} from '../../../providers/altegio-client.js';
import { V1LegacyAnalyticsAdapter } from '../legacy-analytics-adapter.js';

const FIXTURES = join(__dirname, 'fixtures/legacy-analytics');
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), 'utf8');

function searchResponse(html: string, count = 1): Response {
  return new Response(JSON.stringify({ success: true, content: html, count }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function forecastResponse(): Response {
  const sheet = XLSX.utils.aoa_to_sheet([
    [
      'Client',
      'Phone',
      'Email',
      'Average',
      'Visits',
      'Window',
      'Revenue',
      'Frequency',
      'Last visit',
      'Lifetime',
    ],
    ['A', '', '', 100, 1, 'This month', 200, 2, '2026-08-01', '1 year'],
  ]);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Forecast');
  const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xls' });
  return new Response(bytes, {
    status: 200,
    headers: { 'content-type': 'application/vnd.ms-excel' },
  });
}

function fakeClient(responses: Response[]): {
  client: AltegioClient;
  requests: LegacyWebRequest[];
} {
  const requests: LegacyWebRequest[] = [];
  const queue = [...responses];
  const client = {
    requestLegacyWebReport: async (request: LegacyWebRequest) => {
      requests.push(request);
      const response = queue.shift();
      if (!response) throw new Error('missing response');
      return response;
    },
    getLocation: async () => ({ id: 4564, currency_short_title: 'EUR' }),
    getStaff: async () => [
      { id: 77, name: 'Иван Петров', specialization: 'Стилист' },
      { id: 88, name: 'Sam Smith', specialization: 'Barber' },
    ],
  } as unknown as AltegioClient;
  return { client, requests };
}

describe('temporary legacy analytics adapter wire mapping', () => {
  it('maps the canonical period to the authenticated P&L page', async () => {
    const { client, requests } = fakeClient([
      new Response(fixture('profit-loss-en.html'), { status: 200 }),
    ]);
    const report = await new V1LegacyAnalyticsAdapter(client).getProfitAndLoss({
      location_id: 4564,
      date_from: '2026-08-01',
      date_to: '2026-08-31',
    });
    expect(requests[0]).toEqual({
      locationId: 4564,
      path: '/finances_reports/annual_report/4564/',
      query: { date_from: '2026-08-01', date_to: '2026-08-31' },
    });
    expect(report.tracked_operating_result).toBe(4500);
  });

  it('maps bounded inventory turnover filters and pagination', async () => {
    const { client, requests } = fakeClient([
      searchResponse(fixture('inventory-turnover-en.html')),
    ]);
    const report = await new V1LegacyAnalyticsAdapter(
      client
    ).getInventoryTurnover({
      location_id: 4564,
      date_from: '2026-08-01',
      date_to: '2026-08-31',
      page: 2,
      page_size: 50,
      inventory_id: 11,
      product_category_id: 22,
      supplier_id: 33,
    });
    expect(requests[0]).toMatchObject({
      path: '/storages/turnover/search/4564/',
      query: {
        storage_id: 11,
        category_id: 22,
        supplier_id: 33,
        page: 2,
        editable_length: 50,
      },
    });
    expect(report.rows[0]?.product_id).toBe(501);
  });

  it('maps canonical client-sales pagination to the legacy query', async () => {
    const { client, requests } = fakeClient([
      searchResponse(fixture('client-sales-en.html')),
    ]);
    const report = await new V1LegacyAnalyticsAdapter(client).getClientSales({
      location_id: 4564,
      date_from: '2026-08-01',
      date_to: '2026-08-31',
      page: 2,
      page_size: 50,
      include_contacts: false,
    });
    expect(requests).toEqual([
      {
        locationId: 4564,
        path: '/analytics_clients/clients_search/4564/',
        query: {
          start_date: '2026-08-01',
          end_date: '2026-08-31',
          page: 2,
          editable_length: 50,
        },
      },
    ]);
    expect(report.currency).toBe('EUR');
  });

  it('maps retention service and resolves team-member ids', async () => {
    const { client, requests } = fakeClient([
      searchResponse(fixture('client-retention-ru.html')),
    ]);
    const report = await new V1LegacyAnalyticsAdapter(
      client
    ).getClientRetention({
      location_id: 4564,
      date_from: '2026-08-01',
      date_to: '2026-08-31',
      service_id: 90,
    });
    expect(requests[0]).toMatchObject({
      path: '/analytics_retention/retention_search/4564/',
      query: { service_id: 90 },
    });
    expect(report.rows[0]!.team_member_id).toBe(77);
  });

  it('maps grouping and canonical service filters', async () => {
    const { client, requests } = fakeClient([
      searchResponse(fixture('service-profitability-pt-br.html')),
    ]);
    await new V1LegacyAnalyticsAdapter(client).getServiceProfitability({
      location_id: 4564,
      date_from: '2026-08-01',
      date_to: '2026-08-31',
      page: 1,
      page_size: 100,
      group_by: 'service_category',
      team_member_id: 77,
      service_category_id: 9,
    });
    expect(requests[0]).toMatchObject({
      path: '/analytics_services/services_search/4564/',
      query: { master_id: 77, category_id: 9, detailing: 1 },
    });
  });

  it('maps service, product and position arrays only at the wire boundary', async () => {
    const { client, requests } = fakeClient([
      searchResponse(fixture('team-member-sales-en.html')),
    ]);
    await new V1LegacyAnalyticsAdapter(client).getTeamMemberSales({
      location_id: 4564,
      date_from: '2026-08-01',
      date_to: '2026-08-31',
      service_ids: [1],
      service_category_ids: [2],
      product_ids: [3],
      product_category_ids: [4],
      position_ids: [5],
    });
    expect(requests[0]).toMatchObject({
      path: '/analytics_masters/masters_search/4564/',
      query: {
        'services_ids[]': [1],
        'groups_ids[]': [2],
        'goods_ids[]': [3],
        'goods_categories_ids[]': [4],
        'position_ids[]': [5],
      },
    });
  });

  it('reads the bounded forecast workbook and keeps contacts opt-in', async () => {
    const { client, requests } = fakeClient([forecastResponse()]);
    const report = await new V1LegacyAnalyticsAdapter(client).getClientForecast(
      {
        location_id: 4564,
        prediction_date: '2026-09-01',
        page: 1,
        page_size: 50,
        include_contacts: false,
      }
    );
    expect(requests[0]).toEqual({
      locationId: 4564,
      path: '/analytics/rfm/4564/excel/clients',
      query: { prediction_date: '2026-09-01' },
    });
    expect(report.rows[0]).not.toHaveProperty('phone');
  });

  it('surfaces a forecast permission envelope instead of parsing it as a workbook', async () => {
    const response = new Response(
      JSON.stringify({
        success: false,
        data: null,
        meta: { message: 'upstream detail is not reflected', status_code: 403 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
    const { client } = fakeClient([response]);
    await expect(
      new V1LegacyAnalyticsAdapter(client).getClientForecast({
        location_id: 4564,
        page: 1,
        page_size: 50,
        include_contacts: false,
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('detects Need Auth and oversized responses canonically', async () => {
    const auth = fakeClient([
      new Response('Need Auth', { status: 200, headers: { need_auth: '1' } }),
    ]);
    await expect(
      new V1LegacyAnalyticsAdapter(auth.client).getClientSales({
        location_id: 4564,
        date_from: '2026-08-01',
        date_to: '2026-08-31',
        page: 1,
        page_size: 50,
        include_contacts: false,
      })
    ).rejects.toThrow(/authentication was not accepted/);

    const large = fakeClient([
      new Response('{}', {
        status: 200,
        headers: { 'content-length': String(3 * 1024 * 1024) },
      }),
    ]);
    await expect(
      new V1LegacyAnalyticsAdapter(large.client).getClientSales({
        location_id: 4564,
        date_from: '2026-08-01',
        date_to: '2026-08-31',
        page: 1,
        page_size: 50,
        include_contacts: false,
      })
    ).rejects.toThrow(/too large/);

    const unannounced = fakeClient([
      new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 }),
    ]);
    await expect(
      new V1LegacyAnalyticsAdapter(unannounced.client).getClientSales({
        location_id: 4564,
        date_from: '2026-08-01',
        date_to: '2026-08-31',
        page: 1,
        page_size: 50,
        include_contacts: false,
      })
    ).rejects.toThrow(/too large/);
  });
});

const nextPeriod = {
  location_id: 4564,
  date_from: '2026-09-01',
  date_to: '2026-09-19',
};
describe('next temporary report adapter contracts', () => {
  it('maps every search route and its complete filter vocabulary', async () => {
    const { client, requests } = fakeClient([
      searchResponse(fixture('capacity-en.html')),
      searchResponse(fixture('products-en-cost.html'), 26),
      searchResponse(fixture('product-categories-en.html')),
      searchResponse(fixture('cash-flow-en.html')),
    ]);
    const adapter = new V1LegacyAnalyticsAdapter(client);
    await adapter.getTeamMemberCapacity(nextPeriod);
    await adapter.getProductSales({
      ...nextPeriod,
      page: 2,
      page_size: 25,
      group_by: 'product',
      product_category_id: 5,
      team_member_id: 77,
      supplier_id: 0,
    });
    await adapter.getProductSales({
      ...nextPeriod,
      page: 1,
      page_size: 25,
      group_by: 'product_category',
    });
    await adapter.getCashFlowBreakdown({
      ...nextPeriod,
      cash_account_ids: [1, 2],
      team_member_id: 77,
      supplier_id: 9,
      service_ids: [3],
      product_ids: [4],
      service_category_ids: [5],
      product_category_ids: [6],
      include_zero_movement_rows: false,
    });
    expect(requests.map((r) => r.path)).toEqual([
      '/analytics_workload/workload_search/4564/',
      '/storages/sales_analysis/search/4564/',
      '/storages/sales_analysis/categories_search/4564/',
      '/finances_reports/account_period_search/4564/',
    ]);
    expect(requests[1]?.query).toMatchObject({
      page: 2,
      editable_length: 25,
      category_id: 5,
      employee_id: 77,
      supplier_id: 0,
    });
    expect(requests[3]?.query).toMatchObject({
      'accounts_ids[]': [1, 2],
      master_id: 77,
      supplier_id: 9,
      'services_ids[]': [3],
      'goods_ids[]': [4],
      'groups_ids[]': [5],
      'goods_categories_ids[]': [6],
      account_type: 2,
      movements_funds: 1,
    });
  });
  it.each([
    ['all', 0],
    ['active', 2],
    ['deleted', 1],
  ] as const)(
    'maps event status %s and canonical filters',
    async (status, wire) => {
      const { client, requests } = fakeClient([
        searchResponse(fixture('events-en.html')),
      ]);
      jest
        .spyOn(client, 'getStaff')
        .mockResolvedValue([
          { id: 77, name: 'Alice', specialization: 'Trainer' },
        ] as never);
      const report = await new V1LegacyAnalyticsAdapter(
        client
      ).getGroupEventPerformance({
        ...nextPeriod,
        page: 1,
        page_size: 25,
        team_member_id: 77,
        service_id: 2,
        service_category_id: 3,
        label_id: 4,
        status,
      });
      expect(report.rows[0]?.group_event_id).toBe(10);
      expect(requests[0]).toMatchObject({
        path: '/dashboard/activities/4564/search',
        query: {
          master: 77,
          service: 2,
          service_category: 3,
          category: 4,
          removed: wire,
        },
      });
    }
  );
  it('uses the bounded workbook reader and exact reactivation filters', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      [
        'Name',
        'Phone',
        'Email',
        'Registration',
        'Visit',
        'Paid',
        'Balance',
        'Visits',
      ],
      ['A', '', '', '2020-01-01', '2026-01-01', 100, 0, ''],
    ]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Clients');
    const { client, requests } = fakeClient([
      new Response(XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' })),
    ]);
    const report = await new V1LegacyAnalyticsAdapter(
      client
    ).getClientReactivationCandidates({
      ...nextPeriod,
      loyalty_program_id: 2,
      page: 1,
      page_size: 25,
      include_contacts: false,
    });
    expect(report.rows[0]?.client_id).toBeNull();
    expect(requests[0]).toEqual({
      locationId: 4564,
      path: '/analytics/loyalty_programs/4564/excel/lost_clients',
      query: {
        loyalty_program_id: 2,
        date_from: '2026-09-01',
        date_to: '2026-09-19',
      },
    });
  });
  it.each(['Need Auth', '{"success":false,"error":"user_hash=secret"}'])(
    'does not reflect authentication or permission response content',
    async (body) => {
      const { client } = fakeClient([new Response(body)]);
      await expect(
        new V1LegacyAnalyticsAdapter(client).getTeamMemberCapacity(nextPeriod)
      ).rejects.not.toThrow('user_hash');
    }
  );
  it('caps reactivation exports before parsing and rejects body-level authentication', async () => {
    for (const response of [
      new Response('x', {
        headers: { 'content-length': String(13 * 1024 * 1024) },
      }),
      new Response('Need Auth'),
    ]) {
      const { client } = fakeClient([response]);
      await expect(
        new V1LegacyAnalyticsAdapter(client).getClientReactivationCandidates({
          ...nextPeriod,
          loyalty_program_id: 2,
          page: 1,
          page_size: 25,
          include_contacts: false,
        })
      ).rejects.toThrow();
    }
  });
});
it('recognizes the cash-flow permission envelope without reflecting source diagnostics', async () => {
  const { client } = fakeClient([
    new Response(JSON.stringify({ error: 'user_hash=secret' })),
  ]);
  await expect(
    new V1LegacyAnalyticsAdapter(client).getCashFlowBreakdown(nextPeriod)
  ).rejects.toMatchObject({ statusCode: 403 });
});
it('keeps nonzero non-cash-only items when zero movement rows are excluded', async () => {
  const html = fixture('cash-flow-en.html').replace(
    /<td class="by-type report-amount-cell">1,234.56<\/td><td class="by-type report-amount-cell">0<\/td>/g,
    '<td class="by-type report-amount-cell">0</td><td class="by-type report-amount-cell">1,234.56</td>'
  );
  const { client, requests } = fakeClient([searchResponse(html)]);
  const report = await new V1LegacyAnalyticsAdapter(
    client
  ).getCashFlowBreakdown({ ...nextPeriod, include_zero_movement_rows: false });
  expect(
    report.rows.find((row) => row.kind === 'payment_item')?.amounts[1]
  ).toBe(1234.56);
  expect(requests[0]?.query?.movements_funds).toBe(1);
});
