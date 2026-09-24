/** Strict parser for the monthly columns of the authenticated finance report. */
import { load } from 'cheerio';
import {
  LegacyAnalyticsParseError,
  parseLocaleNumber,
} from './legacy-analytics-parser.js';

export interface PostedIncomeCategory {
  category_id: number;
  amount: number;
}

export interface PostedIncomeMonth {
  month: string;
  income_total: number;
  categories: PostedIncomeCategory[];
}

const failure = (detail: string): never => {
  throw new LegacyAnalyticsParseError('cash receipts', detail);
};

function cents(value: string): number {
  const amount = parseLocaleNumber(value);
  if (
    amount === null ||
    !Number.isSafeInteger(Math.round(amount * 100)) ||
    Math.abs(amount * 100 - Math.round(amount * 100)) > 0.001
  ) {
    return failure('invalid monetary amount');
  }
  return Math.round(amount * 100);
}

function monthsBetween(from: string, to: string): string[] {
  const months: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (
    let year = start.getUTCFullYear(), month = start.getUTCMonth();
    year < end.getUTCFullYear() ||
    (year === end.getUTCFullYear() && month <= end.getUTCMonth());
  ) {
    months.push(`${year}-${String(month + 1).padStart(2, '0')}`);
    month += 1;
    if (month === 12) {
      year += 1;
      month = 0;
    }
  }
  return months;
}

function localRange(month: string): { from: string; to: string } {
  const [year, part] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year!, part!, 0)).getUTCDate();
  return {
    from: `01.${String(part).padStart(2, '0')}.${year}`,
    to: `${String(lastDay).padStart(2, '0')}.${String(part).padStart(2, '0')}.${year}`,
  };
}

/** The source renders one column per local calendar month and a final total. */
export function parseCashReceiptsHtml(
  html: string,
  dateFrom: string,
  dateTo: string
): PostedIncomeMonth[] {
  const months = monthsBetween(dateFrom, dateTo);
  if (months.length < 1 || months.length > 12)
    return failure('unexpected month count');
  const $ = load(html);
  const tables = $('table.table-report');
  if (tables.length !== 1)
    return failure('monthly finance table missing or duplicated');
  const header = tables.find('thead tr').first().find('th');
  if (header.length !== months.length + 2)
    return failure('monthly column count changed');
  const rows = tables.find('tbody > tr').toArray();
  if (rows.length < 3 || rows.length > 510)
    return failure('income rows missing or too many');
  const result: PostedIncomeMonth[] = months.map((month) => ({
    month,
    income_total: 0,
    categories: [],
  }));
  let section: 'before' | 'income' | 'expense' | 'done' = 'before';
  let incomeTotalCents = 0;
  const seen = new Set<number>();
  for (const row of rows) {
    const item = $(row);
    const cells = item.children('td');
    if (cells.length !== months.length + 2)
      return failure('partial finance row');
    const values = months.map((_, index) => cents(cells.eq(index + 1).text()));
    const displayedTotal = cents(cells.eq(months.length + 1).text());
    if (values.reduce((sum, value) => sum + value, 0) !== displayedTotal) {
      return failure('monthly amounts do not match row total');
    }
    if (item.hasClass('row-aggregated')) {
      if (section === 'before') {
        section = 'income';
        incomeTotalCents = displayedTotal;
        values.forEach((value, index) => {
          result[index]!.income_total = value / 100;
        });
      } else if (section === 'income') {
        section = 'expense';
      } else if (section === 'expense') {
        section = 'done';
      } else return failure('unexpected aggregate row');
      continue;
    }
    if (section !== 'income') continue;
    const links = cells.find('a[href*="type="]');
    if (links.length === 0 && displayedTotal === 0) continue;
    const ids = new Set(
      links.toArray().map((link) =>
        Number(
          $(link)
            .attr('href')
            ?.match(/[?&]type=(\d+)/)?.[1]
        )
      )
    );
    if (ids.size !== 1) return failure('ambiguous income category');
    const id = [...ids][0];
    if (!Number.isSafeInteger(id) || id! <= 0 || seen.has(id!))
      return failure('invalid or repeated income category');
    seen.add(id!);
    values.forEach((value, index) => {
      const href = cells
        .eq(index + 1)
        .find('a[href*="type="]')
        .first()
        .attr('href');
      if (value !== 0 || href) {
        const range = localRange(months[index]!);
        if (
          !href ||
          !href.includes(`start_date=${range.from}`) ||
          !href.includes(`end_date=${range.to}`)
        ) {
          failure('month link does not match requested local period');
        }
      }
      result[index]!.categories.push({ category_id: id!, amount: value / 100 });
    });
  }
  if (section !== 'done') return failure('aggregate rows incomplete');
  if (
    result.reduce(
      (sum, month) => sum + Math.round(month.income_total * 100),
      0
    ) !== incomeTotalCents
  ) {
    return failure('income aggregate does not match period total');
  }
  for (const month of result) {
    const componentCents = month.categories.reduce(
      (sum, category) => sum + Math.round(category.amount * 100),
      0
    );
    if (componentCents !== Math.round(month.income_total * 100)) {
      return failure('income categories do not reconcile');
    }
  }
  return result;
}
