import {
  parseTeamMemberCapacityHtml,
  parseProductSalesHtml,
  LegacyAnalyticsParseError,
} from '../legacy-analytics-parser.js';

const capacity = `<table class="graphics-table"><tbody><tr><td></td><td><b>Alice</b><small>Trainer</small></td><td>2</td><td>16</td><td>4</td><td>12</td><td><span class="pie">4/16</span>25%</td><td>3</td><td></td></tr><tr class="graph-row" id="graph-row-77"><td colspan="9"></td></tr><tr><th></th><th>Total</th><th>2</th><th>16</th><th>4</th><th>12</th><th><span class="pie">4/16</span>25%</th><th>3</th><th></th></tr></tbody></table>`;
describe('next temporary analytics reports', () => {
  it('uses the stable capacity id and excludes chart text from occupancy', () => {
    const result = parseTeamMemberCapacityHtml({ html: capacity, count: 1 });
    expect(result.rows[0]).toMatchObject({
      team_member_id: 77,
      scheduled_hours: 16,
      booked_hours: 4,
      occupancy_percent: 25,
    });
    expect(result.totals.occupancy_percent).toBe(25);
  });
  it('refuses partial capacity rows', () => {
    expect(() =>
      parseTeamMemberCapacityHtml({
        html: capacity.replace('<td>12</td>', ''),
        count: 1,
      })
    ).toThrow(LegacyAnalyticsParseError);
  });
  it.each(['1,234.56', '1 234,56', '1.234,56'])(
    'preserves product cost withholding and source pagination (%s)',
    (amount) => {
      const html = `<table class="table-report"><thead><tr>${'<th>Column</th>'.repeat(5)}</tr></thead><tbody><tr><td>0001</td><td>00123</td><td><a class="table-sales-analysis__item-link" data-id="42">Cream</a></td><td>2 pcs</td><td>${amount}</td></tr><tr><th>Total</th><td colspan="3">2</td><td>${amount}</td></tr></tbody></table>`;
      const result = parseProductSalesHtml({
        html,
        count: 26,
        page: 2,
        pageSize: 25,
        currency: 'USD',
        groupBy: 'product',
      });
      expect(result.rows[0]).toMatchObject({
        product_id: 42,
        sku: '0001',
        quantity: 2,
        unit: 'pcs',
        total_cost: null,
        total_markup: null,
        revenue: 1234.56,
      });
      expect(result.page).toMatchObject({
        page: 2,
        total_count: 26,
        has_more: false,
      });
    }
  );
});

