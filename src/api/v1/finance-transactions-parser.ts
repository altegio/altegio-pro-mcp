/**
 * Strict parser for one page of the authenticated finance transaction list
 * (`GET /finances/transactions_search/{location_id}/`).
 *
 * The payer-cohort report reads two things from a row: the stable transaction
 * ID in `data-locator` and the rendered local date. Payer names, comments and
 * amounts in the same row are never read.
 *
 * Local date contract (biz.erp `templates/finances/transactions/search.php`):
 * the date cell renders `date('d.m.y', $ts)`, a `<br />`, then
 * `date('H:i:s', $ts)`, where `$ts = tsAtTimezone($transaction->getDate(),
 * $salonId)`. Both patterns are hard-coded PHP `date()` formats: they follow
 * neither the user's language nor the location's EU/US date-format setting,
 * which only decides how the route parses `start_date`/`end_date`.
 * `tsAtTimezone` is the same server-to-location shift the monthly finance
 * report applies before it assigns a transaction to a month
 * (`CTableReportPeriod::fillData` → `dateAtTimezone`), so this date is the
 * ERP's own local month assignment. The documented V1 detail `date` is the raw
 * stored server time without an offset — not location-local — and is never
 * used for the month.
 *
 * Any other cell shape is refused; an unknown format is never guessed.
 */
import { load } from 'cheerio';
import { LegacyAnalyticsParseError } from './legacy-analytics-parser.js';

export interface FinanceTransactionListRow {
  id: number;
  /** Location-local calendar date as the ERP rendered it, `YYYY-MM-DD`. */
  local_date: string;
}

export interface FinanceTransactionListPage {
  rows: FinanceTransactionListRow[];
  /** Exact number of matching transactions across all pages. */
  count: number;
}

export interface FinanceTransactionListRequest {
  date_from: string;
  date_to: string;
  page: number;
  page_size: number;
}

const failure = (detail: string): never => {
  throw new LegacyAnalyticsParseError('payer cohorts', detail);
};

/** `d.m.y` and `H:i:s`, joined by one space where the cell has its `<br />`. */
const RENDERED_LOCAL_DATE_TIME =
  /^(\d{2})\.(\d{2})\.(\d{2}) (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

const ROW_LOCATOR = /^transactions_table_row_([1-9]\d*)$/;

function localDate(
  rendered: string,
  request: FinanceTransactionListRequest
): string {
  const match = RENDERED_LOCAL_DATE_TIME.exec(rendered);
  if (!match) return failure('unrecognised local transaction date format');
  const [, day, month, shortYear] = match;
  // A request spans at most 12 complete months, so at most two consecutive
  // calendar years: their two-digit forms always differ.
  const years = new Set([
    Number(request.date_from.slice(0, 4)),
    Number(request.date_to.slice(0, 4)),
  ]);
  const candidates = [...years].filter(
    (year) => year % 100 === Number(shortYear)
  );
  if (candidates.length === 0)
    return failure('transaction outside requested local dates');
  if (candidates.length > 1) return failure('ambiguous local transaction year');
  const value = `${candidates[0]}-${month}-${day}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    return failure('invalid local transaction date');
  if (value < request.date_from || value > request.date_to)
    return failure('transaction outside requested local dates');
  return value;
}

/** Ordered IDs and local dates of one complete list page, or a refusal. */
export function parseFinanceTransactionListPage(
  html: string,
  count: number,
  request: FinanceTransactionListRequest
): FinanceTransactionListPage {
  if (!Number.isSafeInteger(count) || count < 0)
    return failure('invalid transaction count');
  const expected = Math.max(
    0,
    Math.min(request.page_size, count - (request.page - 1) * request.page_size)
  );
  const $ = load(html);
  const tables = $('table.transactions-table');
  // The template renders no table at all for an empty page.
  if (tables.length === 0 && expected === 0) return { rows: [], count };
  if (tables.length !== 1)
    return failure('transaction table missing or duplicated');
  const rows: FinanceTransactionListRow[] = [];
  for (const element of tables.find('tbody > tr').toArray()) {
    const row = $(element);
    const cell = row.children('td.transactions-table__date');
    const locator = row.attr('data-locator');
    // The page total closes the body as an unlabelled row without a date cell.
    if (locator === undefined && cell.length === 0) continue;
    const match = ROW_LOCATOR.exec(locator ?? '');
    const id = match ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(id))
      return failure('invalid or missing transaction ID');
    if (row.hasClass('danger'))
      return failure('cancelled transaction in the active list');
    if (cell.length !== 1) return failure('missing local transaction date');
    cell.find('br').replaceWith(' ');
    const rendered = cell.text().replace(/\s+/g, ' ').trim();
    rows.push({ id, local_date: localDate(rendered, request) });
  }
  if (
    rows.length !== expected ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  )
    return failure('a finance page was missing or duplicated');
  return { rows, count };
}
