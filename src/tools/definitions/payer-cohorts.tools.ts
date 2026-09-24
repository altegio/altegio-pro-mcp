import { z } from 'zod';
import { defineTool } from '../factory.js';
import { getClientPayerCohorts } from '../../capabilities/analytics/payer-cohorts.js';

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
    '[Analytics] Rank identified paying clients by signed net cash receipts in service payments, product sales, miscellaneous income and client-account top-ups over up to 12 complete months. Returns top 10%, next 10%, remaining payer counts and cash, plus a page of stable client IDs for one cohort. Reads every selected transaction detail, verifies unrestricted finance history and authorized accounts, repeats the source list and reconciles each month to the finance report. Refuses oversized or changed sources; no partial cohort or contacts.',
  annotations: {
    title: 'Analytics: client payer cohorts',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive(),
    date_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('First day of the first local calendar month, YYYY-MM-DD.'),
    date_to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Last day of the final local calendar month, YYYY-MM-DD.'),
    target_cohort: z
      .enum(['top_payer_decile', 'next_payer_decile', 'remaining_payers'])
      .optional(),
    page: z.number().int().positive().optional(),
    page_size: z.number().int().min(1).max(100).optional(),
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
