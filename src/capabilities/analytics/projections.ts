/**
 * Result shaping for the analytics pack (ADR-001 D8).
 *
 * Two jobs: keep every tool result small enough to be worth reading (row caps,
 * `[date, value]` pairs, no raw payloads), and give the model a short text
 * summary it can quote next to the structured content. Nothing here talks to
 * the API.
 */
import type {
  AnalyticsOverview,
  ComparedValue,
  DailySeries,
  ReportField,
  ReportTable,
} from '../../api/analytics-api.js';
import type { Period } from './periods.js';
import { REPORT_ROW_CAP } from './report-store.js';

/** Format a money amount for the text summary. */
export function formatMoney(
  value: number | null,
  currency: string | null
): string {
  if (value === null) return 'n/a';
  const rendered = value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
  return currency ? `${rendered} ${currency}` : rendered;
}

/** Render a change as `+12.5%`, `-4%` or `n/a`. */
export function formatChange(change: number | null): string {
  if (change === null) return 'n/a';
  const sign = change > 0 ? '+' : '';
  return `${sign}${change}%`;
}

function comparedText(
  label: string,
  value: ComparedValue,
  currency: string | null,
  unit: 'money' | 'count' | 'percent'
): string {
  const current =
    unit === 'money'
      ? formatMoney(value.current, currency)
      : value.current === null
        ? 'n/a'
        : `${value.current}${unit === 'percent' ? '%' : ''}`;
  return `${label}: ${current} (${formatChange(value.change_percent)} vs previous period)`;
}

/** One-paragraph summary of the key metrics. */
export function overviewSummary(
  overview: AnalyticsOverview,
  period: Period,
  previous: { date_from: string; date_to: string }
): string {
  const lines = [
    `Key metrics for ${period.date_from}…${period.date_to} (${period.days} days, compared with ${previous.date_from}…${previous.date_to}):`,
    comparedText(
      'Total revenue',
      overview.revenue.total,
      overview.currency,
      'money'
    ),
    comparedText(
      'Services revenue',
      overview.revenue.services,
      overview.currency,
      'money'
    ),
    comparedText(
      'Products revenue',
      overview.revenue.products,
      overview.currency,
      'money'
    ),
    comparedText(
      'Average check',
      overview.average_check,
      overview.currency,
      'money'
    ),
    comparedText('Occupancy', overview.occupancy_percent, null, 'percent'),
    `Appointments: ${overview.appointments.total_count ?? 'n/a'} total, ${overview.appointments.completed_count ?? 'n/a'} completed, ${overview.appointments.cancelled_count ?? 'n/a'} cancelled (${formatChange(overview.appointments.change_percent)} vs previous period)`,
    `Clients: ${overview.clients.active_count ?? 'n/a'} came in the period — ${overview.clients.new_count ?? 'n/a'} new, ${overview.clients.returning_count ?? 'n/a'} returning; ${overview.clients.lost_count ?? 'n/a'} lost of ${overview.clients.total_in_base ?? 'n/a'} in the client base`,
  ];
  return lines.join('\n');
}

/** Compact one-line-per-series summary of a daily series set. */
export function seriesSummary(
  metric: string,
  series: DailySeries[],
  period: Period,
  unit: 'money' | 'count' | 'percent',
  currency: string | null
): string {
  if (series.length === 0) {
    return `No ${metric} data for ${period.date_from}…${period.date_to}.`;
  }
  const lines = series.map((one) => {
    const values = one.points.map(([, value]) => value);
    const total = values.reduce((sum, value) => sum + value, 0);
    const peak = one.points.reduce<[string, number] | null>(
      (best, point) =>
        best === null || point[1] > best[1] ? [...point] : best,
      null
    );
    const aggregate =
      unit === 'percent'
        ? `average ${values.length > 0 ? Math.round((total / values.length) * 10) / 10 : 0}%`
        : unit === 'money'
          ? `total ${formatMoney(Math.round(total * 100) / 100, currency)}`
          : `total ${total}`;
    const best = peak ? `, best day ${peak[0]} (${peak[1]})` : '';
    return `${one.key}: ${aggregate} over ${one.points.length} days${best}`;
  });
  return [
    `Daily ${metric} for ${period.date_from}…${period.date_to}, one [date, value] pair per day:`,
    ...lines,
  ].join('\n');
}

