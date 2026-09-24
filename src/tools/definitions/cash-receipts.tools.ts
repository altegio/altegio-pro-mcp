import { z } from 'zod';
import { defineTool } from '../factory.js';
import { getClientCashReceipts } from '../../capabilities/analytics/cash-receipts.js';
import { completeMonthsInput } from './finance-period.schema.js';

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

export const analyticsGetClientCashReceiptsTool = defineTool({
  name: 'analytics_get_client_cash_receipts',
  category: 'Analytics',
  description:
    '[Analytics] Monthly net posted cash receipts by service payments, product sales, client-account top-ups, miscellaneous income, memberships, gift cards and penalties, for up to 12 complete local calendar months. Reconciles every month against the authenticated finance report income total. A client-account top-up is counted when received; spending that balance later is not counted again. Custom income categories remain unclassified, and disabled historical custom categories can be omitted by the source. Signed refunds reduce net receipts; gross receipts and refund totals are unavailable. This is cash basis, separate from the delivered service value of analytics_get_service_mix_trend; for ranked paying clients use analytics_get_client_payer_cohorts. Requires the location finance annual-report right; account restrictions apply.',
  annotations: {
    title: 'Analytics: client cash receipts',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object(completeMonthsInput),
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
        classified_client_cash_net: number,
        unclassified_category_count: { type: 'integer' },
        unclassified_posted_income_net: number,
        posted_income_net: number,
      }),
    },
    totals: object({
      streams,
      classified_client_cash_net: number,
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
  handler: async ({ client, input }) => getClientCashReceipts(client, input),
});
