/**
 * Day-level cash movement and its bounded aggregation into report columns.
 *
 * The ERP cash-flow report has a column per day, per cash-account type and
 * per cash account, so a month across all account types does not fit one
 * answer and a half-year does not fit one source page (prod, 2026-11: monthly
 * and six-month windows refused as oversized). The adapter reads the period
 * in bounded chunks and hands over cents per day; this module merges them and
 * picks the finest column grouping — day, week, month, or the period total
 * alone — that keeps the answer inside its budget. Every amount still
 * reconciles to the same daily cents, so a coarser grouping loses detail,
 * never money.
 */
import type {
  CashAccountType,
  CashFlowAccountColumns,
  CashFlowBreakdownReport,
  CashFlowColumn,
  CashFlowGranularity,
  CashFlowRow,
  CashFlowSourceReport,
} from '../../api/legacy-analytics-api.js';
import { AltegioApiError } from '../../utils/errors.js';

/** Most payment-item × column cells one cash-flow call returns. */
export const MAX_CASH_FLOW_CELLS = 6000;

/**
 * UTF-8 bytes the columns and rows of one cash-flow answer may take. The text
 * content lists the same rows for hosts that read text only, so the result as
 * a whole stays inside the 40 KB response budget.
 */
export const CASH_FLOW_JSON_BUDGET = 15_000;

export interface CashFlowDayRow {
  payment_item_id: number | null;
  payment_item_title: string;
  kind: CashFlowRow['kind'];
  direction: CashFlowRow['direction'];
  /**
   * Cents per day and account type: `[cash, non_cash]` across all account
   * types, `[amount]` for one account type.
   */
  types: number[][];
  /** Cents per day and returned cash account; empty for one account type. */
  accounts: number[][];
}

export interface CashFlowDays {
  currency: string | null;
  account_type: CashAccountType;
  /** Local calendar days, `YYYY-MM-DD`, in order. */
  days: string[];
  /** Titles of the returned cash accounts, in column order. */
  account_titles: string[];
  rows: CashFlowDayRow[];
}

const MS_PER_DAY = 86_400_000;

function dayMs(day: string): number {
  return Date.parse(`${day}T00:00:00Z`);
}

export function addDays(day: string, count: number): string {
  return new Date(dayMs(day) + count * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Inclusive number of days from `from` to `to`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayMs(to) - dayMs(from)) / MS_PER_DAY) + 1;
}

export function cents(value: number | null | undefined): number {
  return value === null || value === undefined ? 0 : Math.round(value * 100);
}

function amount(value: number): number {
  return value / 100;
}

/**
 * Turn one parsed source chunk into cents per day.
 *
 * The source lays out the account-type block for every day and then the
 * chunk total, followed by the account block in the same order. The chunk
 * total is dropped: totals are recomputed from the days the caller keeps.
 */
export function chunkToDays(
  report: CashFlowSourceReport,
  accountType: CashAccountType,
  expectedDays: number
): { account_titles: string[]; rows: CashFlowDayRow[] } | null {
  const perType = accountType === 'all' ? 2 : 1;
  const typeColumns = report.columns.filter(
    (column) => column.dimension === 'cash_account_type'
  ).length;
  const periods = typeColumns / perType;
  if (periods - 1 !== expectedDays) return null;
  const accountColumns = report.columns.length - typeColumns;
  const accountCount = accountType === 'all' ? accountColumns / periods : 0;
  if (!Number.isInteger(accountCount)) return null;
  const account_titles = report.columns
    .slice(typeColumns, typeColumns + accountCount)
    .map((column) => column.cash_account_title ?? '');
  const rows = report.rows.map((row) => {
    const types: number[][] = [];
    const accounts: number[][] = [];
    for (let day = 0; day < expectedDays; day += 1) {
      types.push(
        Array.from({ length: perType }, (_, type) =>
          cents(row.amounts[day * perType + type])
        )
      );
      accounts.push(
        Array.from({ length: accountCount }, (_, account) =>
          cents(row.amounts[typeColumns + day * accountCount + account])
        )
      );
    }
    return {
      payment_item_id: row.payment_item_id,
      payment_item_title: row.payment_item_title,
      kind: row.kind,
      direction: row.direction,
      types,
      accounts,
    };
  });
  return { account_titles, rows };
}

/**
 * Append the days of `next` to `into`. Rows and accounts must be the same
 * list in the same order: the source renders every payment item and every
 * returned account for any period, so a difference is a changed report.
 */
export function appendDays(
  into: { account_titles: string[]; rows: CashFlowDayRow[] },
  next: { account_titles: string[]; rows: CashFlowDayRow[] }
): boolean {
  if (
    into.rows.length !== next.rows.length ||
    into.account_titles.length !== next.account_titles.length ||
    into.account_titles.some((title, i) => title !== next.account_titles[i]) ||
    into.rows.some(
      (row, i) =>
        row.payment_item_title !== next.rows[i]!.payment_item_title ||
        row.kind !== next.rows[i]!.kind
    )
  )
    return false;
  into.rows.forEach((row, i) => {
    row.types.push(...next.rows[i]!.types);
    row.accounts.push(...next.rows[i]!.accounts);
  });
  return true;
}

interface Bucket {
  label: string;
  kind: CashFlowColumn['period_kind'];
  date_from: string;
  date_to: string;
  start: number;
  end: number;
}

