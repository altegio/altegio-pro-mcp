import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCashReceiptsHtml } from '../cash-receipts-parser.js';
import { LegacyAnalyticsParseError } from '../legacy-analytics-parser.js';

const fixture = readFileSync(
  join(__dirname, 'fixtures/legacy-analytics/cash-receipts-monthly.html'),
  'utf8'
);
const parse = (html = fixture) =>
  parseCashReceiptsHtml(html, '2026-07-01', '2026-08-31');

describe('monthly cash receipt ledger', () => {
  it('reads signed posted income, including top-ups and reversals, by local month', () => {
    expect(parse()).toEqual([
      {
        month: '2026-07',
        income_total: 192,
        categories: [
          { category_id: 5, amount: 100 },
          { category_id: 7, amount: 20 },
          { category_id: 10, amount: 50 },
          { category_id: 8, amount: 10 },
          { category_id: 6, amount: 5 },
          { category_id: 12, amount: 0 },
          { category_id: 13, amount: 0 },
          { category_id: 101, amount: 7 },
        ],
      },
      {
        month: '2026-08',
        income_total: 21,
        categories: [
          { category_id: 5, amount: -20 },
          { category_id: 7, amount: 30 },
          { category_id: 10, amount: 0 },
          { category_id: 8, amount: 2 },
          { category_id: 6, amount: 0 },
          { category_id: 12, amount: 11 },
          { category_id: 13, amount: 1 },
          { category_id: 101, amount: -3 },
        ],
      },
    ]);
  });

  it('refuses a changed month boundary or unreconciled income', () => {
    expect(() =>
      parse(fixture.replace('31.08.2026&type=7', '30.08.2026&type=7'))
    ).toThrow(LegacyAnalyticsParseError);
    expect(() => parse(fixture.replace('192.00', '193.00'))).toThrow(
      LegacyAnalyticsParseError
    );
  });

  it('refuses a partial or duplicated source row', () => {
    expect(() => parse(fixture.replace('<td>0</td>', ''))).toThrow(
      LegacyAnalyticsParseError
    );
    expect(() => parse(fixture.replace('type=101', 'type=5'))).toThrow(
      LegacyAnalyticsParseError
    );
  });
});
