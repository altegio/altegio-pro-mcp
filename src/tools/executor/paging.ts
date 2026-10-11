/**
 * Continuation for executor list results (ADR-001 D8).
 *
 * A page the API returned may not fit the size budget. Cutting it and saying
 * "truncated" left the model paging the same window again and again; instead,
 * the result keeps as many items as fit and names the exact next request in
 * canonical parameters (`page`, `page_size`). The next request starts at the
 * first item that was not shown, so nothing is skipped and nothing repeats.
 *
 * The arithmetic: page `p` of size `n` starts at offset `(p - 1) * n`. Keeping
 * `k` items of it, the next page of size `k'` starts where we stopped only if
 * `k'` divides that offset — so `k'` is the largest divisor of the offset not
 * above `k`, and only `k'` items are returned. On page 1 the offset is 0 and
 * every `k` works.
 */

/** Page size the executor asks for when the caller names none. */
export const DEFAULT_PAGE_SIZE = 50;

export interface Pagination {
  page: number;
  /** Items per page as requested; null when the operation's default was used and is unknown. */
  page_size: number | null;
  returned: number;
  /** Items across all pages, when the API reports it. */
  total: number | null;
  has_more: boolean;
  /** Pass as `page` to continue; null when nothing follows. */
  next_page: number | null;
  /** Pass as `page_size` with `next_page` — smaller than `page_size` when the budget cut the page. */
  next_page_size: number | null;
}

export interface PagePlan {
  /** Leading items to return. */
  keep: number;
  pagination: Pagination;
}

/** Largest divisor of `offset` that is at most `max` (at least 1). */
function alignedSize(offset: number, max: number): number {
  if (offset === 0) return max;
  for (let size = max; size > 1; size -= 1) {
    if (offset % size === 0) return size;
  }
  return 1;
}

/**
 * Decide how many items to return and what the next request is.
 *
 * `fits` is how many items the size budget allows; `received` how many the API
 * returned for the requested page.
 */
export function planPage(args: {
  page: number;
  pageSize?: number;
  received: number;
  fits: number;
  total?: number;
}): PagePlan {
  const { page, pageSize, received, total } = args;
  const fits = Math.max(Math.min(args.fits, received), 0);

  if (fits < received) {
    // Without the requested size the offset of this page is unknown, so an
    // exact continuation exists only from the first page.
    if (page > 1 && pageSize === undefined) {
      return {
        keep: fits,
        pagination: {
          page,
          page_size: null,
          returned: fits,
          total: total ?? null,
          has_more: true,
          next_page: null,
          next_page_size: null,
        },
      };
    }
    const offset = (page - 1) * (pageSize ?? 0);
    const size = Math.max(alignedSize(offset, Math.max(fits, 1)), 1);
    return {
      keep: size,
      pagination: {
        page,
        page_size: pageSize ?? null,
        returned: size,
        total: total ?? null,
        has_more: true,
        next_page: offset / size + 2,
        next_page_size: size,
      },
    };
  }

  const hasMore =
    pageSize === undefined
      ? false
      : total !== undefined
        ? page * pageSize < total
        : received >= pageSize;
  return {
    keep: received,
    pagination: {
      page,
      page_size: pageSize ?? null,
      returned: received,
      total: total ?? null,
      has_more: hasMore,
      next_page: hasMore ? page + 1 : null,
      next_page_size: hasMore ? (pageSize ?? null) : null,
    },
  };
}
