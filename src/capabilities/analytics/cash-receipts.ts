/** Monthly posted money receipts; the finance ledger remains authoritative. */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { V1LegacyAnalyticsAdapter } from '../../api/v1/legacy-analytics-adapter.js';
import { LegacyAnalyticsParseError } from '../../api/v1/legacy-analytics-parser.js';
import {
  INCOME_CATEGORY_IDS,
  assertFinanceReportAccess,
  validateCompleteMonths,
} from './finance-access.js';

export interface CashReceiptsInput {
  location_id: number;
  date_from: string;
  date_to: string;
}

type Stream = keyof typeof INCOME_CATEGORY_IDS;
const STREAMS = Object.keys(INCOME_CATEGORY_IDS) as Stream[];

const money = (cents: number): number => cents / 100;

export async function getClientCashReceipts(
  client: AltegioClient,
  input: CashReceiptsInput
) {
  validateCompleteMonths(input.date_from, input.date_to);
  await assertFinanceReportAccess(client, input.location_id);
  const source = await new V1LegacyAnalyticsAdapter(
    client
  ).getPostedIncomeMonths(input);
  const totals = Object.fromEntries(
    STREAMS.map((stream) => [stream, 0])
  ) as Record<Stream, number>;
  let totalPostedCents = 0;
  let totalUnclassifiedCents = 0;
  const months = source.months.map((month) => {
    const amounts = Object.fromEntries(
      STREAMS.map((stream) => [stream, 0])
    ) as Record<Stream, number>;
    let unclassifiedCents = 0;
    let unclassifiedCategoryCount = 0;
    for (const category of month.categories) {
      const stream = STREAMS.find(
        (key) => INCOME_CATEGORY_IDS[key] === category.category_id
      );
      if (stream) amounts[stream] = category.amount;
      else if (category.amount !== 0) {
        unclassifiedCents += Math.round(category.amount * 100);
        unclassifiedCategoryCount += 1;
      }
    }
    const classifiedCents = STREAMS.reduce(
      (sum, stream) => sum + Math.round(amounts[stream] * 100),
      0
    );
    const postedCents = Math.round(month.income_total * 100);
    if (classifiedCents + unclassifiedCents !== postedCents) {
      throw new LegacyAnalyticsParseError(
        'cash receipts',
        'classified income components do not reconcile'
      );
    }
    for (const stream of STREAMS)
      totals[stream] += Math.round(amounts[stream] * 100);
    totalPostedCents += postedCents;
    totalUnclassifiedCents += unclassifiedCents;
    return {
      month: month.month,
      streams: amounts,
      classified_client_cash_net: money(classifiedCents),
      unclassified_category_count: unclassifiedCategoryCount,
      unclassified_posted_income_net: money(unclassifiedCents),
      posted_income_net: money(postedCents),
    };
  });
  const classifiedTotalCents = STREAMS.reduce(
    (sum, stream) => sum + totals[stream],
    0
  );
  if (classifiedTotalCents + totalUnclassifiedCents !== totalPostedCents) {
    throw new LegacyAnalyticsParseError(
      'cash receipts',
      'period income components do not reconcile'
    );
  }
  const report = {
    location_id: input.location_id,
    period: {
      date_from: input.date_from,
      date_to: input.date_to,
      timezone: source.timezone,
    },
    currency: source.currency,
    months,
    totals: {
      streams: Object.fromEntries(
        STREAMS.map((stream) => [stream, money(totals[stream])])
      ),
      classified_client_cash_net: money(classifiedTotalCents),
      unclassified_posted_income_net: money(totalUnclassifiedCents),
      posted_income_net: money(totalPostedCents),
    },
    completeness: {
      status: 'reconciled_source_aggregate',
      source: 'authenticated_location_finance_annual_report',
      basis:
        'active signed finance transactions posted to authorized location cash accounts, grouped by local transaction month and income category',
      limitations: [
        'Amounts are net of signed refunds or reversals; gross receipts and refund totals are not separately exposed by this source.',
        'Custom income categories have no verified client-payment meaning and remain unclassified.',
        'The source can omit historical transactions in custom categories that were later disabled; reconciliation proves source-table consistency, not complete ledger coverage.',
        'The report is an aggregate without a transaction snapshot or client IDs; payer cohorts with stable client IDs come from analytics_get_client_payer_cohorts.',
        'Account access restrictions and the finance-report right determine which posted transactions the source includes.',
      ],
    },
  };
  return {
    text: `Reconciled posted income for ${months.length} local month(s): ${report.totals.posted_income_net} ${source.currency ?? 'currency units'}. Classified client cash: ${report.totals.classified_client_cash_net}.`,
    structuredContent: report,
  };
}
