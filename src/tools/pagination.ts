/**
 * One pagination contract for every collection a tool returns.
 *
 * Input: `page` (1-based) and `page_size`. Output: `items` plus a `pagination`
 * object — `page`, `page_size`, `returned`, `total` (null when the source does
 * not report it), `has_more` and `next_page` (null on the last page). Sources
 * that page by a date window instead of an offset use `windowPagination`, which
 * keeps the same object name and the `returned` / `has_more` pair.
 *
 * Every page also has a size budget (`RESPONSE_BYTE_BUDGET`, ADR-001 D8): a
 * page that renders larger is cut to a smaller page size that still continues
 * exactly (`fitPageToBudget`), and the result says so.
 */
import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * Bytes one collection result may take — its text plus its serialized
 * `structuredContent`. Production pages of 300 appointments reached 400 KB,
 * which a host either truncates or pays for in context on every turn.
 */
export const RESPONSE_BYTE_BUDGET = 40_000;

export const pageArg = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .default(1)
  .describe('1-based page.');

/** `page_size` with a tool-specific ceiling. */
export function pageSizeArg(max = MAX_PAGE_SIZE, fallback = DEFAULT_PAGE_SIZE) {
  return z
    .number()
    .int()
    .positive()
    .max(max)
    .default(fallback)
    .describe('Items per page.');
}

/** Shared one-based pagination arguments for collection tools. */
export const paginationInput = {
  page: pageArg,
  page_size: pageSizeArg(),
};

export interface PageInput {
  page: number;
  page_size: number;
}

export interface Pagination {
  page: number;
  page_size: number;
  returned: number;
  /** Exact number of items across all pages, or null when the source does not report it. */
  total: number | null;
  has_more: boolean;
  next_page: number | null;
}

/**
 * Pagination metadata for an offset-paged collection. Without a total, a full
 * page is assumed to continue: the caller may need one empty request after a
 * full last page.
 */
export function pageMetadata(
  input: PageInput,
  returned: number,
  total?: number
): Pagination {
  const hasMore =
    total === undefined
      ? returned >= input.page_size
      : input.page * input.page_size < total;
  return {
    page: input.page,
    page_size: input.page_size,
    returned,
    total: total ?? null,
    has_more: hasMore,
    next_page: hasMore ? input.page + 1 : null,
  };
}

/** A bounded, complete collection: one page that holds everything. */
export function completeCollection<T>(items: readonly T[]) {
  return {
    items: [...items],
    pagination: pageMetadata(
      { page: 1, page_size: Math.max(items.length, 1) },
      items.length,
      items.length
    ),
  };
}

/** V1 reference lists are unpaged: sort before slicing to make traversal stable. */
export function paginateCollection<T extends { id: number }>(
  items: readonly T[],
  input: PageInput
) {
  const start = (input.page - 1) * input.page_size;
  const page = [...items]
    .sort((a, b) => a.id - b.id)
    .slice(start, start + input.page_size);
  return {
    items: page,
    pagination: pageMetadata(input, page.length, items.length),
  };
}

export interface WindowPagination {
  returned: number;
  has_more: boolean;
  /** Pass as `date_from` / `date_to` to continue; null when nothing follows. */
  next_date_from: string | null;
  next_date_to: string | null;
}

/** Pagination metadata for a source that continues by narrowing a date window. */
export function windowPagination(input: {
  returned: number;
  has_more: boolean;
  next_date_from?: string | null;
  next_date_to?: string | null;
}): WindowPagination {
  return {
    returned: input.returned,
    has_more: input.has_more,
    next_date_from: input.has_more ? (input.next_date_from ?? null) : null,
    next_date_to: input.has_more ? (input.next_date_to ?? null) : null,
  };
}

/** JSON Schema of the `pagination` object for offset-paged collections. */
export const paginationOutput = {
  type: 'object' as const,
  properties: {
    page: { type: 'integer' as const, minimum: 1 },
    page_size: { type: 'integer' as const, minimum: 1 },
    returned: { type: 'integer' as const, minimum: 0 },
    total: { type: ['integer', 'null'] as const, minimum: 0 },
    has_more: { type: 'boolean' as const },
    next_page: { type: ['integer', 'null'] as const, minimum: 1 },
  },
  required: ['page', 'page_size', 'returned', 'total', 'has_more', 'next_page'],
};

/** JSON Schema of the `pagination` object for date-window collections. */
export const windowPaginationOutput = {
  type: 'object' as const,
  properties: {
    returned: { type: 'integer' as const, minimum: 0 },
    has_more: { type: 'boolean' as const },
    next_date_from: { type: ['string', 'null'] as const },
    next_date_to: { type: ['string', 'null'] as const },
  },
  required: ['returned', 'has_more', 'next_date_from', 'next_date_to'],
};

/** `{ items: [...], pagination: {...}, ...extra }` as a JSON Schema. */
export function collectionSchema(
  itemSchema: object,
  extraProps: Record<string, object> = {},
  extraRequired: string[] = []
) {
  return {
    type: 'object' as const,
    properties: {
      items: { type: 'array' as const, items: itemSchema },
      pagination: paginationOutput,
      ...extraProps,
    },
    required: ['items', 'pagination', ...extraRequired],
  };
}

