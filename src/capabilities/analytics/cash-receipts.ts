/** Monthly posted money receipts; the finance ledger remains authoritative. */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { V1LegacyAnalyticsAdapter } from '../../api/v1/legacy-analytics-adapter.js';
import { LegacyAnalyticsParseError } from '../../api/v1/legacy-analytics-parser.js';
import { AnalyticsInputError } from './errors.js';
import { AltegioApiError } from '../../utils/errors.js';

export interface CashReceiptsInput {
  location_id: number;
  date_from: string;
  date_to: string;
}

const STREAM_IDS = {
  services: 5,
  products: 7,
  client_account_topups: 10,
  miscellaneous_income: 8,
  memberships: 6,
  gift_cards: 12,
  penalties: 13,
} as const;

type Stream = keyof typeof STREAM_IDS;
const STREAMS = Object.keys(STREAM_IDS) as Stream[];

export function validatePeriod(from: string, to: string): void {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  if (
    !Number.isFinite(start.getTime()) ||
    !Number.isFinite(end.getTime()) ||
    start.toISOString().slice(0, 10) !== from ||
    end.toISOString().slice(0, 10) !== to ||
    start.getUTCDate() !== 1 ||
    end.getUTCDate() !==
      new Date(
        Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)
      ).getUTCDate() ||
    start > end
  ) {
    throw new AnalyticsInputError(
      'Select complete local calendar months: date_from must be the first day and date_to the last day.'
    );
  }
  const count =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    end.getUTCMonth() -
    start.getUTCMonth() +
    1;
  if (count > 12)
    throw new AnalyticsInputError(
      'Cash receipts cover at most 12 complete calendar months per call.'
    );
}

const money = (cents: number): number => cents / 100;

export async function assertFinanceReportAccess(
  client: AltegioClient,
  locationId: number
): Promise<Record<string, unknown>> {
  const response = await client.request<Record<string, unknown>>(
    'GET',
    `/user/permissions/${locationId}`
  );
  const finance = response.data.finances;
  if (!finance || typeof finance !== 'object' || Array.isArray(finance)) {
    throw new AltegioApiError(
      'Effective finance permissions could not be verified for this location.',
      502
    );
  }
  const rights = finance as Record<string, unknown>;
  if (rights.finances_year_report_access !== true) {
    throw new AltegioApiError(
      'The current user needs the finance annual-report right for this location.',
      403
    );
  }
  if (typeof rights.finances_accounts_limited_access !== 'boolean') {
    throw new AltegioApiError(
      'The effective finance account boundary could not be verified.',
      502
    );
  }
  if (rights.finances_accounts_limited_access) {
    const ids = rights.finances_accounts_ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      !ids.every((id) => Number.isSafeInteger(Number(id)) && Number(id) > 0)
    ) {
      throw new AltegioApiError(
        'No authorized finance accounts are listed for this account-limited user; the source report cannot be read safely.',
        403
      );
    }
  }
  return rights;
}

export async function getCustomerCashReceipts(
  client: AltegioClient,
  input: CashReceiptsInput
) {
  validatePeriod(input.date_from, input.date_to);
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
        (key) => STREAM_IDS[key] === category.category_id
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
      classified_customer_cash_net: money(classifiedCents),
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
      classified_customer_cash_net: money(classifiedTotalCents),
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
        'Custom income categories have no verified customer-payment meaning and remain unclassified.',
        'The source can omit historical transactions in custom categories that were later disabled; reconciliation proves source-table consistency, not complete ledger coverage.',
        'The report is an aggregate without a transaction snapshot or payer IDs; it cannot produce payer cohorts or stable client targets.',
        'Account access restrictions and the finance-report right determine which posted transactions the source includes.',
      ],
    },
  };
  return {
    text: `Reconciled posted income for ${months.length} local month(s): ${report.totals.posted_income_net} ${source.currency ?? 'currency units'}. Classified customer cash: ${report.totals.classified_customer_cash_net}.`,
    structuredContent: report,
  };
}
