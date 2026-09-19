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
