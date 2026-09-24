import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AltegioClient,
  LegacyWebRequest,
} from '../../../providers/altegio-client.js';
import { getClientCashReceipts } from '../cash-receipts.js';

const html = readFileSync(
  join(
    __dirname,
    '../../../api/v1/__tests__/fixtures/legacy-analytics/cash-receipts-monthly.html'
  ),
  'utf8'
);
const calls: LegacyWebRequest[] = [];
let rights: Record<string, unknown>;
const client = {
  getCompanies: async () => [{ id: 4564, timezone_name: 'America/Sao_Paulo' }],
  getLocation: async () => ({
    id: 4564,
    currency_short_title: 'BRL',
    timezone_name: 'America/Sao_Paulo',
  }),
  request: async () => ({ data: { finances: rights } }),
  requestLegacyWebReport: async (request: LegacyWebRequest) => {
    calls.push(request);
    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  },
} as unknown as AltegioClient;

beforeEach(() => {
  calls.length = 0;
  rights = {
    finances_year_report_access: true,
    finances_accounts_limited_access: false,
    finances_accounts_ids: [],
  };
});

describe('client cash receipts', () => {
  it('reconciles components while separating custom income from client cash', async () => {
    const result = await getClientCashReceipts(client, {
      location_id: 4564,
      date_from: '2026-07-01',
      date_to: '2026-08-31',
    });
    expect(calls).toEqual([
      {
        locationId: 4564,
        path: '/finances_reports/annual_report/4564/',
        query: { date_from: '2026-07-01', date_to: '2026-08-31' },
      },
    ]);
    expect(result.structuredContent).toMatchObject({
      period: { timezone: 'America/Sao_Paulo' },
      currency: 'BRL',
      months: [
        {
          streams: { services: 100, products: 20, client_account_topups: 50 },
          classified_client_cash_net: 185,
          unclassified_posted_income_net: 7,
          posted_income_net: 192,
        },
        {
          streams: { services: -20, products: 30, client_account_topups: 0 },
          classified_client_cash_net: 24,
          unclassified_posted_income_net: -3,
          posted_income_net: 21,
        },
      ],
      totals: {
        classified_client_cash_net: 209,
        unclassified_posted_income_net: 4,
        posted_income_net: 213,
      },
    });
    expect(JSON.stringify(result.structuredContent)).not.toMatch(
      /phone|email|client_name/
    );
  });

  it.each([
    ['2026-07-02', '2026-08-31', 'complete local calendar months'],
    ['2026-07-01', '2026-08-30', 'complete local calendar months'],
    ['2026-01-01', '2027-01-31', 'at most 12 complete calendar months'],
  ])(
    'rejects the partial or oversized window %s..%s',
    async (date_from, date_to, reason) => {
      await expect(
        getClientCashReceipts(client, {
          location_id: 4564,
          date_from,
          date_to,
        })
      ).rejects.toThrow(reason);
      expect(calls).toHaveLength(0);
    }
  );

  it('points to payer cohorts for stable client ids', async () => {
    const result = await getClientCashReceipts(client, {
      location_id: 4564,
      date_from: '2026-07-01',
      date_to: '2026-08-31',
    });
    expect(
      result.structuredContent.completeness.limitations.join(' ')
    ).toContain('analytics_get_client_payer_cohorts');
  });

  it('refuses an empty account restriction before opening the legacy report', async () => {
    rights = {
      finances_year_report_access: true,
      finances_accounts_limited_access: true,
      finances_accounts_ids: [],
    };
    await expect(
      getClientCashReceipts(client, {
        location_id: 4564,
        date_from: '2026-07-01',
        date_to: '2026-08-31',
      })
    ).rejects.toThrow('No authorized finance accounts');
    expect(calls).toHaveLength(0);
  });
});
