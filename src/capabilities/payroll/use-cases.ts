/**
 * Payroll payouts — what `payroll_record_payout` does.
 *
 * Settlements with a team member are the payroll calculations saved for them
 * minus what they were paid. Altegio counts as paid every financial
 * transaction that names the team member under a payment item of the
 * personnel category, dated in the period. So a payout is exactly such a
 * transaction, recorded through the `FinanceApi` port by the same use case as
 * `financial_transactions_create` — with its replay guard: an identical
 * transaction recorded within the last ten minutes (or at the given minute)
 * refuses the call, since the confirmation token is valid for its arguments
 * for ten minutes and is not single use.
 *
 * What this module adds is the payroll side: the personnel payment item is
 * chosen for the caller when the location has exactly one, a payment item of
 * another category is refused (it would not count in settlements), and the
 * confirmation and the result show the settlements for the payout's month so
 * far.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { FinanceAdapter } from '../../api/v1/finance-adapter.js';
import { roundMajor } from '../../api/money.js';
import { resolveLocationCurrency } from '../../api/v1/location-currency.js';
import { wallTime } from '../../api/v1/server-time.js';
import { knownLocationTimezone } from '../analytics/location-timezone.js';
import type {
  FinanceApi,
  FinancialTransaction,
  PaymentItem,
  PayrollSettlements,
} from '../../api/finance-api.js';
import {
  ConfirmationRefusal,
  type ConfirmedCall,
} from '../../tools/confirmation.js';
import {
  withUntrustedBlock,
  type UntrustedField,
} from '../../tools/tool-result.js';
import {
  createFinancialTransaction,
  type FinanceResult,
} from '../finance/use-cases.js';
import { FinanceInputError } from '../finance/errors.js';

const FIELD_MAX_CHARS = 200;

function api(client: AltegioClient): FinanceApi {
  return FinanceAdapter.forClient(client);
}

function amountText(value: number | null, currency: string | null): string {
  if (value === null) return 'not reported';
  const rounded = String(roundMajor(value));
  return currency
    ? `${rounded} ${currency}`
    : `${rounded} (currency not reported)`;
}

export interface RecordPayoutInput {
  location_id: number;
  team_member_id: number;
  amount: number;
  account_id: number;
  payment_item_id?: number;
  date?: string;
  comment?: string;
}

/** The location's personnel payment item for a payout, or a refusal. */
export async function payoutPaymentItem(
  client: AltegioClient,
  input: { location_id: number; payment_item_id?: number }
): Promise<PaymentItem> {
  const items = await api(client).listPaymentItems(input.location_id);
  if (input.payment_item_id !== undefined) {
    const chosen = items.find((item) => item.id === input.payment_item_id);
    if (!chosen) {
      throw new FinanceInputError(
        `Nothing was recorded: payment item ${input.payment_item_id} is not among the payment items this user sees at location ${input.location_id}. List them with financial_transactions_list_payment_items.`
      );
    }
    if (chosen.category !== 'personnel') {
      throw new FinanceInputError(
        `Nothing was recorded: payment item ${chosen.id} is in the ${chosen.category} category, and only a personnel payment item counts in a team member's settlements. Omit payment_item_id to use the personnel one, or record another expense with financial_transactions_create.`
      );
    }
    return chosen;
  }
  const personnel = items.filter((item) => item.category === 'personnel');
  if (personnel.length === 1) return personnel[0]!;
  if (personnel.length === 0) {
    throw new FinanceInputError(
      `Nothing was recorded: location ${input.location_id} has no personnel payment item this user can use, so a payout would not count in settlements. Check the user's access to payment items, or add one in Altegio.`
    );
  }
  throw new FinanceInputError(
    `Nothing was recorded: location ${input.location_id} has ${personnel.length} personnel payment items (${personnel.map((item) => item.id).join(', ')}). Ask the user which one this payout is for and pass it as payment_item_id; financial_transactions_list_payment_items shows their titles.`
  );
}

/** First day of the month of a `YYYY-MM-DD` day. */
function monthStart(day: string): string {
  return `${day.slice(0, 8)}01`;
}

/**
 * Settlements with the team member from the first of the month through `day`,
 * or null when they cannot be read — a payout does not depend on them, and
 * Altegio refuses a settlements period that ends in the future.
 */
async function monthSettlements(
  client: AltegioClient,
  input: { location_id: number; team_member_id: number },
  day: string
): Promise<PayrollSettlements | null> {
  try {
    const report = await api(client).getPayroll(
      input.location_id,
      input.team_member_id,
      { date_from: monthStart(day), date_to: day }
    );
    return report.settlements;
  } catch {
    return null;
  }
}

