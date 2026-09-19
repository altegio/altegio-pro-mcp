import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from '@e965/xlsx';
import {
  LegacyAnalyticsParseError,
  parseClientForecastWorkbook,
  parseClientRetentionHtml,
  parseClientSalesHtml,
  parseLocaleNumber,
  parseSearchEnvelope,
  parseServiceProfitabilityHtml,
  parseTeamMemberSalesHtml,
  parseProfitAndLossHtml,
  parseInventoryTurnoverHtml,
} from '../legacy-analytics-parser.js';

const FIXTURES = join(__dirname, 'fixtures/legacy-analytics');
const fixture = (name: string): string =>
  readFileSync(join(FIXTURES, name), 'utf8');

describe('legacy numeric boundary', () => {
  it.each([
    ['$1,234.56', 1234.56, 'English'],
    ['1\u00a0234,56 ₽', 1234.56, 'Russian'],
    ['R$ 1.234,56', 1234.56, 'Portuguese/Brazilian'],
    ['(1.234,56)', -1234.56, 'accounting negative'],
    ['—', null, 'missing marker'],
  ])('parses %s as %s (%s)', (source, expected, _locale) => {
    expect(parseLocaleNumber(source)).toBe(expected);
  });
});

describe('legacy search envelope', () => {
  it('extracts the HTML and count', () => {
    expect(
      parseSearchEnvelope(
        JSON.stringify({ success: true, content: '<table/>', count: 3 }),
        'test'
      )
    ).toEqual({ html: '<table/>', count: 3 });
  });

  it.each(['Need Auth', '<html>login</html>', '{"success":false}'])(
    'rejects a non-report response without reflecting it: %s',
    (body) => {
      expect(() => parseSearchEnvelope(body, 'test')).toThrow(
        LegacyAnalyticsParseError
      );
    }
  );
});

describe('HTML reports', () => {
  it.each([
    ['profit-loss-en.html', 12000, 7500, 4500],
    ['profit-loss-ru.html', 1200000.5, 750000.25, 450000.25],
    ['profit-loss-pt-br.html', 12000, 7500, 4500],
  ])('parses locale P&L totals from %s', (name, income, expense, result) => {
    const report = parseProfitAndLossHtml({
      html: fixture(name),
      currency: 'USD',
    });
    expect(report).toMatchObject({
      income_total: income,
      expense_total: expense,
      tracked_operating_result: result,
    });
    expect(report.categories).toHaveLength(2);
    expect(report.categories[0]).toMatchObject({
      category_id: 101,
      direction: 'income',
    });
  });

  it.each([
    ['inventory-turnover-en.html', 501, 8.5, 26.5, 'pc'],
    ['inventory-turnover-ru.html', 502, -1.5, 16.75, 'шт'],
    ['inventory-turnover-pt-br.html', 503, 50.25, 50.25, 'un'],
  ])(
    'parses locale inventory quantities from %s',
    (name, productId, currentStock, unitsSold, unit) => {
      const report = parseInventoryTurnoverHtml({
        html: fixture(name),
        count: 1,
        page: 1,
        pageSize: 50,
      });
      expect(report.rows[0]).toMatchObject({
        product_id: productId,
        current_stock: currentStock,
        units_sold: unitsSold,
        unit,
      });
    }
  );

  it('parses English client sales and withholds contacts by default', () => {
    const report = parseClientSalesHtml({
      html: fixture('client-sales-en.html'),
      count: 1,
      page: 1,
      pageSize: 50,
      currency: 'USD',
      includeContacts: false,
    });
    expect(report).toMatchObject({
      currency: 'USD',
      rows: [
        {
          client_id: 101,
          client_name: 'Alice Example',
          revenue: 1234.56,
          revenue_share_percent: 12.5,
          average_check: 411.52,
          visits_count: 3,
        },
      ],
      totals: { revenue: 9876.54 },
      page: { total_count: 1, returned: 1, has_more: false },
    });
    expect(report.rows[0]).not.toHaveProperty('phone');
    expect(report.rows[0]).not.toHaveProperty('email');
  });

  it('parses Russian retention percentages and resolves stable ids', () => {
    const report = parseClientRetentionHtml({
      html: fixture('client-retention-ru.html'),
      count: 1,
      teamMembers: [{ id: 77, name: 'Иван Петров', position_title: 'Стилист' }],
    });
    expect(report).toMatchObject({
      lost_threshold_days: 90,
      rows: [
        {
          team_member_id: 77,
          clients_count: 40,
          new_clients_percent: 25,
          retention_percent: 40,
        },
      ],
      totals: { clients_returned_count: 8, retention_percent: 40 },
    });
  });

  it('parses pt-BR service profitability and graph ids', () => {
    const report = parseServiceProfitabilityHtml({
      html: fixture('service-profitability-pt-br.html'),
      count: 1,
      page: 1,
      pageSize: 100,
      currency: 'BRL',
      groupBy: 'service',
    });
    expect(report).toMatchObject({
      rows: [
        {
          service_id: 501,
          service_category_id: null,
          cash_or_card_revenue: 1234.56,
          contribution_result: 884.56,
          revenue_share_percent: 62.5,
          payments: { memberships: 20, client_accounts: 50 },
        },
      ],
      totals: { contribution_result: 884.56 },
    });
  });

  it('parses team-member sales and matches the canonical id', () => {
    const report = parseTeamMemberSalesHtml({
      html: fixture('team-member-sales-en.html'),
      count: 1,
      currency: 'USD',
      teamMembers: [{ id: 88, name: 'Sam Smith', position_title: 'Barber' }],
    });
    expect(report).toMatchObject({
      rows: [
        {
          team_member_id: 88,
          revenue: 2000,
          services_rendered_count: 15,
          products_count: 4,
          worked_hours: 40.5,
        },
      ],
      totals: { revenue: 2000, worked_hours: 40.5 },
    });
  });

  it('accepts a genuinely empty report but rejects changed markup', () => {
    expect(
      parseClientSalesHtml({
        html: '<table><tbody><tr><td>No results</td></tr></tbody></table>',
        count: 0,
        page: 1,
        pageSize: 50,
        currency: 'EUR',
        includeContacts: false,
      }).rows
    ).toEqual([]);
    expect(() =>
      parseClientSalesHtml({
        html: '<div>new component</div>',
        count: 2,
        page: 1,
        pageSize: 50,
        currency: 'EUR',
        includeContacts: false,
      })
    ).toThrow(/markup may have changed/);
  });

  it('rejects changed profit-and-loss and inventory markup', () => {
    expect(() =>
      parseProfitAndLossHtml({
        html: '<section>new finance component</section>',
        currency: 'USD',
      })
    ).toThrow(/markup may have changed/);
    expect(() =>
      parseInventoryTurnoverHtml({
        html: '<section>new inventory component</section>',
        count: 2,
        page: 1,
        pageSize: 50,
      })
    ).toThrow(/markup may have changed/);
  });

  it('rejects ambiguous team-member identity instead of guessing', () => {
    expect(() =>
      parseClientRetentionHtml({
        html: fixture('client-retention-ru.html'),
        count: 1,
        teamMembers: [
          { id: 1, name: 'Иван Петров', position_title: 'Стилист' },
          { id: 2, name: 'Иван Петров', position_title: 'Стилист' },
        ],
      })
    ).toThrow(/stable id/);
  });

  it('rejects a position mismatch and partial team-member rows', () => {
    expect(() =>
      parseClientRetentionHtml({
        html: fixture('client-retention-ru.html'),
        count: 1,
        teamMembers: [
          { id: 1, name: 'Иван Петров', position_title: 'Administrator' },
        ],
      })
    ).toThrow(/stable id/);

    expect(() =>
      parseTeamMemberSalesHtml({
        html: '<table><tbody><tr class="white-space-nowrap"><td>1</td><td>partial</td></tr></tbody></table>',
        count: 1,
        currency: 'EUR',
        teamMembers: [],
      })
    ).toThrow(/partial team-member row/);
  });
});

