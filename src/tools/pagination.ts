/**
 * One pagination contract for every collection a tool returns.
 *
 * Input: `page` (1-based) and `page_size`. Output: `items` plus a `pagination`
 * object — `page`, `page_size`, `returned`, `total` (null when the source does
 * not report it), `has_more` and `next_page` (null on the last page). Sources
 * that page by a date window instead of an offset use `windowPagination`, which
 * keeps the same object name and the `returned` / `has_more` pair.
 *
 * A page holds exactly the `page_size` the caller asked for — fewer only on the
 * last page — so `page = next_page` with the same page size reads on without a
 * gap (`renderPage`). `MAX_PAGE_SIZE` bounds a page. Sources read whole by a date
 * window fit `RESPONSE_BYTE_BUDGET` instead (`fitPrefixToBudget`, ADR-001 D8):
 * they continue by date, which no page size can shift.
 */
import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;

/**
 * Bytes a date-window result may take — its text plus its serialized
 * `structuredContent`. Production pages of 300 appointments reached 400 KB,
 * which a host either truncates or pays for in context on every turn; offset
 * pages are bounded by `MAX_PAGE_SIZE` instead (see `renderPage`).
 */
export const RESPONSE_BYTE_BUDGET = 40_000;

export const pageArg = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)
  .default(1)
  .describe('1-based page.');

/**
 * `page_size` with a tool-specific ceiling. The ceiling is also stated in
 * words: hosts that render a schema as a code signature drop `maximum`. A
 * larger size is served at the ceiling on the first page and refused on a
 * later one (`capPageSize` in `./input-normalization.ts`).
 */
export function pageSizeArg(max = MAX_PAGE_SIZE, fallback = DEFAULT_PAGE_SIZE) {
  return z
    .number()
    .int()
    .positive()
    .max(max)
    .default(fallback)
    .describe(`Items per page. At most ${max}.`);
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

/** What `renderPage` hands a renderer: one page and how it continues. */
export interface PageView<T> {
  items: T[];
  pagination: Pagination;
}

/**
 * Render one offset page with its continuation, never cut.
 *
 * A page that continues holds exactly `input.page_size` items, so a caller that
 * keeps its page size while following `next_page` reads every item once. Cutting
 * an oversized page to a smaller size (#116) moved `next_page` into that size:
 * on 2026-10-12 a loop that kept page_size 100 was served pages 1, 3, 7 and 15
 * of 50 and read 200 of 797 appointments without an error. No size budget can
 * shrink a page and keep `page`/`page_size` stable for such a caller, so the page
 * size the caller chose, at most `MAX_PAGE_SIZE`, is what bounds the result.
 */
export function renderPage<T, R>(options: {
  input: PageInput;
  items: readonly T[];
  total?: number;
  render: (page: PageView<T>) => R;
}): R {
  const { input, items, total, render } = options;
  return render({
    items: [...items],
    pagination: pageMetadata(input, items.length, total),
  });
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
