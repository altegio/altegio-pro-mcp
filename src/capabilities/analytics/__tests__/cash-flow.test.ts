/**
 * Cash flow and the exact-day ledger: the source read in bounded pages, the
 * day past the period that completes its last day, and the column grouping
 * that keeps an answer inside its budget (prod, 2026-10/11: monthly and
 * six-month windows refused as oversized; weekly windows 750 UAH short).
 */
import type {
  AltegioClient,
  LegacyWebRequest,
} from '../../../providers/altegio-client.js';
import {
  V1LegacyAnalyticsAdapter,
  isWholeMonths,
} from '../../../api/v1/legacy-analytics-adapter.js';
import {
  cashFlowPage,
  cashFlowResponse,
  dayLabels,
} from '../../../api/v1/__tests__/helpers/cash-flow-page.js';
import {
  CASH_FLOW_JSON_BUDGET,
  addDays,
  buildCashFlowReport,
  daysBetween,
  type CashFlowDays,
} from '../cash-flow.js';
import { getCashFlowBreakdown } from '../legacy-use-cases.js';
import { clearTimezoneCache } from '../location-timezone.js';

/** Signed cents a location posted on a day, per account type and account. */
interface Day {
  service: [number, number];
  rent: [number, number];
  accounts: [number, number];
}

/** A deterministic month of money: card service income, cash rent. */
function ledger(day: string): Day {
  const n = Number(day.slice(8, 10));
  return {
    service: [n * 100, n * 1000],
    rent: [day.endsWith('-15') ? -50_000 : 0, 0],
    accounts: [n * 100 + (day.endsWith('-15') ? -50_000 : 0), n * 1000],
  };
}

function page(from: string, to: string, type: number): string {
  const count = daysBetween(from, to);
  const days = Array.from({ length: count }, (_, i) =>
    ledger(addDays(from, i))
  );
  const pick = (values: [number, number]): number[] =>
    type === 0
      ? [values[0] / 100]
      : type === 1
        ? [values[1] / 100]
        : [values[0] / 100, values[1] / 100];
  const add = (a: number[], b: number[]) => a.map((v, i) => v + b[i]!);
  const income = days.map((d) => pick(d.service));
  const expenses = days.map((d) => pick(d.rent));
  const balance = days.map((_day, i) => add(income[i]!, expenses[i]!));
  const accounts = (select: (d: Day) => [number, number]) =>
    days.map((d) => select(d).map((v) => v / 100));
  return cashFlowPage({
    labels: dayLabels(from, count),
    oneType: type !== 2,
    accounts: type === 2 ? ['Front desk', 'Card terminal'] : [],
    rows: [
      {
        title: 'Income',
        aggregate: true,
        days: income,
        accounts: accounts((d) => [d.service[0], d.service[1]]),
      },
      {
        title: 'Service sales',
        days: income,
        accounts: accounts((d) => [d.service[0], d.service[1]]),
      },
      { title: 'Gift cards', days: days.map(() => pick([0, 0])) },
      {
        title: 'Expenses',
        aggregate: true,
        days: expenses,
        accounts: accounts((d) => [d.rent[0], 0]),
      },
      {
        title: 'Rent',
        days: expenses,
        accounts: accounts((d) => [d.rent[0], 0]),
      },
      {
        title: 'Balance',
        aggregate: true,
        days: balance,
        accounts: accounts((d) => d.accounts),
      },
    ],
  });
}

function client(
  options: { tooLarge?: (from: string, to: string) => boolean } = {}
) {
  const requests: LegacyWebRequest[] = [];
  const fake = {
    requestLegacyWebReport: async (request: LegacyWebRequest) => {
      requests.push(request);
      const query = request.query as Record<string, unknown>;
      const from = String(query.start_date);
      const to = String(query.end_date);
      if (options.tooLarge?.(from, to))
        return new Response('{}', {
          status: 200,
          headers: { 'content-length': String(3 * 1024 * 1024) },
        });
      return cashFlowResponse(page(from, to, Number(query.account_type)));
    },
    getLocation: async () => ({
      id: 4564,
      currency_short_title: 'UAH',
      timezone_name: 'Europe/Kyiv',
    }),
    getCompanies: async () => [
      { id: 4564, title: 'Demo', timezone_name: 'Europe/Kyiv' },
    ],
  } as unknown as AltegioClient;
  return { client: fake, requests };
}

