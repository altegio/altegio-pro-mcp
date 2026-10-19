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
import { catalog, isLiveSource } from '../executor/catalog.js';
import { MAX_SEARCH_RESULTS, searchOperations } from '../executor/search.js';
import { describeOperation } from '../executor/describe.js';
import { callOperation, parameterNamesFor } from '../executor/call.js';
import { foldCallArguments, takeFoldNotes } from '../executor/input.js';
import { includeContactsArg } from '../contacts.js';
import { ExecutorRefusalError } from '../../utils/errors.js';
import { currentView, elsewhereClause } from '../serving-view.js';
import { MISSING_OPERATION_NUDGE } from './feedback.tools.js';
import {
  pageArg,
  pageMetadata,
  pageSizeArg,
  paginationOutput,
} from '../pagination.js';

const DOMAINS = catalog.domains.map((d) => d.domain).join(', ');

const searchOutput = {
  type: 'object' as const,
  properties: {
    items: {
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
          tool_served: { type: 'boolean' as const },
        },
        required: ['operationId', 'method', 'path', 'domain'],
      },
    },
    pagination: paginationOutput,
    terms: { type: 'array' as const, items: { type: 'string' as const } },
  },
  required: ['items', 'pagination'],
};

export const searchOperationsTool = defineTool({
  name: 'api_search_operations',
  category: 'API',
  description:
    'Find the API operations behind a business question — "who worked last Tuesday", ' +
    '"loyalty card balance", "cash register shifts" — when no dedicated tool covers it. ' +
    `Returns a page of up to ${MAX_SEARCH_RESULTS} operations with their operationId, method, canonical path, one-line ` +
    'summary and domain, and names the curated tool when one already exists (prefer that ' +
    'tool over the executor). Use this first, then `api_describe_operation` to read the ' +
    'contract and `api_call_operation` to run a read. Searches the whole documented API ' +
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
    page: pageArg,
    page_size: pageSizeArg(MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS),
  }),
  outputSchema: searchOutput,
  handler: async ({ input }) => {
    const result = searchOperations(input.query, {
      domain: input.domain,
      method: input.method,
      includePreview: input.include_preview,
      page: input.page,
      limit: input.page_size,
    });
    const pagination = pageMetadata(
      input,
      result.hits.length,
      result.totalMatches
    );

    if (result.hits.length === 0) {
      return {
        text:
          `No operation matches "${input.query}" among ${result.searched} searched operations.\n` +
          'Try fewer or broader words, drop the `domain` filter, or set `include_preview` ' +
          `to also search the V3 contract. Domains: ${DOMAINS}.` +
          (result.totalMatches === 0 ? `\n${MISSING_OPERATION_NUDGE}` : ''),
        structuredContent: {
          items: [],
          pagination,
          terms: result.terms,
        },
      };
    }

    // A curated tool this view does not serve is still named — it is where the
    // operation lives — but not offered as callable (`../serving-view.ts`).
    const items = result.hits.map((hit) =>
      hit.tool && !currentView().serves(hit.tool)
        ? { ...hit, tool_served: false }
        : hit
    );
    const lines = items.map((hit, index) => {
      const flags = [
        hit.source && !isLiveSource(hit.source)
          ? `${hit.source} ${hit.status ?? 'preview'}`
          : null,
        hit.deprecated ? 'deprecated' : null,
      ].filter(Boolean);
      return (
        `${index + 1}. ${hit.operationId} — ${hit.method} ${hit.path}\n` +
        `   ${hit.summary || '(no summary in the spec)'}\n` +
        `   domain: ${hit.domain}${flags.length > 0 ? ` · ${flags.join(' · ')}` : ''}` +
        (hit.tool
          ? 'tool_served' in hit
            ? `\n   curated tool: ${hit.tool} — not served on this address; ${elsewhereClause(hit.tool)}`
            : `\n   curated tool: ${hit.tool} — prefer it over the executor`
          : '')
      );
    });

    // Curated tools first: they answer the question with the projection and
    // paging the executor can only approximate.
    const curated = [
      ...new Set(
        items
          .filter((hit) => hit.tool && !('tool_served' in hit))
          .map((hit) => `\`${hit.tool}\``)
      ),
    ];
    const header = curated.length
      ? `Curated tools cover some of these — prefer them: ${curated.join(', ')}.\n\n`
      : '';

    return {
      text:
        header +
        `${result.totalMatches} relevant operation(s) for "${input.query}"; showing ${result.hits.length}:\n\n` +
        `${lines.join('\n\n')}\n\n` +
        'Next: `api_describe_operation` for the full contract, then ' +
        '`api_call_operation` to run a GET.',
      structuredContent: {
        items,
        pagination,
        terms: result.terms,
      },
    };
  },
});