import {
  parseGroupEventPerformanceHtml,
  parseCashFlowBreakdownHtml,
} from '../legacy-analytics-parser.js';
it('does not treat an empty group-event page as zero dashboard metrics', () => {
  expect(
    parseGroupEventPerformanceHtml({
      html: '',
      count: 0,
      page: 1,
      pageSize: 25,
      currency: 'USD',
      teamMembers: [],
    }).metrics
  ).toBeNull();
});
it('parses both dynamic account and account-type columns without double-counting balance sums', () => {
  const headers =
    '<th class="by-type" rowspan="2">Item</th><th class="by-account" rowspan="2">Item</th>' +
    ['Sep 1', 'Total']
      .map(
        (label) =>
          `<th class="by-type" colspan="3">${label}</th><th class="by-account" colspan="1">${label}</th>`
      )
      .join('') +
    '<th class="by-type" rowspan="2">Total</th><th class="by-account" rowspan="2">Total</th>';
  const row = (name: string, values: number[], aggregate: boolean) =>
    `<tr class="${aggregate ? 'row-aggregated' : ''}"><td class="report-title-cell">${name}</td>${values.map((v) => `<td class="by-type">${v}</td>`).join('')}<td class="by-account">10</td><td class="by-account">10</td><td class="report-all-cell">10</td></tr>`;
  const html = `<table class="table-report"><thead><tr>${headers}</tr><tr class="by-type">${'<td>Cash</td><td>Card</td><td>Total</td>'.repeat(2)}</tr><tr class="by-account"><td>Front desk</td><td>Front desk</td></tr></thead><tbody>${row('Income', [10, 0, 0, 10, 0, 0], true)}${row('Sales', [10, 0, 0, 10, 0, 0], false)}${row('Expenses', [0, 0, 0, 0, 0, 0], true)}${row('Balance', [10, 0, 0, 10, 0, 0], true)}</tbody></table>`;
  const result = parseCashFlowBreakdownHtml({
    html,
    currency: 'USD',
    accountType: 'all',
  });
  expect(result.columns).toHaveLength(6);
  expect(result.rows).toHaveLength(4);
  expect(result.totals.net_movement).toBe(10);
  expect(result.columns[4]).toMatchObject({
    dimension: 'cash_account',
    cash_account_id: null,
    cash_account_title: 'Front desk',
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const fixture = (name: string) =>
  readFileSync(join(__dirname, 'fixtures/legacy-analytics', name), 'utf8');
describe.each(['en', 'ru', 'pt-BR'])(
  'source-shaped %s golden contracts',
  (locale) => {
    it('parses capacity, events, products, categories and two-row cash-flow headers', () => {
      expect(
        parseTeamMemberCapacityHtml({
          html: fixture(`capacity-${locale}.html`),
          count: 1,
        }).rows[0]?.team_member_id
      ).toBe(77);
      const event = parseGroupEventPerformanceHtml({
        html: fixture(`events-${locale}.html`),
        count: 26,
        page: 2,
        pageSize: 25,
        currency: 'USD',
        teamMembers: [{ id: 77, name: 'Alice', position_title: 'Trainer' }],
      });
      expect(event.rows[0]).toMatchObject({
        group_event_id: 10,
        team_member_id: 77,
        team_member_identity_status: 'matched',
        service_id: null,
        appointment_value: 1234.56,
        is_deleted: true,
        creator_display: 'Owner',
      });
      expect(event.metrics?.paid.percent).toBe(20);
      expect(event.page.total_count).toBe(26);
      const base = {
        count: 1,
        page: 1,
        pageSize: 25,
        currency: 'USD',
        groupBy: 'product' as const,
      };
      expect(
        parseProductSalesHtml({
          ...base,
          html: fixture(`products-${locale}-cost.html`),
        }).rows[0]?.total_cost
      ).toBe(1234.56);
      expect(
        parseProductSalesHtml({
          ...base,
          html: fixture(`products-${locale}.html`),
        }).rows[0]?.total_cost
      ).toBeNull();
      const category = parseProductSalesHtml({
        ...base,
        groupBy: 'product_category',
        html: fixture(`product-categories-${locale}.html`),
      });
      expect(category.rows[0]).toMatchObject({
        product_category_id: 5,
        total_cost: null,
        total_markup: null,
        revenue: 1234.56,
      });
      const cash = parseCashFlowBreakdownHtml({
        html: fixture(`cash-flow-${locale}.html`),
        currency: 'USD',
        accountType: 'all',
      });
      expect(cash.rows).toHaveLength(4);
      expect(cash.columns).toHaveLength(6);
      expect(cash.totals.net_movement).toBe(1234.56);
      expect(cash.rows[0]?.amounts).toEqual([
        1234.56, 0, 1234.56, 0, 1234.56, 1234.56,
      ]);
    });
    it('keeps ambiguous event identities null and rejects partial rows and cash-flow columns', () => {
      const event = {
        html: fixture(`events-${locale}.html`),
        count: 1,
        page: 1,
        pageSize: 25,
        currency: 'USD',
        teamMembers: [
          { id: 1, name: 'Alice', position_title: 'Trainer' },
          { id: 2, name: 'Alice', position_title: 'Trainer' },
        ],
      };
      expect(parseGroupEventPerformanceHtml(event).rows[0]).toMatchObject({
        team_member_id: null,
        team_member_identity_status: 'ambiguous',
      });
      expect(
        parseGroupEventPerformanceHtml({ ...event, teamMembers: [] }).rows[0]
      ).toMatchObject({
        team_member_id: null,
        team_member_identity_status: 'unavailable',
      });
      expect(() =>
        parseGroupEventPerformanceHtml({
          ...event,
          html: event.html.replace('data-activity-id="10"', ''),
        })
      ).toThrow(LegacyAnalyticsParseError);
      expect(() =>
        parseCashFlowBreakdownHtml({
          html: fixture(`cash-flow-${locale}.html`).replace(
            'colspan="3"',
            'colspan="4"'
          ),
          currency: 'USD',
          accountType: 'all',
        })
      ).toThrow(LegacyAnalyticsParseError);
    });
  }
);
it('preserves total count on an empty out-of-range event page', () => {
  const result = parseGroupEventPerformanceHtml({
    html: '',
    count: 10,
    page: 3,
    pageSize: 25,
    currency: 'USD',
    teamMembers: [],
  });
  expect(result.page).toMatchObject({
    total_count: 10,
    returned: 0,
    has_more: false,
  });
  expect(result.metrics).toBeNull();
});
it('refuses a missing cash-flow payment-item title instead of dropping the row', () => {
  const html = fixture('cash-flow-en.html').replace(
    '<td class="report-title-cell">Retail sales</td>',
    '<td>Retail sales</td>'
  );
  expect(() =>
    parseCashFlowBreakdownHtml({ html, currency: 'USD', accountType: 'all' })
  ).toThrow(LegacyAnalyticsParseError);
});
it('reads a single cash-account type and an isolated payment item without inventing aggregates', () => {
  const html =
    '<table class="table-report"><thead><tr>' +
    ['Item', 'Day', 'Total', 'Total']
      .map(
        (v) =>
          `<th class="by-type">${v}</th><th class="by-account hidden">${v}</th>`
      )
      .join('') +
    '</tr></thead><tbody><tr><td class="report-title-cell">Rent</td><td class="report-amount-cell">-100</td><td class="report-amount-cell">-100</td><td class="report-all-cell">-100</td></tr></tbody></table>';
  const result = parseCashFlowBreakdownHtml({
    html,
    currency: 'USD',
    accountType: 'non_cash',
    paymentItemId: 7,
  });
  expect(result.rows[0]).toMatchObject({
    payment_item_id: 7,
    amounts: [-100, -100],
    total: -100,
    direction: null,
  });
  expect(result.totals).toEqual({
    inflow: null,
    outflow: null,
    net_movement: null,
  });
});
it('refuses a partially missing page rather than claiming it is complete', () => {
  expect(() =>
    parseProductSalesHtml({
      html: fixture('products-en.html'),
      count: 25,
      page: 1,
      pageSize: 25,
      currency: 'USD',
      groupBy: 'product',
    })
  ).toThrow(LegacyAnalyticsParseError);
});