/**
 * Bring a capability result that still speaks the report dialect — `rows` for
 * the collection and a `page` object with `total_count` — onto this contract.
 * Keys the dialect does not have are left untouched.
 */
export function standardizeCollection<
  T extends { structuredContent?: unknown },
>(result: T): T {
  const content = result.structuredContent;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    return result;
  }
  const { rows, page, ...rest } = content as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  if (Array.isArray(rows)) out.items = rows;
  if (page && typeof page === 'object' && !Array.isArray(page)) {
    const {
      total_count,
      page: pageNumber,
      page_size,
      returned,
      has_more,
      ...more
    } = page as Record<string, unknown>;
    const items = Array.isArray(rows) ? rows.length : 0;
    const total = typeof total_count === 'number' ? total_count : null;
    const current = typeof pageNumber === 'number' ? pageNumber : 1;
    const size = typeof page_size === 'number' ? page_size : Math.max(items, 1);
    const hasMore =
      typeof has_more === 'boolean'
        ? has_more
        : total !== null && current * size < total;
    out.pagination = {
      page: current,
      page_size: size,
      returned: typeof returned === 'number' ? returned : items,
      total,
      has_more: hasMore,
      next_page: hasMore ? current + 1 : null,
      ...more,
    };
  } else if (page !== undefined) {
    out.page = page;
  }
  return { ...result, structuredContent: out };
}

// ========== size budget ==========

/** Text plus serialized `structuredContent`: what a result costs a host. */
export function resultBytes(output: {
  text: string;
  structuredContent?: unknown;
}): number {
  return (
    Buffer.byteLength(output.text) +
    (output.structuredContent === undefined
      ? 0
      : Buffer.byteLength(JSON.stringify(output.structuredContent)))
  );
}

/** Divisors of `n`, largest first. */
function divisorsDescending(n: number): number[] {
  const divisors: number[] = [];
  for (let d = 1; d * d <= n; d += 1) {
    if (n % d !== 0) continue;
    divisors.push(d);
    if (d * d !== n) divisors.push(n / d);
  }
  return divisors.sort((a, b) => b - a);
}

/** What `fitPageToBudget` hands a renderer: one page and how it continues. */
export interface BudgetedPage<T> {
  items: T[];
  pagination: Pagination;
  /**
   * One sentence for the text when the page was cut to fit the budget,
   * naming how to continue; undefined when it was not.
   */
  notice?: string;
}

/**
 * Render one offset page within the response budget.
 *
 * `items` is the page as fetched for `input`. When it renders larger than
 * `budget`, it is cut to the largest page size that divides the requested
 * one and fits — a divisor, so `page` / `page_size` still address the very
 * next item: page p of size s cut to size k is page (p-1)·s/k + 1 of size k,
 * and every later page of size k continues without a gap or an overlap. The
 * cut is reported in `pagination` (the page and page size actually served) and
 * in a notice the renderer puts in its text.
 */
export function fitPageToBudget<
  T,
  R extends { text: string; structuredContent?: unknown },
>(options: {
  input: PageInput;
  items: readonly T[];
  total?: number;
  render: (page: BudgetedPage<T>) => R;
  budget?: number;
}): R {
  const { input, items, total, render } = options;
  const budget = options.budget ?? RESPONSE_BYTE_BUDGET;
  const full = render({
    items: [...items],
    pagination: pageMetadata(input, items.length, total),
  });
  const fullBytes = resultBytes(full);
  if (fullBytes <= budget || items.length <= 1) return full;

  // Start from the size the measured bytes suggest, then step down.
  const estimate = Math.max(1, Math.floor((items.length * budget) / fullBytes));
  let last = full;
  for (const size of divisorsDescending(input.page_size)) {
    if (size >= items.length || size > estimate) continue;
    const page = (input.page - 1) * (input.page_size / size) + 1;
    const pagination = pageMetadata({ page, page_size: size }, size, total);
    last = render({
      items: items.slice(0, size),
      pagination,
      notice:
        `Cut to ${size} of ${items.length} items to stay within the ${Math.round(budget / 1000)} KB response budget` +
        (pagination.next_page === null
          ? '.'
          : `; continue with page=${pagination.next_page}, page_size=${size}.`),
    });
    if (resultBytes(last) <= budget) return last;
  }
  return last;
}

/**
 * A complete collection under the response budget: the longest prefix that
 * fits, for sources without offset paging (a date range read whole). The
 * renderer is told where the cut fell so it can say how to continue.
 */
export function fitPrefixToBudget<
  T,
  R extends { text: string; structuredContent?: unknown },
>(options: {
  items: readonly T[];
  render: (items: T[], cutAt: number | undefined) => R;
  budget?: number;
}): R {
  const { items, render } = options;
  const budget = options.budget ?? RESPONSE_BYTE_BUDGET;
  const full = render([...items], undefined);
  const fullBytes = resultBytes(full);
  if (fullBytes <= budget || items.length <= 1) return full;

  let size = Math.max(1, Math.floor((items.length * budget) / fullBytes));
  let last = render(items.slice(0, size), size);
  while (resultBytes(last) > budget && size > 1) {
    size = Math.max(1, Math.floor(size * 0.8));
    last = render(items.slice(0, size), size);
  }
  return last;
}