function buckets(days: string[], granularity: CashFlowGranularity): Bucket[] {
  if (granularity === 'period' || days.length === 0) return [];
  const out: Bucket[] = [];
  const keyOf = (day: string): string => {
    if (granularity === 'day') return day;
    if (granularity === 'month') return day.slice(0, 7);
    // ISO week: Monday to Sunday.
    const weekday = (new Date(dayMs(day)).getUTCDay() + 6) % 7;
    return addDays(day, -weekday);
  };
  days.forEach((day, index) => {
    const key = keyOf(day);
    const last = out.at(-1);
    if (last && last.label === key) {
      last.end = index + 1;
      last.date_to = day;
    } else {
      out.push({
        label: key,
        kind: granularity,
        date_from: day,
        date_to: day,
        start: index,
        end: index + 1,
      });
    }
  });
  for (const bucket of out) {
    if (granularity === 'week')
      bucket.label = `${bucket.date_from}..${bucket.date_to}`;
  }
  return out;
}

function sum(
  values: number[][],
  start: number,
  end: number,
  index: number
): number {
  let total = 0;
  for (let day = start; day < end; day += 1) total += values[day]![index]!;
  return total;
}

function render(
  data: CashFlowDays,
  rows: CashFlowDayRow[],
  granularity: CashFlowGranularity,
  accountColumns: CashFlowAccountColumns
): Pick<CashFlowBreakdownReport, 'columns' | 'rows'> {
  const all = data.account_type === 'all';
  const types: CashAccountType[] = all
    ? ['cash', 'non_cash']
    : [data.account_type];
  const days = data.days;
  const periods: Bucket[] = [
    ...buckets(days, granularity),
    {
      label: 'total',
      kind: 'period_total',
      date_from: days[0] ?? '',
      date_to: days.at(-1) ?? '',
      start: 0,
      end: days.length,
    },
  ];
  const accountPeriods =
    accountColumns === 'per_period'
      ? periods
      : accountColumns === 'period_total_only'
        ? periods.slice(-1)
        : [];
  const columns: CashFlowColumn[] = [];
  for (const period of periods)
    for (const type of types)
      columns.push({
        period_label: period.label,
        period_kind: period.kind,
        date_from: period.date_from,
        date_to: period.date_to,
        dimension: 'cash_account_type',
        cash_account_type: type,
        cash_account_id: null,
        cash_account_title: null,
      });
  for (const period of accountPeriods)
    for (const title of data.account_titles)
      columns.push({
        period_label: period.label,
        period_kind: period.kind,
        date_from: period.date_from,
        date_to: period.date_to,
        dimension: 'cash_account',
        cash_account_type: null,
        cash_account_id: null,
        cash_account_title: title,
      });
  return {
    columns,
    rows: rows.map((row) => {
      const amounts: number[] = [];
      for (const period of periods)
        types.forEach((_type, index) =>
          amounts.push(amount(sum(row.types, period.start, period.end, index)))
        );
      for (const period of accountPeriods)
        data.account_titles.forEach((_title, index) =>
          amounts.push(
            amount(sum(row.accounts, period.start, period.end, index))
          )
        );
      let total = 0;
      types.forEach((_type, index) => {
        total += sum(row.types, 0, days.length, index);
      });
      return {
        payment_item_id: row.payment_item_id,
        payment_item_title: row.payment_item_title,
        kind: row.kind,
        direction: row.direction,
        amounts,
        total: amount(total),
      };
    }),
  };
}

/** A row that moved no money on any day, in any account. */
export function isZeroMovement(row: CashFlowDayRow): boolean {
  return (
    row.types.every((day) => day.every((value) => value === 0)) &&
    row.accounts.every((day) => day.every((value) => value === 0))
  );
}

/**
 * Build the answer at the finest grouping that fits: day, week, month, then
 * the period total alone, with per-account columns for every group before
 * per-account period totals only.
 */
export function buildCashFlowReport(
  data: CashFlowDays,
  options: { includeZeroMovementRows: boolean }
): CashFlowBreakdownReport {
  const rows = options.includeZeroMovementRows
    ? data.rows
    : data.rows.filter(
        (row) => row.kind !== 'payment_item' || !isZeroMovement(row)
      );
  const accountOptions: CashFlowAccountColumns[] =
    data.account_type === 'all' && data.account_titles.length > 0
      ? ['per_period', 'period_total_only']
      : ['none'];
  const granularities: CashFlowGranularity[] = [
    'day',
    'week',
    'month',
    'period',
  ];
  for (const granularity of granularities) {
    const groups = buckets(data.days, granularity).length + 1;
    for (const accountColumns of accountOptions) {
      const accountGroups =
        accountColumns === 'per_period'
          ? groups
          : accountColumns === 'period_total_only'
            ? 1
            : 0;
      const width =
        groups * (data.account_type === 'all' ? 2 : 1) +
        accountGroups * data.account_titles.length;
      if (rows.length * width > MAX_CASH_FLOW_CELLS) continue;
      const body = render(data, rows, granularity, accountColumns);
      if (Buffer.byteLength(JSON.stringify(body)) > CASH_FLOW_JSON_BUDGET)
        continue;
      return {
        currency: data.currency,
        granularity,
        account_columns: accountColumns,
        ...body,
        totals: {
          inflow: body.rows.find((r) => r.kind === 'inflow')?.total ?? null,
          outflow: body.rows.find((r) => r.kind === 'outflow')?.total ?? null,
          net_movement:
            body.rows.find((r) => r.kind === 'net_movement')?.total ?? null,
        },
      };
    }
  }
  // A size bound, not a changed markup: the same call keeps failing until
  // the caller narrows it, so it must not read as "retry later".
  throw new AltegioApiError(
    `The cash-flow breakdown has ${rows.length} payment-item rows${data.account_type === 'all' ? ` and ${data.account_titles.length} cash accounts` : ''}, more than one answer holds even as period totals. Narrow it: include_zero_movement_rows=false, payment_item_id, cash_account_ids, or cash_account_type=cash or non_cash.`,
    422
  );
}
