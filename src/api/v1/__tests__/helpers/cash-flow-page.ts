/**
 * Builds the ERP cash-flow search table the way
 * `templates/finances_reports/account_period/search.php` renders it: a title
 * column, a day column per date, a period total and the all-types total, with
 * cash / card / total sub-columns and an account sub-column per cash account
 * across all account types, or one cell per day for one account type.
 */
export interface CashFlowPageRow {
  title: string;
  /** Inflow, outflow and the balance are the aggregated rows. */
  aggregate?: boolean;
  /** Per day: `[cash, card]` across all types, `[amount]` for one type. */
  days: number[][];
  /** Per day and account, across all types only. */
  accounts?: number[][];
}

const format = (value: number): string =>
  value === 0
    ? '0'
    : value.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

function sumDays(days: number[][], index: number): number {
  return days.reduce((sum, day) => sum + (day[index] ?? 0), 0);
}

export function cashFlowPage(args: {
  /** Day column titles, e.g. `19 September`. */
  labels: string[];
  accounts?: string[];
  oneType?: boolean;
  rows: CashFlowPageRow[];
}): string {
  const accounts = args.accounts ?? [];
  const periods = [...args.labels, 'Total'];
  const head = args.oneType
    ? `<tr><th class="by-type">Item</th><th class="by-account hidden">Item</th>${periods
        .map(
          (p) =>
            `<th class="by-type">${p}</th><th class="by-account hidden">${p}</th>`
        )
        .join(
          ''
        )}<th class="by-type">Total</th><th class="by-account hidden">Total</th></tr>`
    : `<tr><th class="by-type" rowspan="2">Item</th><th class="by-account hidden" rowspan="2">Item</th>${periods
        .map(
          (p) =>
            `<th class="by-type" colspan="3">${p}</th><th class="by-account hidden" colspan="${accounts.length}">${p}</th>`
        )
        .join(
          ''
        )}<th class="by-type" rowspan="2">Total</th><th class="by-account hidden" rowspan="2">Total</th></tr>` +
      `<tr class="by-type">${periods.map(() => '<td>Cash</td><td>Card</td><td>Total</td>').join('')}</tr>` +
      `<tr class="by-account hidden">${periods
        .map(() => accounts.map((a) => `<td><span>${a}</span></td>`).join(''))
        .join('')}</tr>`;
  const body = args.rows
    .map((row) => {
      const cls = row.aggregate ? ' class="row-aggregated"' : '';
      const all = row.days.reduce(
        (sum, day) => sum + day.reduce((a, b) => a + b, 0),
        0
      );
      const total = row.days[0]?.map((_, i) => sumDays(row.days, i)) ?? [];
      const perPeriod = [...row.days, total];
      if (args.oneType)
        return `<tr${cls}><td class="report-title-cell">${row.title}</td>${perPeriod
          .map(
            (values) =>
              `<td class="report-amount-cell" data-fixed-cell>${values[0] ?? 0}</td>`
          )
          .join(
            ''
          )}<td class="report-amount-cell report-all-cell">${all}</td></tr>`;
      const accountDays =
        row.accounts ?? row.days.map(() => accounts.map(() => 0));
      const accountTotal = accounts.map((_, i) => sumDays(accountDays, i));
      const accountPeriods = [...accountDays, accountTotal];
      const cells = perPeriod
        .map((values, p) => {
          const [cash = 0, card = 0] = values;
          return (
            `<td class="by-type report-amount-cell">${format(cash)}</td><td class="by-type report-amount-cell">${format(card)}</td><td class="by-type report-amount-cell">${format(cash + card)}</td>` +
            accountPeriods[p]!.map(
              (value) =>
                `<td class="by-account hidden report-amount-cell">${format(value)}</td>`
            ).join('')
          );
        })
        .join('');
      const balance = row.aggregate && row.title === 'Balance';
      const titleCell = `<td class="report-title-cell"${balance ? ' rowspan="2"' : ''}>${row.title}</td>`;
      const allCell = `<td class="report-amount-cell report-all-cell"${balance ? ' rowspan="2"' : ''}>${format(all)}</td>`;
      const continuation = balance
        ? `<tr class="row-aggregated">${perPeriod
            .map(
              (values) =>
                `<td colspan="3" class="by-type report-amount-cell">${format(values.reduce((a, b) => a + b, 0))}</td><td colspan="${accounts.length}" class="by-account hidden report-amount-cell">${format(values.reduce((a, b) => a + b, 0))}</td>`
            )
            .join('')}</tr>`
        : '';
      return `<tr${cls}>${titleCell}${cells}${allCell}</tr>${continuation}`;
    })
    .join('');
  return `<table class="table table-bordered table-report" data-fixed-table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

/** Day titles as the English report renders them, from `YYYY-MM-DD`. */
export function dayLabels(from: string, count: number): string[] {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(Date.parse(`${from}T00:00:00Z`) + i * 86_400_000);
    return `${day.getUTCDate()} ${months[day.getUTCMonth()]}`;
  });
}

/** The search envelope the cash-flow route answers with. */
export function cashFlowResponse(html: string): Response {
  return new Response(
    JSON.stringify({ success: true, count: 1, content: html }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }
  );
}
