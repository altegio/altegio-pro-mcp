import { describe, expect, it } from '@jest/globals';
import type { AltegioClient } from '../../../providers/altegio-client.js';
import { V1LegacyAnalyticsAdapter } from '../legacy-analytics-adapter.js';

function adapter(html: string, count: number): V1LegacyAnalyticsAdapter {
  return new V1LegacyAnalyticsAdapter({
    requestLegacyWebReport: async () =>
      new Response(JSON.stringify({ success: true, content: html, count }), {
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as AltegioClient);
}

const input = {
  location_id: 1,
  date_from: '2026-08-01',
  date_to: '2026-08-31',
  type_id: 5,
  page: 1,
  page_size: 2,
};

describe('finance list source parser', () => {
  it('reads stable IDs and rendered local dates without payer names', async () => {
    const report = adapter(
      '<table><tr data-locator="transactions_table_row_42"><td class="transactions-table__date">31.08.26 17:30:00</td><td>untrusted name</td></tr><tr data-locator="transactions_table_row_41"><td class="transactions-table__date">01.08.26 09:00:00</td></tr></table>',
      2
    );
    await expect(report.getFinanceTransactionIdsPage(input)).resolves.toEqual({
      count: 2,
      rows: [
        { id: 42, local_date: '2026-08-31' },
        { id: 41, local_date: '2026-08-01' },
      ],
    });
  });

  it('refuses a missing page row', async () => {
    const report = adapter(
      '<tr data-locator="transactions_table_row_42"><td class="transactions-table__date">31.08.26</td></tr>',
      2
    );
    await expect(report.getFinanceTransactionIdsPage(input)).rejects.toThrow(
      'missing or duplicated'
    );
  });
});
