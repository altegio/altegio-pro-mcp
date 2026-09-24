/** Cash-basis payer cohorts from bounded, permission-filtered finance reads. */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { V1LegacyAnalyticsAdapter } from '../../api/v1/legacy-analytics-adapter.js';
import { AltegioApiError } from '../../utils/errors.js';
import { LegacyAnalyticsParseError } from '../../api/v1/legacy-analytics-parser.js';
import { assertFinanceReportAccess, validatePeriod } from './cash-receipts.js';

const TYPES = [5, 7, 8, 10] as const;
const PAGE_SIZE = 200;
const MAX_TRANSACTIONS = 4000;
const CONCURRENCY = 16;
type CohortName = 'top_payer_decile' | 'next_payer_decile' | 'remaining_payers';

export interface PayerCohortsInput {
  location_id: number;
  date_from: string;
  date_to: string;
  target_cohort?: CohortName;
  page?: number;
  page_size?: number;
}

interface FinanceTransaction {
  id: number;
  date: string;
  type_id: number;
  account_id: number;
  amount: number;
  client_id: number;
}

function transaction(value: unknown, expectedId: number): FinanceTransaction {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new LegacyAnalyticsParseError(
      'payer cohorts',
      'missing transaction data'
    );
  const row = value as Record<string, unknown>;
  for (const field of ['id', 'type_id', 'account_id', 'client_id']) {
    if (!Number.isSafeInteger(Number(row[field])))
      throw new LegacyAnalyticsParseError(
        'payer cohorts',
        'invalid transaction identity'
      );
  }
  if (
    Number(row.id) !== expectedId ||
    Number(row.type_id) <= 0 ||
    Number(row.account_id) <= 0 ||
    Number(row.client_id) < 0 ||
    typeof row.date !== 'string' ||
    !Number.isFinite(Number(row.amount)) ||
    !Number.isSafeInteger(Math.round(Number(row.amount) * 100)) ||
    Math.abs(Number(row.amount) * 100 - Math.round(Number(row.amount) * 100)) >
      0.001
  )
    throw new LegacyAnalyticsParseError(
      'payer cohorts',
      'invalid transaction detail'
    );
  return {
    id: Number(row.id),
    date: row.date,
    type_id: Number(row.type_id),
    account_id: Number(row.account_id),
    amount: Number(row.amount),
    client_id: Number(row.client_id),
  };
}

async function scanIds(
  adapter: V1LegacyAnalyticsAdapter,
  input: PayerCohortsInput
): Promise<Array<{ id: number; type: number; local_date: string }>> {
  const ids: Array<{ id: number; type: number; local_date: string }> = [];
  const seen = new Set<number>();
  for (const type of TYPES) {
    let count: number | null = null;
    for (let page = 1; ; page++) {
      const result = await adapter.getFinanceTransactionIdsPage({
        location_id: input.location_id,
        date_from: input.date_from,
        date_to: input.date_to,
        type_id: type,
        page,
        page_size: PAGE_SIZE,
      });
      if (count === null) {
        count = result.count;
        if (ids.length + count > MAX_TRANSACTIONS)
          throw new AltegioApiError(
            `Payer cohorts need ${ids.length + count} finance detail reads, above the ${MAX_TRANSACTIONS} transaction limit. Narrow the period; no partial cohort was returned.`,
            413
          );
      } else if (result.count !== count) {
        throw new LegacyAnalyticsParseError(
          'payer cohorts',
          'the finance count changed during pagination'
        );
      }
      for (const row of result.rows) {
        if (seen.has(row.id))
          throw new LegacyAnalyticsParseError(
            'payer cohorts',
            'duplicate transaction across pages'
          );
        seen.add(row.id);
        ids.push({ id: row.id, type, local_date: row.local_date });
      }
      if (page * PAGE_SIZE >= count) break;
    }
  }
  return ids;
}

/** Every requested transaction must be read; an access error aborts the whole report. */
async function readDetails(
  client: AltegioClient,
  input: PayerCohortsInput,
  ids: Array<{ id: number; type: number; local_date: string }>,
  allowedAccounts: Set<number> | null
): Promise<FinanceTransaction[]> {
  const rows = new Array<FinanceTransaction>(ids.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
      while (next < ids.length) {
        const index = next++;
        const expected = ids[index]!;
        const response = await client.request<unknown>(
          'GET',
          `/finance_transactions/${input.location_id}/${expected.id}`
        );
        const row = transaction(response.data, expected.id);
        if (
          row.type_id !== expected.type ||
          (allowedAccounts && !allowedAccounts.has(row.account_id))
        )
          throw new LegacyAnalyticsParseError(
            'payer cohorts',
            'a transaction changed or fell outside the authorized source'
          );
        rows[index] = row;
      }
    })
  );
  return rows;
}

