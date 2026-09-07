/**
 * Universal executor tools (ADR-001 D2, third tier).
 *
 * Three tools cover every documented operation of the Altegio API the day the
 * spec changes, before anyone curates a task-shaped tool for it: search the
 * catalog, read one operation's contract, execute a documented read. They are
 * thin definitions — the catalog index, ranking, validation, projection and
 * size budget live in `../executor/`.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { catalog } from '../executor/catalog.js';
import { MAX_SEARCH_RESULTS, searchOperations } from '../executor/search.js';
import { describeOperation } from '../executor/describe.js';
import { callOperation } from '../executor/call.js';

const DOMAINS = catalog.domains.map((d) => d.domain).join(', ');

const searchOutput = {
  type: 'object' as const,
  properties: {
    matches: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          operationId: { type: 'string' as const },
          method: { type: 'string' as const },
          path: { type: 'string' as const },
          summary: { type: 'string' as const },
          domain: { type: 'string' as const },
          source: { type: 'string' as const },
          score: { type: 'number' as const },
          deprecated: { type: 'boolean' as const },
          status: { type: 'string' as const },
          tool: { type: 'string' as const },
        },
        required: ['operationId', 'method', 'path', 'domain', 'source'],
      },
    },
    count: { type: 'number' as const },
    total_matches: { type: 'number' as const },
    terms: { type: 'array' as const, items: { type: 'string' as const } },
  },
  required: ['matches', 'count', 'total_matches'],
};

export const searchOperationsTool = defineTool({
  name: 'altegio_search_operations',
  category: 'API',
  description:
    '[API] Find the API operations behind a business question — "who worked last Tuesday", ' +
    '"loyalty card balance", "cash register shifts" — when no dedicated tool covers it. ' +
    'Returns up to 10 operations with their operationId, method, canonical path, one-line ' +
    'summary and domain, and names the curated tool when one already exists (prefer that ' +
    'tool over the executor). Use this first, then `altegio_describe_operation` to read the ' +
    'contract and `altegio_call_operation` to run a read. Searches the whole documented API ' +
    `(${catalog.operationCount} operations); results are ranked locally, no data leaves the server.`,
  annotations: {
    title: 'Search API Operations',
    readOnlyHint: true,
    openWorldHint: false,
  },
  input: z.object({
    query: z
      .string()
      .min(1)
      .describe(
        'What you are looking for, in words or keywords: "team member schedule", ' +
          '"client visit history", "product stock", or an exact operationId.'
      ),
    domain: z
      .string()
      .optional()
      .describe(`Restrict to one domain. Available: ${DOMAINS}.`),
    method: z
      .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
      .optional()
      .describe(
        'Restrict to one HTTP method. Use GET to see only what the executor can run.'
      ),
    include_preview: z
      .boolean()
      .optional()
      .describe(
        'Include V3 preview operations. They document the future contract but are not ' +
          'served by the live API yet, so they cannot be called. Default false.'
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_SEARCH_RESULTS)
      .optional()
      .describe(`Maximum operations to return (1-${MAX_SEARCH_RESULTS}).`),
  }),
  outputSchema: searchOutput,
  handler: async ({ input }) => {
    const result = searchOperations(input.query, {
      domain: input.domain,
      method: input.method,
      includePreview: input.include_preview,
      limit: input.limit,
    });

    if (result.hits.length === 0) {
      return {
        text:
          `No operation matches "${input.query}" among ${result.searched} searched operations.\n` +
          'Try fewer or broader words, drop the `domain` filter, or set `include_preview` ' +
          `to also search the V3 contract. Domains: ${DOMAINS}.`,
        structuredContent: {
          matches: [],
          count: 0,
          total_matches: 0,
          terms: result.terms,
        },
      };
    }

    const lines = result.hits.map((hit, index) => {
      const flags = [
        hit.source !== 'v1' ? `${hit.source} ${hit.status ?? 'preview'}` : null,
        hit.deprecated ? 'deprecated' : null,
      ].filter(Boolean);
      return (
        `${index + 1}. ${hit.operationId} — ${hit.method} ${hit.path}\n` +
        `   ${hit.summary || '(no summary in the spec)'}\n` +
        `   domain: ${hit.domain}${flags.length > 0 ? ` · ${flags.join(' · ')}` : ''}` +
        (hit.tool
          ? `\n   curated tool: ${hit.tool} — prefer it over the executor`
          : '')
      );
    });

    return {
      text:
        `${result.totalMatches} operation(s) match "${input.query}"; showing ${result.hits.length}:\n\n` +
        `${lines.join('\n\n')}\n\n` +
        'Next: `altegio_describe_operation` for the full contract, then ' +
        '`altegio_call_operation` to run a GET.',
      structuredContent: {
        matches: result.hits,
        count: result.hits.length,
        total_matches: result.totalMatches,
        terms: result.terms,
      },
    };
  },
});

export const describeOperationTool = defineTool({
  name: 'altegio_describe_operation',
  category: 'API',
  description:
    '[API] Read the full contract of one API operation before calling it: every parameter ' +
    'with type, requiredness and description, the request body shape, the response shape, ' +
    'whether a logged-in session is needed, whether it is deprecated, which spec it comes ' +
    'from, and which legacy parameter names are accepted under canonical ones (for example ' +
    '`staff_id` is accepted as `team_member_id`). Use it after `altegio_search_operations` ' +
    'and before `altegio_call_operation`. Reads the built-in catalog only — no API call.',
  annotations: {
    title: 'Describe API Operation',
    readOnlyHint: true,
    openWorldHint: false,
  },
  input: z.object({
    operation_id: z
      .string()
      .min(1)
      .describe(
        'The operationId from `altegio_search_operations`, e.g. `get_team_member_list`.'
      ),
  }),
  handler: async ({ input }) => {
    const described = describeOperation(input.operation_id);
    return {
      text: described.text,
      structuredContent: described.structuredContent,
    };
  },
});

export const callOperationTool = defineTool({
  name: 'altegio_call_operation',
  category: 'API',
  description:
    '[API] Run a documented read against the Altegio API when no curated tool covers it. ' +
    'Give the operationId from `altegio_search_operations` and its parameters under `params`; ' +
    'canonical names are accepted (`location_id`, `team_member_id`, `appointment_id`, ' +
    '`product_id`), required parameters are validated against the spec, and the result comes ' +
    'back projected and inside the size budget. READS ONLY: a POST, PUT, PATCH or DELETE ' +
    'operation is refused — writes go through the curated tools. Prefer a curated tool ' +
    'whenever `altegio_search_operations` names one. AUTHENTICATION REQUIRED.',
  annotations: {
    title: 'Call API Operation (read-only)',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    operation_id: z
      .string()
      .min(1)
      .describe(
        'The operationId to execute, e.g. `get_team_member_list`. Must be a GET operation.'
      ),
    params: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Path and query parameters by name, e.g. {"location_id": 4564, "count": 30}. ' +
          'Call `altegio_describe_operation` for the accepted names and types.'
      ),
  }),
  handler: async ({ input, client }) => {
    const result = await callOperation(
      client,
      input.operation_id,
      input.params ?? {}
    );
    return { text: result.text, structuredContent: result.structuredContent };
  },
});
