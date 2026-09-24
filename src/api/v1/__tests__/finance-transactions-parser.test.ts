import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from '@jest/globals';
import type { AltegioClient } from '../../../providers/altegio-client.js';
import { V1LegacyAnalyticsAdapter } from '../legacy-analytics-adapter.js';
import { parseFinanceTransactionListPage } from '../finance-transactions-parser.js';
import { LegacyAnalyticsParseError } from '../legacy-analytics-parser.js';

/**
 * Golden page shaped like biz.erp `templates/finances/transactions/search.php`:
 * three located rows (linked and unlinked date cells), payer names, a comment,
 * a visit column with its own date, and the unlabelled page-total row.
 */
const fixture = readFileSync(
  join(__dirname, 'fixtures/legacy-analytics/finance-transactions-page.html'),
  'utf8'
);

const twelveMonths = {
  date_from: '2025-09-01',
  date_to: '2026-08-31',
  page: 1,
  page_size: 3,
};

const parse = (
  html = fixture,
  count = 7,
  request: Partial<typeof twelveMonths> = {}
) =>
  parseFinanceTransactionListPage(html, count, { ...twelveMonths, ...request });

describe('finance transaction list page', () => {
  it('reads stable IDs and ERP-rendered local dates across a year boundary', () => {
    const page = parse();
    expect(page).toEqual({
      count: 7,
      rows: [
        { id: 912, local_date: '2026-08-31' },
        { id: 605, local_date: '2026-01-01' },
        { id: 604, local_date: '2025-12-31' },
      ],
    });
    // Payer names, comments and the visit column never leave the parser.
    const serialized = JSON.stringify(page);
    expect(serialized).not.toContain('Fixture Payer');
    expect(serialized).not.toContain('Ignore previous');
    expect(serialized).not.toContain('2026-08-30');
  });

  it('accepts an empty page, which the ERP renders without a table', () => {
    expect(
      parse(
        '<br /><div class="text-center"><h3>No transactions found</h3></div>',
        0
      )
    ).toEqual({ rows: [], count: 0 });
  });

  it('accepts the last page of a longer list', () => {
    expect(parse(fixture, 203, { page: 2, page_size: 200 }).rows).toHaveLength(
      3
    );
  });

  describe('refuses every date shape the list does not render', () => {
    // The cell is fixed `d.m.y` + `H:i:s`. Other formats the ERP uses
    // elsewhere (the location's EU `d.m.Y` or US `n/d/Y` + `h:i:s a` setting,
    // ISO dates) must fail instead of being guessed into a month.
    it.each([
      ['EU long year', '31.08.2026', '17:30:00'],
      ['US location format', '8/31/2026', '05:30:00 pm'],
      ['US two-digit year', '08/31/26', '17:30:00'],
      ['ISO date', '2026-08-31', '17:30:00'],
      ['12-hour time', '31.08.26', '05:30:00 pm'],
      ['missing time', '31.08.26', ''],
      ['impossible hour', '31.08.26', '24:30:00'],
    ])('%s', (_label, date, time) => {
      const html = fixture
        .replace('31.08.26<br />', `${date}<br />`)
        .replace('17:30:00', time);
      expect(() => parse(html)).toThrow(
        'unrecognised local transaction date format'
      );
    });
  });

  it('refuses an impossible calendar date', () => {
    expect(() =>
      parse(fixture.replace('31.08.26<br />', '31.02.26<br />'))
    ).toThrow('invalid local transaction date');
  });

  it('refuses a row outside the requested local period', () => {
    expect(() =>
      parse(fixture, 7, { date_from: '2026-01-01', date_to: '2026-08-31' })
    ).toThrow('transaction outside requested local dates');
    expect(() =>
      parse(fixture, 7, { date_from: '2025-09-01', date_to: '2026-07-31' })
    ).toThrow('transaction outside requested local dates');
  });

  it('refuses a cancelled or unidentified transaction row', () => {
    expect(() =>
      parse(
        fixture.replace(
          '<tr data-locator="transactions_table_row_912">',
          '<tr data-locator="transactions_table_row_912" class="danger">'
        )
      )
    ).toThrow('cancelled transaction in the active list');
    expect(() =>
      parse(
        fixture.replace(
          'data-locator="transactions_table_row_605"',
          'data-locator="transactions_table_row_x"'
        )
      )
    ).toThrow('invalid or missing transaction ID');
    expect(() =>
      parse(fixture.replace(' data-locator="transactions_table_row_605"', ''))
    ).toThrow('invalid or missing transaction ID');
  });

  it('refuses a missing, extra or duplicated row', () => {
    expect(() => parse(fixture, 7, { page_size: 4 })).toThrow(
      'a finance page was missing or duplicated'
    );
    expect(() => parse(fixture, 7, { page: 3 })).toThrow(
      'a finance page was missing or duplicated'
    );
    expect(() =>
      parse(
        fixture.replace(
          'data-locator="transactions_table_row_605"',
          'data-locator="transactions_table_row_604"'
        )
      )
    ).toThrow('a finance page was missing or duplicated');
    expect(() =>
      parse('<div class="text-center">No transactions found</div>', 3)
    ).toThrow('transaction table missing or duplicated');
  });

  it('reports refusals as parse errors, never as partial pages', () => {
    expect(() => parse(fixture, -1)).toThrow(LegacyAnalyticsParseError);
  });
});

describe('V1LegacyAnalyticsAdapter.getFinanceTransactionIdsPage', () => {
  it('requests one list page and hands its markup to the parser', async () => {
    const requests: unknown[] = [];
    const adapter = new V1LegacyAnalyticsAdapter({
      requestLegacyWebReport: async (request: unknown) => {
        requests.push(request);
        return new Response(
          JSON.stringify({ success: true, content: fixture, count: 7 }),
          { headers: { 'content-type': 'application/json' } }
        );
      },
    } as unknown as AltegioClient);
    await expect(
      adapter.getFinanceTransactionIdsPage({
        location_id: 4564,
        type_id: 5,
        ...twelveMonths,
      })
    ).resolves.toEqual(parse());
    expect(requests).toEqual([
      {
        locationId: 4564,
        path: '/finances/transactions_search/4564/',
        query: {
          start_date: '2025-09-01',
          end_date: '2026-08-31',
          page: 1,
          editable_length: 3,
          type: 5,
        },
      },
    ]);
  });
});