export async function getClientPayerCohorts(
  client: AltegioClient,
  input: PayerCohortsInput
) {
  validatePeriod(input.date_from, input.date_to);
  const rights = await assertFinanceReportAccess(client, input.location_id);
  if (
    rights.finances_transactions_access !== true ||
    rights.finances_access !== true
  )
    throw new AltegioApiError(
      'The current user needs finance transaction and finance access for payer cohorts.',
      403
    );
  // Both the web list and the V1 detail route silently enforce this limit.
  // Refuse it rather than returning a complete-looking shortened period.
  if (Number(rights.finances_last_days_count) !== -1)
    throw new AltegioApiError(
      'Payer cohorts require unrestricted finance transaction history. This user has a last-days limit that can silently shorten the requested period.',
      403
    );
  const allowedAccounts =
    rights.finances_accounts_limited_access === true
      ? new Set((rights.finances_accounts_ids as unknown[]).map(Number))
      : null;
  const adapter = new V1LegacyAnalyticsAdapter(client);
  const source = await adapter.getPostedIncomeMonths(input);
  if (!source.timezone)
    throw new LegacyAnalyticsParseError(
      'payer cohorts',
      'location timezone unavailable'
    );
  const firstIds = await scanIds(adapter, input);
  const details = await readDetails(client, input, firstIds, allowedAccounts);
  const secondIds = await scanIds(adapter, input);
  if (
    secondIds.length !== firstIds.length ||
    secondIds.some(
      (entry, index) =>
        entry.id !== firstIds[index]!.id ||
        entry.type !== firstIds[index]!.type ||
        entry.local_date !== firstIds[index]!.local_date
    )
  )
    throw new LegacyAnalyticsParseError(
      'payer cohorts',
      'the finance list changed during the scan'
    );

  const monthly = new Map<string, Map<number, number>>();
  const byClient = new Map<number, number>();
  let unattributedCents = 0;
  for (const [index, row] of details.entries()) {
    const month = firstIds[index]!.local_date.slice(0, 7);
    const amount = Math.round(row.amount * 100);
    const byType = monthly.get(month) ?? new Map<number, number>();
    byType.set(row.type_id, (byType.get(row.type_id) ?? 0) + amount);
    monthly.set(month, byType);
    if (row.client_id > 0)
      byClient.set(row.client_id, (byClient.get(row.client_id) ?? 0) + amount);
    else unattributedCents += amount;
  }
  for (const month of source.months) {
    const observed = monthly.get(month.month);
    for (const type of TYPES) {
      const expected = Math.round(
        (month.categories.find((item) => item.category_id === type)?.amount ??
          0) * 100
      );
      if ((observed?.get(type) ?? 0) !== expected)
        throw new LegacyAnalyticsParseError(
          'payer cohorts',
          'transaction amounts did not reconcile with the monthly finance report'
        );
    }
  }

  const ranked = [...byClient.entries()]
    .filter(([, amount]) => amount > 0)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const decile = Math.floor(ranked.length / 10);
  const cohorts: Array<{ name: CohortName; members: typeof ranked }> = [
    { name: 'top_payer_decile', members: ranked.slice(0, decile) },
    { name: 'next_payer_decile', members: ranked.slice(decile, 2 * decile) },
    { name: 'remaining_payers', members: ranked.slice(2 * decile) },
  ];
  const cohortRows = cohorts.map(({ name, members }) => ({
    name,
    payer_count: members.length,
    net_cash: members.reduce((sum, [, amount]) => sum + amount, 0) / 100,
  }));
  const selected = cohorts.find(
    (item) => item.name === (input.target_cohort ?? 'top_payer_decile')
  )!;
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? 50;
  return {
    text: `${ranked.length} identified clients had positive net cash receipts across ${details.length} selected finance transactions. ${unattributedCents / 100} ${source.currency ?? 'currency units'} could not be tied to a client.`,
    structuredContent: {
      location_id: input.location_id,
      period: {
        date_from: input.date_from,
        date_to: input.date_to,
        timezone: source.timezone,
      },
      currency: source.currency,
      payer_count: ranked.length,
      clients_with_zero_or_negative_net: [...byClient.values()].filter(
        (amount) => amount <= 0
      ).length,
      unattributed_cash_net: unattributedCents / 100,
      cohorts: cohortRows,
      target_cohort: selected.name,
      target_client_ids: selected.members
        .slice((page - 1) * pageSize, page * pageSize)
        .map(([id]) => id),
      page: {
        page,
        page_size: pageSize,
        total_count: selected.members.length,
        has_more: page * pageSize < selected.members.length,
      },
      completeness: {
        status: 'reconciled_bounded_scan',
        selected_transaction_count: details.length,
        scanned_at: new Date().toISOString(),
        source:
          'authenticated finance transaction list and documented V1 finance detail, reconciled to the monthly finance report',
        basis:
          'signed net receipts in service payments, product sales, miscellaneous income and client-account top-ups; only identified clients with positive period net enter payer ranks',
        rank_rule:
          'descending period net cash, ties by ascending client id; first floor(N/10), next floor(N/10), then remainder',
        limitations: [
          'Each call recomputes the report; pages requested at different times can reflect later ledger edits.',
          'The double list scan and monthly amount reconciliation detect many edits but are not a transactional snapshot.',
          'Finance account and expense permissions restrict the source; this is the authorized-account cohort.',
          'Transactions without a client ID remain unattributed. Memberships, gift cards, penalties and custom income are outside the four selected cash streams.',
        ],
      },
    },
  };
}