function expectedCents(
  from: string,
  to: string,
  pick: (d: Day) => number
): number {
  let total = 0;
  for (let day = from; day <= to; day = addDays(day, 1))
    total += pick(ledger(day));
  return total;
}

beforeEach(() => clearTimezoneCache());

describe('cash-flow source reads', () => {
  it('reads one day past the period and drops it, so the last day is complete', async () => {
    const { client: fake, requests } = client();
    const report = await new V1LegacyAnalyticsAdapter(
      fake
    ).getCashFlowBreakdown({
      location_id: 4564,
      date_from: '2026-09-01',
      date_to: '2026-09-07',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.query).toMatchObject({
      start_date: '2026-09-01',
      end_date: '2026-09-08',
      account_type: 2,
      movements_funds: 1,
    });
    expect(report.granularity).toBe('day');
    const days = report.columns.filter(
      (c) => c.dimension === 'cash_account_type' && c.period_kind === 'day'
    );
    expect(days.map((c) => c.date_from)).toEqual(
      Array.from({ length: 7 }, (_, i) => addDays('2026-09-01', i)).flatMap(
        (d) => [d, d]
      )
    );
    const income =
      expectedCents(
        '2026-09-01',
        '2026-09-07',
        (d) => d.service[0] + d.service[1]
      ) / 100;
    expect(report.totals.inflow).toBe(income);
    expect(
      report.rows.find((r) => r.payment_item_title === 'Service sales')?.total
    ).toBe(income);
  });

  it('sums weekly windows to the month exactly', async () => {
    const adapter = new V1LegacyAnalyticsAdapter(client().client);
    const weeks = [
      ['2026-09-01', '2026-09-07'],
      ['2026-09-08', '2026-09-14'],
      ['2026-09-15', '2026-09-21'],
      ['2026-09-22', '2026-09-28'],
      ['2026-09-29', '2026-09-30'],
    ] as const;
    let weekly = 0;
    for (const [from, to] of weeks)
      weekly += Math.round(
        (
          await adapter.getCashFlowBreakdown({
            location_id: 4564,
            date_from: from,
            date_to: to,
          })
        ).totals.inflow! * 100
      );
    const month = await adapter.getCashFlowBreakdown({
      location_id: 4564,
      date_from: '2026-09-01',
      date_to: '2026-09-30',
    });
    expect(weekly).toBe(Math.round(month.totals.inflow! * 100));
    expect(weekly).toBe(
      expectedCents(
        '2026-09-01',
        '2026-09-30',
        (d) => d.service[0] + d.service[1]
      )
    );
  });

  it('reads six months across all account types in monthly pages and groups the columns to fit', async () => {
    const { client: fake, requests } = client();
    const report = await new V1LegacyAnalyticsAdapter(
      fake
    ).getCashFlowBreakdown({
      location_id: 4564,
      date_from: '2026-05-01',
      date_to: '2026-10-31',
    });
    // 184 days plus the completing day, 31 days a page.
    expect(requests).toHaveLength(6);
    expect(
      requests.map((r) => (r.query as Record<string, unknown>).end_date).at(-1)
    ).toBe('2026-11-01');
    expect(['week', 'month']).toContain(report.granularity);
    expect(
      Buffer.byteLength(
        JSON.stringify({ columns: report.columns, rows: report.rows })
      )
    ).toBeLessThanOrEqual(CASH_FLOW_JSON_BUDGET);
    const types = report.columns.filter(
      (c) => c.dimension === 'cash_account_type'
    );
    const service = report.rows.find(
      (r) => r.payment_item_title === 'Service sales'
    )!;
    // Every group reconciles to the period total, per account type.
    const groups = types.filter((c) => c.period_kind !== 'period_total');
    const sumOf = (type: 'cash' | 'non_cash') =>
      Math.round(
        groups.reduce(
          (sum, c) =>
            c.cash_account_type === type
              ? sum + service.amounts[report.columns.indexOf(c)]! * 100
              : sum,
          0
        )
      );
    expect(sumOf('cash')).toBe(
      expectedCents('2026-05-01', '2026-10-31', (d) => d.service[0])
    );
    expect(sumOf('non_cash')).toBe(
      expectedCents('2026-05-01', '2026-10-31', (d) => d.service[1])
    );
    expect(report.totals.outflow).toBe(
      expectedCents('2026-05-01', '2026-10-31', (d) => d.rent[0]) / 100
    );
    expect(report.totals.net_movement).toBe(
      expectedCents(
        '2026-05-01',
        '2026-10-31',
        (d) => d.accounts[0] + d.accounts[1]
      ) / 100
    );
    const accounts = report.columns.filter(
      (c) => c.dimension === 'cash_account'
    );
    expect(accounts.map((c) => c.cash_account_title)).toContain(
      'Card terminal'
    );
  });

  it('reads a page over the size bound again as two halves', async () => {
    const { client: fake, requests } = client({
      tooLarge: (from, to) => daysBetween(from, to) > 4,
    });
    const report = await new V1LegacyAnalyticsAdapter(
      fake
    ).getCashFlowBreakdown({
      location_id: 4564,
      date_from: '2026-09-01',
      date_to: '2026-09-07',
    });
    expect(requests.length).toBeGreaterThan(1);
    expect(report.totals.inflow).toBe(
      expectedCents(
        '2026-09-01',
        '2026-09-07',
        (d) => d.service[0] + d.service[1]
      ) / 100
    );
  });

  it('refuses a period that needs too many source pages, with how to narrow it', async () => {
    const { client: fake } = client({ tooLarge: (from, to) => from < to });
    await expect(
      new V1LegacyAnalyticsAdapter(fake).getCashFlowBreakdown({
        location_id: 4564,
        date_from: '2026-01-01',
        date_to: '2026-03-31',
      })
    ).rejects.toMatchObject({
      statusCode: 413,
      message: expect.stringMatching(/source pages.*cash_account_type/),
    });
  });

  it('keeps nonzero non-cash-only items and drops zero rows on request', async () => {
    const report = await new V1LegacyAnalyticsAdapter(
      client().client
    ).getCashFlowBreakdown({
      location_id: 4564,
      date_from: '2026-09-14',
      date_to: '2026-09-16',
      include_zero_movement_rows: false,
    });
    const titles = report.rows.map((r) => r.payment_item_title);
    expect(titles).toContain('Service sales');
    expect(titles).not.toContain('Gift cards');
    expect(titles).toContain('Rent');
  });

  it('answers a month from the use case with the rows inside the result budget', async () => {
    const result = await getCashFlowBreakdown(client().client, {
      location_id: 4564,
      date_from: '2026-10-01',
      date_to: '2026-10-31',
    });
    expect(result.text).toContain('Service sales');
    expect(
      Buffer.byteLength(result.text) +
        Buffer.byteLength(JSON.stringify(result.structuredContent))
    ).toBeLessThanOrEqual(40_000);
  });
});

describe('cash-flow grouping', () => {
  const days = (
    count: number,
    rows: number,
    accounts: number
  ): CashFlowDays => ({
    currency: 'UAH',
    account_type: 'all',
    days: Array.from({ length: count }, (_, i) => addDays('2026-01-01', i)),
    account_titles: Array.from({ length: accounts }, (_, i) => `Account ${i}`),
    rows: Array.from({ length: rows }, (_, r) => ({
      payment_item_id: null,
      payment_item_title: `Item ${r}`,
      kind: 'payment_item' as const,
      direction: 'inflow' as const,
      types: Array.from({ length: count }, () => [100, 200]),
      accounts: Array.from({ length: count }, () =>
        Array.from({ length: accounts }, () => 1)
      ),
    })),
  });

  it('keeps day columns for a short period', () => {
    const report = buildCashFlowReport(days(3, 3, 1), {
      includeZeroMovementRows: true,
    });
    expect(report.granularity).toBe('day');
    expect(report.account_columns).toBe('per_period');
    expect(report.rows[0]?.total).toBe(9);
  });

  it('drops to week or month columns, then account totals only, before refusing', () => {
    const report = buildCashFlowReport(days(90, 20, 8), {
      includeZeroMovementRows: true,
    });
    expect(['week', 'month', 'period']).toContain(report.granularity);
    expect(report.rows[0]?.total).toBe(270);
    expect(() =>
      buildCashFlowReport(days(10, 1001, 2), { includeZeroMovementRows: true })
    ).toThrow(
      expect.objectContaining({
        statusCode: 422,
        message: expect.stringMatching(
          /1001 payment-item rows.*include_zero_movement_rows=false/
        ),
      })
    );
  });

  it('labels weeks Monday to Sunday, clipped to the period', () => {
    const report = buildCashFlowReport(
      { ...days(40, 1, 0), account_titles: [], account_type: 'cash', rows: [] },
      { includeZeroMovementRows: true }
    );
    expect(report.granularity).toBe('day');
    const weekly = buildCashFlowReport(
      {
        ...days(40, 30, 0),
        account_type: 'cash',
        account_titles: [],
        rows: days(40, 30, 0).rows.map((row) => ({
          ...row,
          types: row.types.map((d) => [d[0]!]),
          accounts: row.types.map(() => []),
        })),
      },
      { includeZeroMovementRows: true }
    );
    if (weekly.granularity === 'week') {
      // 2026-01-01 is a Thursday.
      expect(weekly.columns[0]).toMatchObject({
        period_label: '2026-01-01..2026-01-04',
        date_from: '2026-01-01',
        date_to: '2026-01-04',
      });
    }
  });
});

describe('profit and loss ledger periods', () => {
  it('knows whole local calendar months', () => {
    expect(isWholeMonths('2026-09-01', '2026-09-30')).toBe(true);
    expect(isWholeMonths('2026-01-01', '2026-03-31')).toBe(true);
    expect(isWholeMonths('2026-02-01', '2026-02-28')).toBe(true);
    expect(isWholeMonths('2026-09-01', '2026-09-29')).toBe(false);
    expect(isWholeMonths('2026-09-02', '2026-09-30')).toBe(false);
    expect(isWholeMonths('2026-11-09', '2026-11-15')).toBe(false);
  });

  it('sums an exact-day ledger from both account types', async () => {
    const { client: fake, requests } = client();
    const report = await new V1LegacyAnalyticsAdapter(fake).getPeriodLedger({
      location_id: 4564,
      date_from: '2026-11-09',
      date_to: '2026-11-15',
    });
    expect(
      requests
        .map((r) => (r.query as Record<string, unknown>).account_type)
        .sort()
    ).toEqual([0, 1]);
    expect(
      requests.every(
        (r) => (r.query as Record<string, unknown>).end_date === '2026-11-16'
      )
    ).toBe(true);
    const income = expectedCents(
      '2026-11-09',
      '2026-11-15',
      (d) => d.service[0] + d.service[1]
    );
    expect(report).toMatchObject({
      currency: 'UAH',
      income_total: income / 100,
      expense_total: 500,
      tracked_operating_result: (income - 50_000) / 100,
    });
    expect(report.categories).toEqual([
      {
        category_id: null,
        title: 'Service sales',
        direction: 'income',
        amount: income / 100,
      },
      { category_id: null, title: 'Rent', direction: 'expense', amount: 500 },
    ]);
  });

  it('names the permission an exact-day ledger needs', async () => {
    const refused = {
      requestLegacyWebReport: async () =>
        new Response(JSON.stringify({ error: 'denied' }), { status: 200 }),
      getLocation: async () => ({ id: 4564, currency_short_title: 'UAH' }),
    } as unknown as AltegioClient;
    await expect(
      new V1LegacyAnalyticsAdapter(refused).getPeriodLedger({
        location_id: 4564,
        date_from: '2026-11-09',
        date_to: '2026-11-15',
      })
    ).rejects.toMatchObject({
      statusCode: 403,
      message: expect.stringMatching(
        /whole calendar months.*period-report permission/
      ),
    });
  });
});
