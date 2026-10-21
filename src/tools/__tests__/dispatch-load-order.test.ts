/**
 * `../dispatch.ts` reaches every tool definition through the inventory, and
 * `tools_search` is one of them. Loaded first, it must still leave the search
 * tool its bounds: a definition that reads a value `../dispatch.ts` has not
 * initialised yet gets `undefined` here and a TDZ ReferenceError under Node's
 * ESM loader, which stops the server before it lists anything.
 *
 * `../dispatch.js` must stay this file's first import.
 */
import { searchTools } from '../dispatch.js';
import { toolsSearchTool } from '../definitions/dispatch.tools.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT } from '../dispatch-limits.js';

describe('loading the dispatcher before the tool definitions', () => {
  it('gives tools_search its limits', () => {
    const schema = toolsSearchTool.toMcpTool().inputSchema as {
      properties: { limit: { maximum?: number; description?: string } };
    };

    expect(typeof searchTools).toBe('function');
    expect(schema.properties.limit.maximum).toBe(MAX_SEARCH_LIMIT);
    expect(schema.properties.limit.description).toBe(
      `Matches to return; default ${DEFAULT_SEARCH_LIMIT}.`
    );
  });
});