export const describeOperationTool = defineTool({
  name: 'api_describe_operation',
  category: 'API',
  description:
    'Read the full contract of one API operation before calling it: every parameter ' +
    'with its canonical name, type, requiredness and description, the request body shape, the ' +
    'response shape in the product glossary, whether a logged-in session is needed, whether it ' +
    'is deprecated or only a preview of a future contract, and which legacy names are accepted ' +
    'under canonical ones (for example `staff_id` as `team_member_id`, `count` as `page_size`, ' +
    '`start_date` as `date_from`). Use it after `api_search_operations` ' +
    'and before `api_call_operation`. Reads the built-in catalog only — no API call.',
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
        'The operationId from `api_search_operations`, e.g. `list_team_members`.'
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
  name: 'api_call_operation',
  category: 'API',
  description:
    'Run a documented read against the Altegio API when no curated tool covers it. ' +
    'Give the operationId from `api_search_operations` and every path and query parameter in ' +
    'one flat `params` object, in canonical names (`location_id`, `team_member_id`, ' +
    '`appointment_id`, `date_from`, `date_to`, `page`, `page_size`). The result comes back in the ' +
    'product glossary and inside the size budget; a list that does not fit returns the items that ' +
    'do plus the exact next `page`/`page_size`. Client phone and email are withheld unless ' +
    '`include_contacts` is true. READS ONLY: a POST, PUT, PATCH or DELETE operation is refused — ' +
    'writes go through the curated tools. Prefer a curated tool whenever ' +
    '`api_search_operations` names one. AUTHENTICATION REQUIRED.',
  annotations: {
    title: 'Call API Operation (read-only)',
    readOnlyHint: true,
    openWorldHint: true,
  },
  // Misplaced shapes (`path_params`, `query`, `arguments`, `operationId`,
  // top-level parameters) are folded into `params` before validation, so a
  // wrong shape gets an answer that names `params`, not "Unrecognized key".
  input: z.preprocess(
    foldCallArguments,
    z
      .object({
        operation_id: z
          .string()
          .describe(
            'The operationId to execute, e.g. `list_team_members`. Must be a GET operation.'
          ),
        params: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Every path and query parameter, flat, by canonical name, e.g. ' +
              '{"location_id": 4564, "date_from": "2026-10-01", "date_to": "2026-10-07", "page_size": 25}. ' +
              'Call `api_describe_operation` for the accepted names and types.'
          ),
        include_contacts: includeContactsArg,
      })
      .strict()
  ),
  handler: async ({ input, client }) => {
    const { params, folded, invalid } = takeFoldNotes(input.params ?? {});
    const shape =
      '`api_call_operation` takes `operation_id` and one flat `params` object with every ' +
      'path and query parameter, e.g. {"operation_id": "get_appointment", "params": ' +
      '{"location_id": 4564, "appointment_id": 675876978}}.';
    if (!input.operation_id) {
      throw new ExecutorRefusalError(
        `${shape} \`operation_id\` is missing — find it with \`api_search_operations\`.`,
        { reason: 'missing_operation_id' }
      );
    }
    if (invalid.length > 0) {
      throw new ExecutorRefusalError(
        `${shape} ${invalid.map((key) => `\`${key}\``).join(', ')} could not be read as ` +
          'an object of parameter names to values. Parameters of ' +
          `\`${input.operation_id}\`: ${parameterNamesFor(input.operation_id)}.`,
        { reason: 'invalid_params', fields: invalid }
      );
    }
    const notes =
      folded.length > 0
        ? [
            `Read ${folded.map((key) => `\`${key}\``).join(', ')} as parameters; ` +
              'next time put every path and query parameter in one flat `params` object.',
          ]
        : [];
    const result = await callOperation(client, input.operation_id, params, {
      includeContacts: input.include_contacts === true,
      notes,
    });
    return { text: result.text, structuredContent: result.structuredContent };
  },
});