/** Add a `share_percent` to a breakdown and sort it, biggest first. */
export function withShares<T extends { count: number }>(
  slices: T[]
): Array<T & { share_percent: number }> {
  const total = slices.reduce((sum, slice) => sum + slice.count, 0);
  return slices
    .map((slice) => ({
      ...slice,
      share_percent:
        total > 0 ? Math.round((slice.count / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

// ========== report tables ==========

/** Escape one CSV cell per RFC 4180. */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Render a whole table to CSV, header row first. */
export function toCsv(table: {
  columns: Array<{ key: string; title: string }>;
  rows: Array<Record<string, string | number | null>>;
  totals?: Record<string, string | number | null>;
}): string {
  const lines = [table.columns.map((c) => csvCell(c.title)).join(',')];
  for (const row of table.rows) {
    lines.push(table.columns.map((c) => csvCell(row[c.key] ?? null)).join(','));
  }
  if (table.totals && Object.keys(table.totals).length > 0) {
    lines.push(
      table.columns.map((c) => csvCell(table.totals?.[c.key] ?? null)).join(',')
    );
  }
  return `${lines.join('\n')}\n`;
}

export interface RenamedTable {
  columns: Array<{ key: string; title: string }>;
  rows: Array<Record<string, string | number | null>>;
  totals: Record<string, string | number | null>;
  row_count: number;
  truncated: boolean;
}

/**
 * Rename a builder table's opaque column keys to canonical field keys and cap
 * the rows.
 *
 * The builder answers with generated keys (`column_1`, …) plus the registry id
 * of each column; the field catalogue turns that id into a canonical
 * `field_key`, so the agent sees `team_member_name` and `revenue_total` instead.
 */
export function projectReportTable(
  table: ReportTable,
  fields: readonly ReportField[],
  rowCap: number = REPORT_ROW_CAP
): RenamedTable {
  const fieldByColumnId = new Map(
    fields.map((field) => [field.column_id, field])
  );
  const used = new Set<string>();
  const keyByResponseKey = new Map<string, string>();

  const columns = table.columns.map((column) => {
    const columnId = table.column_ids?.[column.key];
    const field = columnId ? fieldByColumnId.get(columnId) : undefined;
    let key = field?.field_key ?? column.key;
    // A dynamic report repeats one metric per time bucket, so keys collide;
    // keep them unique and readable by appending the bucket.
    if (used.has(key)) {
      const bucket = column.title.replace(`${column.key} `, '').trim();
      key = bucket ? `${key}_${bucket}` : `${key}_${used.size + 1}`;
    }
    let unique = key;
    let counter = 2;
    while (used.has(unique)) unique = `${key}_${counter++}`;
    used.add(unique);
    keyByResponseKey.set(column.key, unique);
    return {
      key: unique,
      title: field ? field.title : column.title,
    };
  });

  const remap = (
    row: Record<string, string | number | null>
  ): Record<string, string | number | null> => {
    const out: Record<string, string | number | null> = {};
    for (const [responseKey, value] of Object.entries(row)) {
      out[keyByResponseKey.get(responseKey) ?? responseKey] = value;
    }
    return out;
  };

  const allRows = table.rows.map(remap);
  return {
    columns,
    rows: allRows.slice(0, rowCap),
    totals: remap(table.totals),
    row_count: allRows.length,
    truncated: allRows.length > rowCap,
  };
}

/** Text summary of a report table: the first rows, rendered as fixed columns. */
export function tableSummary(
  name: string,
  table: RenamedTable,
  previewRows = 10
): string {
  if (table.row_count === 0) {
    return `"${name}" returned no rows for this period. Widen the period or relax the filters.`;
  }
  const header = table.columns.map((c) => c.title).join(' | ');
  const preview = table.rows
    .slice(0, previewRows)
    .map((row) =>
      table.columns.map((c) => String(row[c.key] ?? '')).join(' | ')
    );
  const lines = [
    `"${name}" — ${table.row_count} row${table.row_count === 1 ? '' : 's'}${
      table.truncated
        ? `, ${table.rows.length} returned in this result; the full table is attached as a CSV resource`
        : ''
    }.`,
    header,
    ...preview,
  ];
  if (table.rows.length > previewRows) {
    lines.push(
      `… ${table.rows.length - previewRows} more rows in the structured result.`
    );
  }
  return lines.join('\n');
}

/** Cut a series set down to the days that carry a value, for a tighter result. */
export function dropEmptyDays(series: DailySeries[]): DailySeries[] {
  return series.map((one) => ({
    ...one,
    points: one.points.filter(([, value]) => value !== 0),
  }));
}
