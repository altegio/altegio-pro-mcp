/**
 * How many matches `tools_search` returns. A leaf module: `./dispatch.ts`
 * reaches the tool definitions through the inventory, so the definition of
 * `tools_search` cannot read these from it while it is still loading.
 */
export const DEFAULT_SEARCH_LIMIT = 5;
export const MAX_SEARCH_LIMIT = 10;
