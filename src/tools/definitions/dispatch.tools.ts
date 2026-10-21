/**
 * The curated-tool dispatcher, listed on `/mcp/compact` (see `../dispatch.ts`).
 *
 * `tools_search` is an ordinary tool. `tools_call_read` and `tools_call_write`
 * are definitions for the listing only: the registry's `tools/call` handler
 * resolves them to the tool they name before any handler runs, so the target's
 * scope, confirmation and validation apply exactly as on a direct call. Their
 * handlers answer only a caller that bypasses the registry.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import {
  DISPATCH_READ_TOOL,
  DISPATCH_SEARCH_TOOL,
  DISPATCH_WRITE_TOOL,
} from '../facets.js';
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  searchText,
  searchTools,
} from '../dispatch.js';

const searchOutput = {
  type: 'object' as const,
  properties: {
    query: { type: 'string' as const },
    matches: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const },
          call_with: {
            type: 'string' as const,
            enum: [DISPATCH_READ_TOOL, DISPATCH_WRITE_TOOL],
          },
          listed: { type: 'boolean' as const },
          asks_confirmation: { type: 'boolean' as const },
          description: { type: 'string' as const },
          input_schema: { type: 'object' as const },
        },
        required: [
          'name',
          'call_with',
          'listed',
          'asks_confirmation',
          'description',
        ],
      },
    },
    total_matches: { type: 'integer' as const },
  },
  required: ['query', 'matches', 'total_matches'],
};

export const toolsSearchTool = defineTool({
  name: DISPATCH_SEARCH_TOOL,
  category: 'Tools',
  description:
    'Find a tool this address does not list. Returns the best matches for a task, each with its ' +
    `description, input schema and the dispatcher that runs it: ${DISPATCH_READ_TOOL} for a read, ` +
    `${DISPATCH_WRITE_TOOL} for a change. Search in the user's words ("record an expense", ` +
    '"freeze a membership", "revenue by team member") or by a tool name a result mentioned.',
  annotations: {
    title: 'Search Tools',
    readOnlyHint: true,
    openWorldHint: false,
  },
  input: z.object({
    query: z.string().min(1).max(200).describe('The task, or a tool name.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_LIMIT)
      .optional()
      .describe(`Matches to return; default ${DEFAULT_SEARCH_LIMIT}.`),
  }),
  outputSchema: searchOutput,
  handler: async ({ input }) => {
    const result = searchTools(input.query, input.limit);
    return { text: searchText(result), structuredContent: result };
  },
});

const callInput = z.object({
  tool: z.string().min(1).max(64).describe('Tool name, from tools_search.'),
  arguments: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Its arguments, as its input schema defines them.'),
});

/** What a dispatcher answers when something runs it outside the registry. */
const notDispatched = async () => ({
  text: 'This dispatcher runs only through the server’s tools/call handler.',
  isError: true,
});

export const toolsCallReadTool = defineTool({
  name: DISPATCH_READ_TOOL,
  category: 'Tools',
  description:
    'Run a read-only tool by name, with its arguments; find it with tools_search. It validates ' +
    'and answers exactly as if called directly. Refuses a tool that changes data: run that with ' +
    `${DISPATCH_WRITE_TOOL}.`,
  annotations: {
    title: 'Run a Read Tool',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: callInput,
  handler: notDispatched,
});

export const toolsCallWriteTool = defineTool({
  name: DISPATCH_WRITE_TOOL,
  category: 'Tools',
  description:
    'Run a tool that changes data, by name, with its arguments; find it with tools_search. It ' +
    'validates, checks access and asks for confirmation exactly as if called directly: after ' +
    'confirmation_required, repeat with confirmation_token inside arguments. Refuses a read: run ' +
    `that with ${DISPATCH_READ_TOOL}.`,
  // It may run a deletion, so it says so. It has no confirmation of its own:
  // a destructive tool it runs asks for its own, through the registry, so a
  // second prompt for the dispatcher would only ask twice.
  annotations: {
    title: 'Run a Write Tool',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: callInput,
  handler: notDispatched,
});
