/**
 * Full ERP finance pages read for their report table only.
 *
 * The authenticated P&L page inlines the front-end translation bundle before
 * the table, so the page outgrew the 2 MiB bound for any period and every
 * profit and loss and cash-receipts call failed as "too large" (prod,
 * 2026-11: 415 of 427 P&L errors, 183 cash-receipts errors).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AltegioClient,
  LegacyWebRequest,
} from '../../../providers/altegio-client.js';
import { V1LegacyAnalyticsAdapter } from '../legacy-analytics-adapter.js';

const fixture = (name: string): string =>
  readFileSync(join(__dirname, 'fixtures/legacy-analytics', name), 'utf8');

/** The translation bundle the page layout renders ahead of its content. */
const LAYOUT = `<script>window.langs = {${'"shared.label.x":"Translated label",'.repeat(
  120_000
)}};</script>`;

/** A page streamed in 64 KiB chunks, counting the chunks a reader pulled. */
function streamed(page: string): { response: Response; pulled: () => number } {
  const bytes = new TextEncoder().encode(page);
  let offset = 0;
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(bytes.subarray(offset, offset + 65_536));
      offset += 65_536;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=UTF-8' },
    }),
    pulled: () => pulled,
  };
}

function client(responses: Response[]): {
  client: AltegioClient;
  requests: LegacyWebRequest[];
} {
  const requests: LegacyWebRequest[] = [];
  return {
    requests,
    client: {
      requestLegacyWebReport: async (request: LegacyWebRequest) => {
        requests.push(request);
        const response = responses.shift();
        if (!response) throw new Error('missing response');
        return response;
      },
      getLocation: async () => ({
        id: 4564,
        currency_short_title: 'EUR',
        timezone_name: 'Europe/Lisbon',
      }),
    } as unknown as AltegioClient,
  };
}

const page = (table: string) =>
  `<!doctype html><html><head>${LAYOUT}</head><body><div class="page-table table-responsive">${table}</div><script>${LAYOUT}</script></body></html>`;

describe('finance pages larger than the table bound', () => {
  it('reads the P&L table behind a multi-megabyte layout and stops there', async () => {
    const html = page(fixture('profit-loss-en.html'));
    expect(Buffer.byteLength(html)).toBeGreaterThan(8 * 1024 * 1024);
    const source = streamed(html);
    const report = await new V1LegacyAnalyticsAdapter(
      client([source.response]).client
    ).getProfitAndLoss({
      location_id: 4564,
      date_from: '2026-08-01',
      date_to: '2026-08-31',
    });
    expect(report).toMatchObject({
      income_total: 12000,
      expense_total: 7500,
      tracked_operating_result: 4500,
    });
    // The trailing layout is never read.
    expect(source.pulled()).toBeLessThan(
      Math.ceil(Buffer.byteLength(html) / 65_536)
    );
  });

  it('reads the cash-receipts months from the same page', async () => {
    const report = await new V1LegacyAnalyticsAdapter(
      client([streamed(page(fixture('cash-receipts-monthly.html'))).response])
        .client
    ).getPostedIncomeMonths({
      location_id: 4564,
      date_from: '2026-07-01',
      date_to: '2026-08-31',
    });
    expect(report.months.map((month) => month.month)).toEqual([
      '2026-07',
      '2026-08',
    ]);
    expect(report.months[0]?.income_total).toBe(192);
  });

  it('finds a table tag split across stream chunks', async () => {
    const table = fixture('profit-loss-en.html');
    // Put the opening tag across the 64 KiB chunk boundary.
    const html = `${'x'.repeat(65_536 - 10)}${table}`;
    const report = await new V1LegacyAnalyticsAdapter(
      client([streamed(html).response]).client
    ).getProfitAndLoss({
      location_id: 4564,
      date_from: '2026-08-01',
      date_to: '2026-08-31',
    });
    expect(report.tracked_operating_result).toBe(4500);
  });

  it('finds the closing tag split across chunks, past a nested table', async () => {
    const table = fixture('profit-loss-en.html').replace(
      '<td>Rent</td>',
      '<td>Rent<table><tbody><tr><td>note</td></tr></tbody></table></td>'
    );
    // Put the final </table> across the 64 KiB chunk boundary.
    const prefix = 'x'.repeat(65_536 - 4 - table.lastIndexOf('</table>'));
    const html = `${prefix}${table}${LAYOUT}`;
    const source = streamed(html);
    const report = await new V1LegacyAnalyticsAdapter(
      client([source.response]).client
    ).getProfitAndLoss({
      location_id: 4564,
      date_from: '2026-08-01',
      date_to: '2026-08-31',
    });
    expect(report.tracked_operating_result).toBe(4500);
    expect(report.categories.map((c) => c.title)).toContain('Rentnote');
    // Two chunks hold the table; the stream reads at most one ahead.
    expect(source.pulled()).toBeLessThanOrEqual(3);
    expect(source.pulled()).toBeLessThan(
      Math.ceil(Buffer.byteLength(html) / 65_536)
    );
  });

  it('still refuses a report table over the bound', async () => {
    const rows = '<tr><td>Rent</td><td>-1.00</td></tr>'.repeat(80_000);
    await expect(
      new V1LegacyAnalyticsAdapter(
        client([
          streamed(
            page(
              `<table class="table table-report"><tbody>${rows}</tbody></table>`
            )
          ).response,
        ]).client
      ).getProfitAndLoss({
        location_id: 4564,
        date_from: '2026-08-01',
        date_to: '2026-08-31',
      })
    ).rejects.toMatchObject({
      statusCode: 413,
      message: expect.stringMatching(/too large to process safely/),
    });
  });

  it('reports a page without the table as a changed structure', async () => {
    await expect(
      new V1LegacyAnalyticsAdapter(
        client([streamed(page('<p>No report here</p>')).response]).client
      ).getProfitAndLoss({
        location_id: 4564,
        date_from: '2026-08-01',
        date_to: '2026-08-31',
      })
    ).rejects.toThrow(/unexpected structure/);
  });

  it('keeps reading refusals and sign-in answers', async () => {
    const refusal = new Response(
      JSON.stringify({
        success: false,
        data: null,
        meta: { message: 'Insufficient rights', status_code: 403 },
      }),
      { status: 200 }
    );
    await expect(
      new V1LegacyAnalyticsAdapter(client([refusal]).client).getProfitAndLoss({
        location_id: 4564,
        date_from: '2026-08-01',
        date_to: '2026-08-31',
      })
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      new V1LegacyAnalyticsAdapter(
        client([new Response('Need Auth', { status: 200 })]).client
      ).getProfitAndLoss({
        location_id: 4564,
        date_from: '2026-08-01',
        date_to: '2026-08-31',
      })
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});
