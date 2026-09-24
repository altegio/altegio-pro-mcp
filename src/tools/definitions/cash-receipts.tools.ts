import { z } from 'zod';
import { defineTool } from '../factory.js';
import { getCustomerCashReceipts } from '../../capabilities/analytics/cash-receipts.js';

const number = { type: 'number' as const };
const text = { type: 'string' as const };
const object = (properties: Record<string, object>) => ({
  type: 'object' as const,
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const streams = object({
  services: number,
  products: number,
  client_account_topups: number,
  miscellaneous_income: number,
  memberships: number,
  gift_cards: number,
  penalties: number,
});

export const analyticsGetCustomerCashReceiptsTool = defineTool({
  name: 'analytics_get_customer_cash_receipts',
  category: 'Analytics',
  description:
    '[Analytics] Monthly net posted cash receipts by service payments, product sales, client-account top-ups, miscellaneous income, memberships, gift cards and penalties. Reconciles every local month against the authenticated finance report income total. A wallet top-up is counted on receipt; spending that wallet balance is not counted again. Custom income categories remain unclassified, and disabled historical custom categories can be omitted by the source. Signed refunds reduce net receipts but gross receipts and refund totals are unavailable. This is cash basis, separate from delivered service manual_cost. Requires the location finance annual-report right; account restrictions apply.',
  annotations: {
    title: 'Analytics: customer cash receipts',
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
      .describe(
        'Last day of the final local calendar month, YYYY-MM-DD. Up to 12 complete months.'
      ),
  }),
  outputSchema: object({
    location_id: { type: 'integer' },
    period: object({
      date_from: text,
      date_to: text,
      timezone: { type: ['string', 'null'] },
    }),
    currency: { type: ['string', 'null'] },
    months: {
      type: 'array',
      items: object({
        month: text,
        streams,
        classified_customer_cash_net: number,
        unclassified_category_count: { type: 'integer' },
        unclassified_posted_income_net: number,
        posted_income_net: number,
      }),
    },
    totals: object({
      streams,
      classified_customer_cash_net: number,
      unclassified_posted_income_net: number,
      posted_income_net: number,
    }),
    completeness: object({
      status: { type: 'string', const: 'reconciled_source_aggregate' },
      source: text,
      basis: text,
      limitations: { type: 'array', items: text },
    }),
  }),
  handler: async ({ client, input }) => getCustomerCashReceipts(client, input),
});