function settlementsText(
  s: PayrollSettlements | null,
  day: string,
  currency: string | null
): string | null {
  if (!s) return null;
  const owed =
    s.balance === null
      ? ''
      : s.balance > 0
        ? ', still owed to the team member'
        : s.balance < 0
          ? ', paid beyond what was accrued'
          : '';
  return `Settlements ${monthStart(day)}..${day}: accrued ${amountText(s.accrued_amount, currency)}, paid ${amountText(s.paid_amount, currency)}, balance ${amountText(s.balance, currency)}${owed}.`;
}

/** The `YYYY-MM-DD` a date input or a transaction date starts with. */
function dayOf(date: string | null | undefined): string | null {
  return date && /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 10) : null;
}

/** Today at the location, or null when its time zone cannot be read. */
async function locationToday(
  client: AltegioClient,
  locationId: number
): Promise<string | null> {
  const zone = await knownLocationTimezone(client, locationId);
  return zone ? wallTime(Date.now(), zone).slice(0, 10) : null;
}

/**
 * What the person approving a payout reads under the consequence: the payment
 * item it is recorded under and the settlements so far this month. Refuses
 * before asking anyone when no single personnel payment item fits.
 */
export async function describePayout(
  client: AltegioClient,
  input: RecordPayoutInput
): Promise<string | undefined> {
  let item: PaymentItem;
  try {
    item = await payoutPaymentItem(client, input);
  } catch (error) {
    if (error instanceof FinanceInputError) {
      throw new ConfirmationRefusal(error.message);
    }
    throw error;
  }
  const day =
    dayOf(input.date) ?? (await locationToday(client, input.location_id));
  const [currency, settlements] = await Promise.all([
    resolveLocationCurrency(client, input.location_id),
    day !== null ? monthSettlements(client, input, day) : null,
  ]);
  return [
    `Paid ${amountText(input.amount, currency)} from account or cash register ${input.account_id} under personnel payment item ${item.id}.`,
    (day !== null && settlementsText(settlements, day, currency)) || '',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function untrusted(
  item: PaymentItem,
  created: FinancialTransaction
): UntrustedField[] {
  return [
    { label: `payment item ${item.id}`, value: item.title },
    {
      label: `account ${created.account_id ?? '?'}`,
      value: created.account_title,
    },
    { label: `transaction ${created.id} comment`, value: created.comment },
  ];
}

export async function recordPayout(
  client: AltegioClient,
  input: RecordPayoutInput,
  now: number = Date.now(),
  confirmation?: ConfirmedCall
): Promise<FinanceResult> {
  const item = await payoutPaymentItem(client, input);
  const recorded = await createFinancialTransaction(
    client,
    {
      location_id: input.location_id,
      payment_item_id: item.id,
      account_id: input.account_id,
      amount: input.amount,
      team_member_id: input.team_member_id,
      ...(input.date !== undefined ? { date: input.date } : {}),
      ...(input.comment !== undefined ? { comment: input.comment } : {}),
    },
    now,
    confirmation
  );
  const {
    location_id: _location,
    currency,
    ...created
  } = recorded.structuredContent as FinancialTransaction & {
    location_id: number;
    currency: string | null;
  };
  void _location;
  const day = dayOf(created.date);
  const settlements =
    day !== null ? await monthSettlements(client, input, day) : null;
  const summary = [
    `Recorded payout ${created.id}: ${amountText(Math.abs(created.amount), currency)} paid to team member ${input.team_member_id} from account or cash register ${created.account_id ?? input.account_id} under personnel payment item ${item.id}, dated ${created.date ?? 'now'}.`,
    (day !== null && settlementsText(settlements, day, currency)) ||
      'It counts in the team member’s settlements for the period that includes its date (payroll_get_calculation).',
    `Undo it with financial_transactions_delete (transaction ${created.id}).`,
    ...(currency
      ? []
      : [
          'The location’s ISO currency code could not be read, so amounts are shown without it.',
        ]),
  ].join('\n');
  return {
    text: withUntrustedBlock(summary, untrusted(item, created), {
      maxChars: FIELD_MAX_CHARS,
    }),
    structuredContent: {
      location_id: input.location_id,
      team_member_id: input.team_member_id,
      currency,
      transaction: created,
      payment_item: { id: item.id, title: item.title },
      settlements_period:
        day !== null && settlements
          ? { date_from: monthStart(day), date_to: day }
          : null,
      settlements: settlements ?? null,
    },
  };
}
