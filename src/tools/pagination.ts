import { z } from 'zod';

/** Shared one-based pagination for curated collection tools. */
export const paginationInput = {
  page: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .default(1)
    .describe('1-based page number. Default 1.'),
  count: z
    .number()
    .int()
    .positive()
    .max(300)
    .default(25)
    .describe('Results per page. Default 25; maximum 300.'),
};

export interface PageInput {
  page: number;
  count: number;
}

/** Upstream-paged collections may need one empty request after a full last page. */
export function pageMetadata(input: PageInput, count: number, total?: number) {
  return {
    page: input.page,
    page_size: input.count,
    next_page: (
      total === undefined
        ? count >= input.count
        : input.page * input.count < total
    )
      ? input.page + 1
      : null,
    ...(total === undefined ? {} : { total }),
  };
}

/** V1 reference lists are unpaged: sort before slicing to make traversal stable. */
export function paginateCollection<T extends { id: number }>(
  items: readonly T[],
  input: PageInput
) {
  const start = (input.page - 1) * input.count;
  const page = [...items]
    .sort((a, b) => a.id - b.id)
    .slice(start, start + input.count);
  return {
    items: page,
    pagination: pageMetadata(input, page.length, items.length),
  };
}