function workbookBytes(rows: unknown[][]): Uint8Array {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Forecast');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xls' });
}

describe('client forecast workbook', () => {
  it('normalizes English, Russian and pt-BR rows and paginates', () => {
    const bytes = workbookBytes([
      [
        'Client',
        'Phone',
        'Email',
        'Average check',
        'Predicted visits',
        'Window',
        'Predicted revenue',
        'Return visits',
        'Last visit',
        'Lifetime',
      ],
      [
        'A',
        '1',
        'a@test',
        '$1,234.56',
        '2',
        'This month',
        '$2,000.00',
        '5',
        '2026-08-01',
        '1 year',
      ],
      [
        'Б',
        '2',
        'b@test',
        '1\u00a0234,56 ₽',
        '1',
        'В следующем месяце',
        '2\u00a0000,00 ₽',
        '3',
        '01.08.2026',
        '1 год',
      ],
      [
        'C',
        '3',
        'c@test',
        'R$ 1.234,56',
        '0',
        'Nunca',
        'R$ 0,00',
        '1',
        '01/08/2026',
        '1 ano',
      ],
    ]);
    const first = parseClientForecastWorkbook({
      bytes,
      currency: 'BRL',
      predictionDate: '2026-09-01',
      page: 1,
      pageSize: 2,
      includeContacts: false,
    });
    expect(first.page).toEqual({
      page: 1,
      page_size: 2,
      total_count: 3,
      returned: 2,
      has_more: true,
    });
    expect(first.rows).toMatchObject([
      {
        client_id: null,
        average_check: 1234.56,
        predicted_visit_window: 'this_month',
      },
      {
        average_check: 1234.56,
        predicted_visit_window: 'next_month',
        last_visit_date: '2026-08-01',
      },
    ]);
    expect(first.rows[0]).not.toHaveProperty('phone');

    const second = parseClientForecastWorkbook({
      bytes,
      currency: 'BRL',
      predictionDate: null,
      page: 2,
      pageSize: 2,
      includeContacts: true,
    });
    expect(second.rows[0]).toMatchObject({
      predicted_visit_window: 'not_expected',
      phone: '3',
      email: 'c@test',
    });
  });

  it('rejects malformed workbooks', () => {
    expect(() =>
      parseClientForecastWorkbook({
        bytes: new Uint8Array([1, 2, 3]),
        currency: 'EUR',
        predictionDate: null,
        page: 1,
        pageSize: 50,
        includeContacts: false,
      })
    ).toThrow(/malformed workbook|no sheet|header row/);
  });
});
