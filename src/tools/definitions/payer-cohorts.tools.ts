import { z } from 'zod';
import { defineTool } from '../factory.js';
import { getClientPayerCohorts } from '../../capabilities/analytics/payer-cohorts.js';
import { completeMonthsInput } from './finance-period.schema.js';

const integer = { type: 'integer' as const };
const number = { type: 'number' as const };
const string = { type: 'string' as const };
const object = (properties: Record<string, object>) => ({
  type: 'object' as const,
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

export const analyticsGetClientPayerCohortsTool = defineTool({
  name: 'analytics_get_client_payer_cohorts',
  category: 'Analytics',
  description:
    '[Analytics] Rank identified paying clients by signed net cash receipts in service payments, product sales, miscellaneous income and client-account top-ups over up to 12 complete local months. Returns top 10%, next 10% and remaining payer counts and cash, plus a page of stable client ids for one cohort. Reads every selected finance transaction (at most 4,000), verifies unrestricted finance history and authorized accounts, repeats the source list and reconciles each month to the finance report. Refuses oversized or changed sources; never returns a partial cohort or contacts. For monthly receipts by stream use analytics_get_client_cash_receipts.',
  annotations: {
    title: 'Analytics: client payer cohorts',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    ...completeMonthsInput,
    target_cohort: z
      .enum(['top_payer_decile', 'next_payer_decile', 'remaining_payers'])
      .optional()
      .describe(
        'Cohort whose client ids to page through (default top_payer_decile).'
      ),
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Page of client ids, starting at 1.'),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Client ids per page, at most 100. Default 50.'),
  }),
  outputSchema: object({
    location_id: integer,
    period: object({
      date_from: string,
      date_to: string,
      timezone: string,
    }),
    currency: { type: ['string', 'null'] },
    payer_count: integer,
    clients_with_zero_or_negative_net: integer,
    unattributed_cash_net: number,
    cohorts: {
      type: 'array',
      items: object({ name: string, payer_count: integer, net_cash: number }),
    },
    target_cohort: string,
    target_client_ids: { type: 'array', items: integer },
    page: object({
      page: integer,
      page_size: integer,
      total_count: integer,
      has_more: { type: 'boolean' },
    }),
    completeness: object({
      status: { type: 'string', const: 'reconciled_bounded_scan' },
      selected_transaction_count: integer,
      scanned_at: string,
      source: string,
      basis: string,
      rank_rule: string,
      limitations: { type: 'array', items: string },
    }),
  }),
  handler: async ({ client, input }) => getClientPayerCohorts(client, input),
});
