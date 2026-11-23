/**
 * Report rows in the text content of a result.
 *
 * Several hosts hand the model only the text blocks of a tool result and
 * drop `structuredContent` (prod, 2026-11: Claude.ai, Claude Code and ChatGPT
 * agents saw "83 product sales row(s); showing 25" and no product at all, for
 * any page size). A report answer therefore lists its rows in the text too:
 * one header line naming the columns, then one JSON array per row, fenced as
 * untrusted data because titles and names are written by the location's
 * people. The listing has its own byte budget, so text and structured content
 * together stay inside the response budget; rows past it are named with the
 * page size that lists every row.
 */
import {
  untrustedBlock,
  type UntrustedField,
} from '../../tools/tool-result.js';

/** UTF-8 bytes the row listing of one text result may take. */
export const ROWS_TEXT_BUDGET = 15_000;

type Cell = string | number | boolean | null;

/** Scalar cells of one row: nested objects as dotted keys, lists as JSON. */
function cells(
  value: Record<string, unknown>,
  prefix = '',
  out: Record<string, Cell> = {}
): Record<string, Cell> {
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (item === undefined) continue;
    if (item === null || ['string', 'number', 'boolean'].includes(typeof item))
      out[name] = item as Cell;
    else if (Array.isArray(item)) out[name] = JSON.stringify(item);
    else if (typeof item === 'object')
      cells(item as Record<string, unknown>, name, out);
  }
  return out;
}

export interface RowsText {
  /** The fenced listing, or null when there are no rows. */
  block: string | null;
  /** Rows listed; fewer than `rows.length` when the budget cut the listing. */
  listed: number;
}

/**
 * List `rows` as text under `label` within `budget` bytes. `omit` drops
 * columns that would only repeat the summary (a constant id, a note).
 */
export function rowsText(
  label: string,
  rows: readonly object[],
  options: { budget?: number; omit?: readonly string[] } = {}
): RowsText {
  if (rows.length === 0) return { block: null, listed: 0 };
  const budget = options.budget ?? ROWS_TEXT_BUDGET;
  const omit = new Set(options.omit ?? []);
  const flat = rows.map((row) => cells(row as Record<string, unknown>));
  const columns: string[] = [];
  for (const row of flat)
    for (const key of Object.keys(row))
      if (!omit.has(key) && !columns.includes(key)) columns.push(key);
  const header: UntrustedField = {
    label: `${label} columns`,
    value: JSON.stringify(columns),
  };
  const fields: UntrustedField[] = [header];
  let bytes = Buffer.byteLength(header.value as string) + header.label.length;
  let listed = 0;
  for (const row of flat) {
    const value = JSON.stringify(columns.map((column) => row[column] ?? null));
    const label = String(listed + 1);
    const size = Buffer.byteLength(value) + label.length + 3;
    if (listed > 0 && bytes + size > budget) break;
    fields.push({ label, value });
    bytes += size;
    listed += 1;
  }
  return {
    block: untrustedBlock(fields, { maxChars: budget }),
    listed,
  };
}

/**
 * Append the row listing to a summary. When the budget cut it, say which
 * rows are listed and the page size that lists all of them.
 */
export function withRowsText(
  summary: string,
  label: string,
  rows: readonly object[],
  options: { budget?: number; omit?: readonly string[]; pageSize?: number } = {}
): string {
  const listing = rowsText(label, rows, options);
  if (!listing.block) return summary;
  const note =
    listing.listed < rows.length
      ? `\nRows 1–${listing.listed} of the ${rows.length} on this page are listed below; ${options.pageSize !== undefined ? `request page_size ${listing.listed} or less to read every row as text` : 'narrow the request to read the rest as text'}.`
      : '';
  return `${summary}${note}\n\n${listing.block}`;
}
