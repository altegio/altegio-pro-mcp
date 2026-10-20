/**
 * Finance use cases — everything the `visits_*`, `client_accounts_*`,
 * `accounts_and_cash_registers_list`, `financial_transactions_*` and
 * `payroll_*` tools actually do.
 *
 * A use case takes the tool's parsed input plus an `AltegioClient`, calls the
 * `FinanceApi` port and returns the text summary next to the structured
 * content. Money is in major units and every amount the text prints carries
 * the location's ISO currency code; one location has one currency, so a page
 * may be summed but nothing is ever summed across locations.
 *
 * Free text — service and product titles, account and cash register titles,
 * payment method names, payment item titles, client account type titles,
 * comments — is other people's text. It never goes into our own summary lines;
 * it is keyed back to them by id inside the untrusted block.
 *
 * Writes that record money check the state they were confirmed against before
 * they run: a payment needs the amount due the caller read, a deposit the
 * balance, a new financial transaction that no identical one was just
 * recorded, and a change to one the version of the transaction the person was
 * shown. The confirmation token is valid for these arguments for ten minutes
 * and is not single use, so without that check a repeated call would record
 * the money twice. Each write also hands the port the confirmed call's
 * idempotency key (`../../api/write-options.ts`).
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { FinanceAdapter } from '../../api/v1/finance-adapter.js';
import {
  decimalsOf,
  currencyExponent,
  majorOf,
  moneyInput,
  MoneyInputError,
  moneyOf,
  roundMajor,
  sameMajor,
  sumMajor,
  type Money,
} from '../../api/money.js';
import { resolveLocationCurrency } from '../../api/v1/location-currency.js';
import { knownLocationTimezone } from '../analytics/location-timezone.js';
import {
  instantOfWallTime,
  instantWithOffset,
  wallTime,
} from '../../api/v1/server-time.js';
import type {
  CashRegisterOrAccount,
  ClientAccount,
  FinanceApi,
  FinancialTransaction,
  FinancialTransactionFields,
  PaymentMethod,
  PaymentOption,
  PaymentRequest,
  Visit,
  VisitPayment,
} from '../../api/finance-api.js';
import { writeOptions } from '../../api/write-options.js';
import {
  ConfirmationRefusal,
  stateVersion,
  type ConfirmationDetail,
  type ConfirmedCall,
} from '../../tools/confirmation.js';
import { FinanceInputError, FinanceNotFoundError } from './errors.js';
import {
  paginateCollection,
  renderPage,
  type PageInput,
} from '../../tools/pagination.js';
import {
  withUntrustedBlock,
  type UntrustedField,
} from '../../tools/tool-result.js';

export interface FinanceResult {
  text: string;
  structuredContent: unknown;
  isError?: boolean;
}

function api(client: AltegioClient): FinanceApi {
  return FinanceAdapter.forClient(client);
}

const FIELD_MAX_CHARS = 200;

/** Longest period the date-range reads accept. */
export const MAX_PERIOD_DAYS = 366;

// ========== shared rendering ==========

function amountText(value: number | null, currency: string | null): string {
  if (value === null) return 'not reported';
  const rounded = String(roundMajor(value));
  return currency
    ? `${rounded} ${currency}`
    : `${rounded} (currency not reported)`;
}

function signed(value: number, currency: string | null): string {
  return `${value > 0 ? '+' : ''}${amountText(value, currency)}`;
}

const sameMoney = sameMajor;

/**
 * Money a caller wrote, refused as `Nothing was <verb>` when the location's
 * currency cannot carry it; `reported` lists amounts Altegio itself gave.
 */
function moneyArg(
  major: number,
  currency: string | null,
  field: string,
  verb: string,
  reported: readonly (number | null)[] = []
): Money {
  try {
    return moneyInput(major, currency, field, reported);
  } catch (error) {
    if (error instanceof MoneyInputError) {
      throw new FinanceInputError(`Nothing was ${verb}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Refuse before anyone is asked when `major` has more decimals than the
 * location's currency takes, unless `reported` (read only then) gives it.
 */
async function refuseMoneyArg(
  client: AltegioClient,
  input: { location_id: number },
  major: number | undefined,
  field: string,
  reported: () => Promise<readonly (number | null)[]> = async () => []
): Promise<undefined> {
  if (major === undefined) return undefined;
  const currency = await resolveLocationCurrency(client, input.location_id);
  if (decimalsOf(major) <= currencyExponent(currency)) return undefined;
  try {
    moneyInput(major, currency, field, await reported());
  } catch (error) {
    if (error instanceof MoneyInputError) {
      throw new ConfirmationRefusal(error.message);
    }
    throw error;
  }
  return undefined;
}

function currencyNote(currency: string | null): string[] {
  return currency
    ? []
    : [
        'The location’s ISO currency code could not be read, so amounts are shown without it; do not add them to amounts of another location.',
      ];
}

function lines(...parts: (string | false | null | undefined)[]): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .join('\n');
}

/** Days between two `YYYY-MM-DD` dates, both inclusive. */
function periodDays(from: string, to: string): number {
  return (
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86400000 +
    1
  );
}

function checkPeriod(from: string, to: string): void {
  const days = periodDays(from, to);
  if (!Number.isFinite(days) || days < 1) {
    throw new FinanceInputError(
      `date_from ${from} is after date_to ${to}. Pass a period that starts on or before it ends.`
    );
  }
  if (days > MAX_PERIOD_DAYS) {
    throw new FinanceInputError(
      `The period ${from}..${to} spans ${days} days; at most ${MAX_PERIOD_DAYS} are read at once. Split it into shorter periods.`
    );
  }
}

// ========== visit: items, payments, amount due ==========

const METHOD_ID_FIELD: Record<PaymentMethod, keyof PaymentOption | null> = {
  account: 'account_id',
  client_account: 'client_account_id',
  loyalty_card: 'loyalty_card_id',
  loyalty_program: 'loyalty_program_id',
  gift_card: 'gift_card_id',
  membership: 'membership_id',
  referral_program: 'loyalty_program_id',
  advance_payment_hold: 'advance_payment_hold_id',
  other: null,
};

function optionLabel(o: PaymentOption): string {
  switch (o.method) {
    case 'account':
      return `account ${o.account_id} (${o.cash ? 'cash' : 'non-cash'})`;
    case 'client_account':
      return `client account ${o.client_account_id}`;
    case 'loyalty_card':
      return `loyalty card ${o.loyalty_card_id}`;
    case 'loyalty_program':
      return `loyalty program ${o.loyalty_program_id} on loyalty card ${o.loyalty_card_id}`;
    case 'gift_card':
      return `gift card ${o.gift_card_id}${o.number_required ? ' (its number is required)' : ''}`;
    case 'membership':
      return `membership ${o.membership_id}${o.number_required ? ' (its number is required)' : ''}`;
    case 'referral_program':
      return `referral program ${o.loyalty_program_id}`;
    case 'advance_payment_hold':
      return `advance payment hold ${o.advance_payment_hold_id}`;
    default:
      return 'another method';
  }
}

function optionLine(o: PaymentOption, currency: string | null): string {
  const reach =
    o.method === 'membership'
      ? `covers ${o.applicable_visits ?? '?'} visit(s)`
      : o.method === 'loyalty_program'
        ? `applies up to ${amountText(o.applicable_amount, currency)}`
        : `up to ${amountText(o.applicable_amount, currency)}${o.partial_allowed ? '' : ' in one payment of exactly that amount'}`;
  const balance =
    o.balance !== null ? ` · balance ${amountText(o.balance, currency)}` : '';
  return `- ${o.method}: ${optionLabel(o)} — ${reach}${balance}`;
}

function paymentLine(p: VisitPayment, currency: string | null): string {
  const via =
    p.method === 'account'
      ? `account ${p.account_id}`
      : p.method === 'client_account'
        ? `client account ${p.client_account_id}`
        : p.method === 'gift_card'
          ? `gift card ${p.gift_card_id}`
          : p.method === 'membership'
            ? `membership ${p.membership_id}`
            : p.method === 'loyalty_program'
              ? `loyalty program ${p.loyalty_program_id}`
              : p.method === 'loyalty_card'
                ? `loyalty card ${p.loyalty_card_id}`
                : p.method;
  return `- payment ${p.id}: ${amountText(p.amount, currency)} by ${via}${p.visit_item_id ? ` for visit item ${p.visit_item_id}` : ''}`;
}

function visitUntrusted(visit: Visit): UntrustedField[] {
  const fields: UntrustedField[] = [];
  for (const item of visit.items) {
    fields.push({ label: `visit item ${item.id} title`, value: item.title });
  }
  const accounts = new Map<number, string | null>();
  for (const p of visit.payments) {
    if (p.account_id !== null) accounts.set(p.account_id, p.account_title);
    if (p.payment_method_name) {
      fields.push({
        label: `payment ${p.id} payment method`,
        value: p.payment_method_name,
      });
    }
  }
  for (const o of visit.payment_options) {
    if (o.applicable && o.account_id !== null) {
      accounts.set(o.account_id, o.account_title);
    }
    if (
      o.applicable &&
      o.loyalty_program_id !== null &&
      o.loyalty_program_title
    ) {
      fields.push({
        label: `loyalty program ${o.loyalty_program_id} title`,
        value: o.loyalty_program_title,
      });
    }
  }
  for (const [accountId, title] of accounts) {
    fields.push({ label: `account ${accountId} title`, value: title });
  }
  return fields;
}

function visitStructured(visit: Visit, currency: string | null) {
  const available = visit.payment_options.filter((o) => o.applicable);
  return {
    location_id: visit.location_id,
    appointment_id: visit.appointment_id,
    visit_id: visit.visit_id,
    client_id: visit.client_id,
    currency,
    total_amount: visit.total_amount,
    paid_amount: visit.paid_amount,
    amount_due: visit.amount_due,
    items: visit.items,
    payments: visit.payments,
    advance_payment_holds: visit.advance_payment_holds,
    payment_options: available,
    unavailable_payment_options:
      visit.payment_options.length - available.length,
  };
}

function visitText(
  visit: Visit,
  currency: string | null,
  head: string
): string {
  const available = visit.payment_options.filter((o) => o.applicable);
  const hidden = visit.payment_options.length - available.length;
  const summary = lines(
    head,
    `Total amount ${amountText(visit.total_amount, currency)} · paid ${amountText(visit.paid_amount, currency)} · amount due ${amountText(visit.amount_due, currency)}.`,
    'Visit items:',
    ...(visit.items.length > 0
      ? visit.items.map(
          (l) =>
            `- item ${l.id}: ${l.kind}${l.kind === 'service' ? ` ${l.service_id}` : l.kind === 'product' ? ` ${l.product_id}` : ''} ×${l.quantity ?? '?'} · ${amountText(l.amount, currency)}${l.amount_before_discount !== null && l.amount !== null && !sameMoney(l.amount_before_discount, l.amount) ? ` (before discount ${amountText(l.amount_before_discount, currency)})` : ''}`
        )
      : ['- none']),
    `Payments: ${visit.payments.length === 0 ? 'none.' : ''}`,
    ...visit.payments.map((p) => paymentLine(p, currency)),
    visit.advance_payment_holds.length > 0 &&
      `Advance payment holds: ${visit.advance_payment_holds
        .map(
          (h) =>
            `${h.id} (${amountText(h.amount, currency)}, ${h.status ?? 'status not reported'})`
        )
        .join('; ')}.`,
    visit.amount_due > 0 && available.length > 0
      ? `Can pay now${hidden > 0 ? ` (${hidden} more method(s) not applicable to this visit)` : ''}:`
      : visit.amount_due > 0
        ? 'No payment method applies to this visit now.'
        : 'Nothing is due.',
    ...(visit.amount_due > 0
      ? available.map((o) => optionLine(o, currency))
      : []),
    ...currencyNote(currency)
  );
  return withUntrustedBlock(summary, visitUntrusted(visit), {
    maxChars: FIELD_MAX_CHARS,
  });
}

function visitHead(visit: Visit, after = false): string {
  return `${after ? 'The visit now: visit' : 'Visit'}${visit.visit_id ? ` ${visit.visit_id}` : ''} of appointment ${visit.appointment_id} (${visit.client_id ? `client ${visit.client_id}` : 'no client'}) at location ${visit.location_id}.`;
}

export async function getVisit(
  client: AltegioClient,
  input: { location_id: number; appointment_id: number }
): Promise<FinanceResult> {
  const [visit, currency] = await Promise.all([
    api(client).getVisit(input.location_id, input.appointment_id),
    resolveLocationCurrency(client, input.location_id),
  ]);
  const next =
    visit.amount_due > 0
      ? 'Record a payment with visits_add_payment: a method and its id from the list above, and amount_due as expected_amount_due.'
      : visit.payments.length > 0
        ? 'Cancel a payment with visits_cancel_payment and its payment id.'
        : '';
  return {
    text: lines(visitText(visit, currency, visitHead(visit)), next),
    structuredContent: visitStructured(visit, currency),
  };
}

/** Name the visit for a confirmation prompt; never decides whether it runs. */
export async function describeVisit(
  client: AltegioClient,
  input: { location_id: number; appointment_id: number }
): Promise<string | undefined> {
  const [visit, currency] = await Promise.all([
    api(client).getVisit(input.location_id, input.appointment_id),
    resolveLocationCurrency(client, input.location_id),
  ]);
  return `the visit of appointment ${visit.appointment_id} at location ${visit.location_id}${visit.client_id ? ` (client ${visit.client_id})` : ''}: total amount ${amountText(visit.total_amount, currency)}, amount due ${amountText(visit.amount_due, currency)}`;
}

/**
 * Refuse a payment amount the location's currency cannot carry before anyone
 * is asked; one Altegio reported for the visit (the amount due, a method's
 * payable amount) is allowed at the stored precision.
 */
export async function checkPaymentMoney(
  client: AltegioClient,
  input: { location_id: number; appointment_id: number; amount?: number }
): Promise<undefined> {
  return refuseMoneyArg(client, input, input.amount, 'amount', async () => {
    const visit = await api(client).getVisit(
      input.location_id,
      input.appointment_id
    );
    return [
      visit.amount_due,
      ...visit.payment_options.map((o) => o.applicable_amount),
    ];
  });
}

/** Refuse an amount the location's currency cannot carry before anyone is asked. */
export async function checkMoneyArg(
  client: AltegioClient,
  input: { location_id: number; amount?: number }
): Promise<undefined> {
  return refuseMoneyArg(client, input, input.amount, 'amount');
}

export interface AddPaymentInput {
  location_id: number;
  appointment_id: number;
  method: Exclude<PaymentMethod, 'referral_program' | 'other'>;
  amount?: number;
  account_id?: number;
  client_account_id?: number;
  loyalty_card_id?: number;
  loyalty_program_id?: number;
  gift_card_id?: number;
  membership_id?: number;
  advance_payment_hold_id?: number;
  number?: string;
  expected_amount_due: number;
}

/**
 * Turn the flat tool input into one payment, refusing a missing id or amount,
 * or an amount the currency cannot carry unless Altegio `reported` it.
 */
export function paymentRequest(
  input: AddPaymentInput,
  currency: string | null = null,
  reported: readonly (number | null)[] = []
): PaymentRequest {
  const need = (field: keyof AddPaymentInput): number => {
    const value = input[field];
    if (typeof value !== 'number') {
      throw new FinanceInputError(
        `method ${input.method} needs ${field}; take it from payment_options in visits_get.`
      );
    }
    return value;
  };
  const amount = (): Money => {
    if (input.amount === undefined) {
      throw new FinanceInputError(
        `method ${input.method} needs an amount above zero, at most the option's applicable_amount.`
      );
    }
    return moneyArg(input.amount, currency, 'amount', 'recorded', reported);
  };
  switch (input.method) {
    case 'account':
      return {
        method: 'account',
        account_id: need('account_id'),
        amount: amount(),
      };
    case 'client_account':
      return {
        method: 'client_account',
        client_account_id: need('client_account_id'),
        amount: amount(),
      };
    case 'loyalty_card':
      return {
        method: 'loyalty_card',
        loyalty_card_id: need('loyalty_card_id'),
        amount: amount(),
      };
    case 'loyalty_program':
      return {
        method: 'loyalty_program',
        loyalty_card_id: need('loyalty_card_id'),
        loyalty_program_id: need('loyalty_program_id'),
      };
    case 'gift_card':
      return {
        method: 'gift_card',
        gift_card_id: need('gift_card_id'),
        amount: amount(),
        ...(input.number ? { number: input.number } : {}),
      };
    case 'membership':
      return {
        method: 'membership',
        membership_id: need('membership_id'),
        ...(input.number ? { number: input.number } : {}),
      };
    case 'advance_payment_hold':
      return {
        method: 'advance_payment_hold',
        advance_payment_hold_id: need('advance_payment_hold_id'),
        amount: amount(),
      };
  }
}

function matchesOption(o: PaymentOption, request: PaymentRequest): boolean {
  if (o.method !== request.method) return false;
  switch (request.method) {
    case 'account':
      return o.account_id === request.account_id;
    case 'client_account':
      return o.client_account_id === request.client_account_id;
    case 'loyalty_card':
      return o.loyalty_card_id === request.loyalty_card_id;
    case 'loyalty_program':
      return (
        o.loyalty_card_id === request.loyalty_card_id &&
        o.loyalty_program_id === request.loyalty_program_id
      );
    case 'gift_card':
      return o.gift_card_id === request.gift_card_id;
    case 'membership':
      return o.membership_id === request.membership_id;
    case 'advance_payment_hold':
      return o.advance_payment_hold_id === request.advance_payment_hold_id;
  }
}

/** What the payment describes, for the confirmation consequence. */
export function paymentSummary(input: AddPaymentInput): string {
  const field = METHOD_ID_FIELD[input.method];
  const ref = field
    ? (input as unknown as Record<string, unknown>)[field]
    : undefined;
  const what =
    input.method === 'account'
      ? `account or cash register ${input.account_id ?? '?'}`
      : `${input.method.replace(/_/g, ' ')} ${ref ?? '?'}`;
  return input.amount !== undefined
    ? `a payment of ${input.amount} (location currency) by ${what}`
    : `a payment by ${what}`;
}

export async function addPayment(
  client: AltegioClient,
  input: AddPaymentInput,
  confirmation?: ConfirmedCall
): Promise<FinanceResult> {
  // A missing id or amount is refused before anything is read.
  paymentRequest(input);
  const finance = api(client);
  const [before, currency] = await Promise.all([
    finance.getVisit(input.location_id, input.appointment_id),
    resolveLocationCurrency(client, input.location_id),
  ]);
  const request = paymentRequest(input, currency, [
    before.amount_due,
    ...before.payment_options.map((o) => o.applicable_amount),
  ]);

  if (!sameMoney(before.amount_due, input.expected_amount_due)) {
    throw new FinanceInputError(
      `Nothing was recorded: the amount due on appointment ${input.appointment_id} is ${amountText(before.amount_due, currency)}, not the ${amountText(input.expected_amount_due, currency)} this payment was confirmed for — the visit changed, or this payment was already recorded. Read it again with visits_get before paying.`
    );
  }
  if (before.amount_due <= 0) {
    throw new FinanceInputError(
      `Nothing was recorded: appointment ${input.appointment_id} has nothing due.`
    );
  }
  const option = before.payment_options.find(
    (o) => o.applicable && matchesOption(o, request)
  );
  if (!option) {
    throw new FinanceInputError(
      `Nothing was recorded: ${paymentSummary(input)} cannot pay this visit now. Pick a method and id from payment_options in visits_get.`
    );
  }
  if ('amount' in request) {
    const amount = majorOf(request.amount);
    const cap = roundMajor(option.applicable_amount ?? before.amount_due);
    if (amount > cap) {
      throw new FinanceInputError(
        `Nothing was recorded: ${amountText(amount, currency)} is more than this method can pay now (${amountText(cap, currency)}).`
      );
    }
    if (!option.partial_allowed && !sameMoney(amount, cap)) {
      throw new FinanceInputError(
        `Nothing was recorded: this method pays only its full applicable amount, ${amountText(cap, currency)}, in one payment.`
      );
    }
  }

  const after = await finance.addPayment(
    input.location_id,
    input.appointment_id,
    request,
    writeOptions(confirmation)
  );
  const known = new Set(before.payments.map((p) => p.id));
  const added = after.payments.filter((p) => !known.has(p.id));
  const head =
    added.length > 0
      ? `Recorded ${added.map((p) => `payment ${p.id} (${amountText(p.amount, currency)}, ${p.method})`).join(', ')} on appointment ${after.appointment_id}. Amount due is now ${amountText(after.amount_due, currency)}.`
      : `The payment was sent, but the visit shows no new payment; amount due is ${amountText(after.amount_due, currency)}. Read the visit with visits_get before trying again.`;
  return {
    text: lines(
      head,
      visitText(after, currency, visitHead(after, true)),
      'Undo a payment with visits_cancel_payment.'
    ),
    structuredContent: {
      ...visitStructured(after, currency),
      added_payment_ids: added.map((p) => p.id),
    },
    ...(added.length === 0 ? { isError: true } : {}),
  };
}

export async function describePayment(
  client: AltegioClient,
  input: { location_id: number; appointment_id: number; payment_id: string }
): Promise<string | undefined> {
  const [visit, currency] = await Promise.all([
    api(client).getVisit(input.location_id, input.appointment_id),
    resolveLocationCurrency(client, input.location_id),
  ]);
  const payment = visit.payments.find((p) => p.id === input.payment_id);
  if (!payment) return undefined;
  return `payment ${payment.id} of ${amountText(payment.amount, currency)} (${payment.method}${payment.account_id ? `, account ${payment.account_id}` : ''}) on appointment ${input.appointment_id}`;
}

export async function cancelPayment(
  client: AltegioClient,
  input: { location_id: number; appointment_id: number; payment_id: string },
  confirmation?: ConfirmedCall
): Promise<FinanceResult> {
  const finance = api(client);
  const [before, currency] = await Promise.all([
    finance.getVisit(input.location_id, input.appointment_id),
    resolveLocationCurrency(client, input.location_id),
  ]);
  const payment = before.payments.find((p) => p.id === input.payment_id);
  if (!payment) {
    throw new FinanceNotFoundError(
      `Nothing was cancelled: payment ${input.payment_id.slice(0, 40)} is not on the visit of appointment ${input.appointment_id} — it may already be cancelled. The visit lists ${before.payments.map((p) => p.id).join(', ') || 'no payments'}.`
    );
  }
  const after = await finance.cancelPayment(
    input.location_id,
    input.appointment_id,
    input.payment_id,
    writeOptions(confirmation)
  );
  const gone = !after.payments.some((p) => p.id === input.payment_id);
  return {
    text: lines(
      gone
        ? `Cancelled payment ${payment.id} (${amountText(payment.amount, currency)}, ${payment.method}) on appointment ${after.appointment_id}. Amount due is now ${amountText(after.amount_due, currency)}.`
        : `The cancellation was sent, but payment ${payment.id} is still on the visit.`,
      payment.method === 'account'
        ? 'This reverses the record in Altegio only: money taken by card or online acquiring is not returned to the client by this call.'
        : 'The amount goes back to the client account or loyalty instrument it was paid from.',
      visitText(after, currency, visitHead(after, true))
    ),
    structuredContent: {
      ...visitStructured(after, currency),
      cancelled_payment_id: gone ? payment.id : null,
    },
    ...(gone ? {} : { isError: true }),
  };
}

// ========== client accounts ==========

function clientAccountLine(a: ClientAccount, currency: string | null): string {
  return `- client account ${a.id}${a.chain_id ? ` (chain ${a.chain_id})` : ''}: balance ${amountText(a.balance, currency)}${a.reserved_balance ? ` · ${amountText(a.reserved_balance, currency)} held for advance payments` : ''}${a.blocked ? ' · blocked' : ''}`;
}

export async function listClientAccounts(
  client: AltegioClient,
  input: { location_id: number; client_id: number } & PageInput
): Promise<FinanceResult> {
  const [all, currency] = await Promise.all([
    api(client).listClientAccounts(input.location_id, input.client_id),
    resolveLocationCurrency(client, input.location_id),
  ]);
  const { items, pagination } = paginateCollection(all, input);
  const summary = lines(
    `${pagination.total} client account(s) of client ${input.client_id}, read through location ${input.location_id}; page ${input.page} shows ${items.length}${items.length > 0 ? ':' : '.'}`,
    ...items.map((a) => clientAccountLine(a, currency)),
    pagination.has_more && `More follow: request page ${pagination.next_page}.`,
    items.length > 0
      ? 'Top one up with client_accounts_deposit (pass its balance as expected_balance); pay a visit from one with visits_add_payment, method client_account.'
      : 'A client account is opened from a client account type of the chain, in Altegio.',
    ...currencyNote(currency)
  );
  return {
    text: withUntrustedBlock(
      summary,
      items.map((a) => ({
        label: `client account ${a.id} type`,
        value: a.type_title,
      })),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: {
      location_id: input.location_id,
      client_id: input.client_id,
      currency,
      items,
      pagination,
    },
  };
}

export interface DepositInput {
  location_id: number;
  client_id: number;
  client_account_id: number;
  amount: number;
  account_id: number;
  team_member_id?: number;
  expected_balance: number;
}

export async function describeClientAccount(
  client: AltegioClient,
  input: { location_id: number; client_id: number; client_account_id: number }
): Promise<string | undefined> {
  const [all, currency] = await Promise.all([
    api(client).listClientAccounts(input.location_id, input.client_id),
    resolveLocationCurrency(client, input.location_id),
  ]);
  const account = all.find((a) => a.id === input.client_account_id);
  if (!account) return undefined;
  return `client account ${account.id} of client ${input.client_id} (balance ${amountText(account.balance, currency)})`;
}

export async function deposit(
  client: AltegioClient,
  input: DepositInput,
  confirmation?: ConfirmedCall
): Promise<FinanceResult> {
  const finance = api(client);
  const [accounts, currency] = await Promise.all([
    finance.listClientAccounts(input.location_id, input.client_id),
    resolveLocationCurrency(client, input.location_id),
  ]);
  const account = accounts.find((a) => a.id === input.client_account_id);
  if (!account) {
    throw new FinanceNotFoundError(
      `Nothing was deposited: client ${input.client_id} has no client account ${input.client_account_id}. Their accounts: ${accounts.map((a) => a.id).join(', ') || 'none'} (client_accounts_list_for_client).`
    );
  }
  if (account.blocked) {
    throw new FinanceInputError(
      `Nothing was deposited: client account ${account.id} is blocked.`
    );
  }
  if (
    account.balance === null ||
    !sameMoney(account.balance, input.expected_balance)
  ) {
    throw new FinanceInputError(
      `Nothing was deposited: client account ${account.id} has a balance of ${amountText(account.balance, currency)}, not the ${amountText(input.expected_balance, currency)} this deposit was confirmed for — the balance changed, or this deposit was already recorded. Read it again with client_accounts_list_for_client.`
    );
  }
  const result = await finance.deposit(
    input.location_id,
    {
      client_id: input.client_id,
      client_account_id: input.client_account_id,
      amount: moneyArg(input.amount, currency, 'amount', 'deposited'),
      account_id: input.account_id,
      ...(input.team_member_id !== undefined
        ? { team_member_id: input.team_member_id }
        : {}),
    },
    writeOptions(confirmation)
  );
  return {
    text: lines(
      `Deposited ${amountText(result.amount, currency)} to client account ${result.client_account_id} of client ${input.client_id}, received into account or cash register ${input.account_id}${result.financial_transaction_id ? ` (financial transaction ${result.financial_transaction_id})` : ''}.`,
      `Balance now ${amountText(result.balance_after, currency)}.`,
      ...currencyNote(currency)
    ),
    structuredContent: {
      location_id: input.location_id,
      client_id: input.client_id,
      currency,
      ...result,
    },
  };
}

// ========== accounts and cash registers ==========

export async function listCashRegistersAndAccounts(
  client: AltegioClient,
  input: { location_id: number } & PageInput
): Promise<FinanceResult> {
  const all = await api(client).listCashRegistersAndAccounts(input.location_id);
  const { items, pagination } = paginateCollection(all, input);
  const summary = lines(
    `${pagination.total} account(s) and cash register(s) at location ${input.location_id}; page ${input.page} shows ${items.length}${items.length > 0 ? ':' : '.'}`,
    ...items.map(
      (a: CashRegisterOrAccount) =>
        `- ${a.id}: ${a.settlement === 'cash' ? 'cash settlement' : 'non-cash settlement'}${a.acquiring ? ' · online acquiring' : ''}`
    ),
    pagination.has_more && `More follow: request page ${pagination.next_page}.`,
    'Use an id as account_id in visits_add_payment, client_accounts_deposit and financial_transactions_create. These are internal records of money, not fiscal devices.'
  );
  return {
    text: withUntrustedBlock(
      summary,
      items.flatMap((a) => [
        { label: `${a.id} title`, value: a.title },
        { label: `${a.id} comment`, value: a.comment },
      ]),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: { location_id: input.location_id, items, pagination },
  };
}

// ========== payment items ==========

export async function listPaymentItems(
  client: AltegioClient,
  input: { location_id: number; direction?: 'income' | 'expense' } & PageInput
): Promise<FinanceResult> {
  const all = (await api(client).listPaymentItems(input.location_id)).filter(
    (item) =>
      input.direction === undefined || item.direction === input.direction
  );
  const { items, pagination } = paginateCollection(all, input);
  const summary = lines(
    `${pagination.total} ${input.direction ? `${input.direction} ` : ''}payment item(s) at location ${input.location_id}; page ${input.page} shows ${items.length}${items.length > 0 ? ':' : '.'}`,
    ...items.map(
      (item) => `- ${item.id}: ${item.direction} · category ${item.category}`
    ),
    pagination.has_more && `More follow: request page ${pagination.next_page}.`,
    'Use an id as payment_item_id in financial_transactions_create; the category decides income or expense. A user limited to some payment items sees only those.'
  );
  return {
    text: withUntrustedBlock(
      summary,
      items.map((item) => ({
        label: `payment item ${item.id}`,
        value: item.title,
      })),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: { location_id: input.location_id, items, pagination },
  };
}

// ========== financial transactions ==========

function transactionLine(
  t: FinancialTransaction,
  currency: string | null
): string {
  const links = [
    t.payment_item_id !== null ? `payment item ${t.payment_item_id}` : null,
    t.account_id !== null ? `account ${t.account_id}` : null,
    t.appointment_id !== null ? `appointment ${t.appointment_id}` : null,
    t.document_id !== null && t.appointment_id === null
      ? `document ${t.document_id}`
      : null,
    t.client_id !== null ? `client ${t.client_id}` : null,
    t.team_member_id !== null ? `team member ${t.team_member_id}` : null,
    t.supplier_id !== null ? `supplier ${t.supplier_id}` : null,
  ].filter((x): x is string => x !== null);
  return `- ${t.id} · ${t.date ?? 'date not reported'} · ${signed(t.amount, currency)} · ${links.join(' · ')}`;
}

function transactionUntrusted(
  items: readonly FinancialTransaction[]
): UntrustedField[] {
  const fields: UntrustedField[] = [];
  const itemTitles = new Map<number, string | null>();
  const accountTitles = new Map<number, string | null>();
  for (const t of items) {
    if (t.payment_item_id !== null)
      itemTitles.set(t.payment_item_id, t.payment_item_title);
    if (t.account_id !== null) accountTitles.set(t.account_id, t.account_title);
  }
  for (const [id, title] of itemTitles) {
    fields.push({ label: `payment item ${id}`, value: title });
  }
  for (const [id, title] of accountTitles) {
    fields.push({ label: `account ${id}`, value: title });
  }
  for (const t of items) {
    fields.push({ label: `transaction ${t.id} comment`, value: t.comment });
  }
  return fields;
}

export interface TransactionListInput extends PageInput {
  location_id: number;
  date_from: string;
  date_to: string;
  account_id?: number;
  client_id?: number;
  team_member_id?: number;
  supplier_id?: number;
}

export async function listFinancialTransactions(
  client: AltegioClient,
  input: TransactionListInput
): Promise<FinanceResult> {
  checkPeriod(input.date_from, input.date_to);
  const [found, currency] = await Promise.all([
    api(client).listFinancialTransactions(input.location_id, {
      date_from: input.date_from,
      date_to: input.date_to,
      ...(input.account_id !== undefined
        ? { account_id: input.account_id }
        : {}),
      ...(input.client_id !== undefined ? { client_id: input.client_id } : {}),
      ...(input.team_member_id !== undefined
        ? { team_member_id: input.team_member_id }
        : {}),
      ...(input.supplier_id !== undefined
        ? { supplier_id: input.supplier_id }
        : {}),
      page: input.page,
      page_size: input.page_size,
    }),
    resolveLocationCurrency(client, input.location_id),
  ]);
  // The source has no total; a short page is the last one.
  const items = found.slice(0, input.page_size);
  return renderPage({
    input,
    items,
    render: ({ items: page, pagination }) => {
      const income = sumMajor(
        page.filter((t) => t.amount > 0).map((t) => t.amount)
      );
      const expense = sumMajor(
        page.filter((t) => t.amount < 0).map((t) => t.amount)
      );
      const summary = lines(
        `Financial transactions at location ${input.location_id}, ${input.date_from}..${input.date_to}, page ${pagination.page}: ${page.length} transaction(s)${page.length > 0 ? `, income ${amountText(income, currency)} and expenses ${amountText(expense, currency)} on this page` : ''}.`,
        ...page.map((t) => transactionLine(t, currency)),
        pagination.has_more
          ? `More may follow: request page ${pagination.next_page} with the same page_size.`
          : page.length > 0 && 'This is the last page.',
        page.some((t) => t.document_id !== null) &&
          'A transaction with an appointment or document was recorded by a visit payment, a product sale or a client account deposit; change it there (visits_cancel_payment), not with financial_transactions_update.',
        ...currencyNote(currency)
      );
      return {
        text: withUntrustedBlock(summary, transactionUntrusted(page), {
          maxChars: FIELD_MAX_CHARS,
        }),
        structuredContent: {
          location_id: input.location_id,
          date_from: input.date_from,
          date_to: input.date_to,
          currency,
          items: page,
          pagination,
        },
      };
    },
  });
}

const LOCAL_WALL = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/;

/** The location wall time a `date` input names, `YYYY-MM-DD HH:MM:SS`. */
export function localWallTime(
  date: string | undefined,
  zone: string,
  now: number = Date.now()
): string {
  if (date === undefined) return wallTime(now, zone);
  const local = LOCAL_WALL.exec(date);
  if (local) return `${local[1]} ${local[2]}:${local[3] ?? '00'}`;
  const instant = instantWithOffset(date);
  if (instant === null) {
    throw new FinanceInputError(
      `date "${date.slice(0, 40)}" is not a datetime: use YYYY-MM-DDTHH:MM in the location's time, or RFC 3339 with an offset.`
    );
  }
  return wallTime(instant, zone);
}

async function requireZone(
  client: AltegioClient,
  locationId: number
): Promise<string> {
  const zone = await knownLocationTimezone(client, locationId);
  if (zone === null) {
    throw new FinanceInputError(
      `The time zone of location ${locationId} could not be read, so the transaction date cannot be placed. Check the location with locations_list.`
    );
  }
  return zone;
}

/** A transaction a visit, sale or deposit recorded is changed where it was made. */
function refuseLinked(t: FinancialTransaction, verb: string): void {
  if (
    t.document_id === null &&
    t.appointment_id === null &&
    t.visit_id === null
  )
    return;
  throw new FinanceInputError(
    `Nothing was changed: financial transaction ${t.id} was recorded by ${t.appointment_id !== null ? `a payment on appointment ${t.appointment_id} — cancel it with visits_cancel_payment` : `document ${t.document_id} (a product sale or a client account deposit) — change it in Altegio where it was made`}, so it cannot be ${verb} on its own.`
  );
}

export interface CreateTransactionInput {
  location_id: number;
  payment_item_id: number;
  account_id: number;
  amount: number;
  date?: string;
  client_id?: number;
  team_member_id?: number;
  supplier_id?: number;
  comment?: string;
}

/** Window in which an identical transaction is taken for this one, repeated. */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

export async function createFinancialTransaction(
  client: AltegioClient,
  input: CreateTransactionInput,
  now: number = Date.now(),
  confirmation?: ConfirmedCall
): Promise<FinanceResult> {
  const finance = api(client);
  const [zone, currency] = await Promise.all([
    requireZone(client, input.location_id),
    resolveLocationCurrency(client, input.location_id),
  ]);
  const local = localWallTime(input.date, zone, now);
  const instant = instantOfWallTime(local, zone) ?? now;
  const day = local.slice(0, 10);
  const fields: FinancialTransactionFields = {
    payment_item_id: input.payment_item_id,
    account_id: input.account_id,
    amount: moneyArg(input.amount, currency, 'amount', 'recorded'),
    local_date: local,
    client_id: input.client_id ?? null,
    team_member_id: input.team_member_id ?? null,
    supplier_id: input.supplier_id ?? null,
    comment: input.comment ?? '',
  };

  // A repeated call with the same confirmation token must not record twice.
  const sameDay = await finance.listFinancialTransactions(input.location_id, {
    date_from: day,
    date_to: day,
    account_id: input.account_id,
    page: 1,
    page_size: 100,
  });
  const duplicate = sameDay.find((t) => {
    if (
      t.payment_item_id !== fields.payment_item_id ||
      !sameMoney(Math.abs(t.amount), majorOf(fields.amount)) ||
      (t.comment ?? '') !== fields.comment ||
      t.client_id !== fields.client_id ||
      t.team_member_id !== fields.team_member_id ||
      t.supplier_id !== fields.supplier_id
    )
      return false;
    const at = t.date ? Date.parse(t.date) : NaN;
    if (Number.isNaN(at)) return false;
    return input.date === undefined
      ? Math.abs(now - at) <= DUPLICATE_WINDOW_MS
      : Math.abs(instant - at) < 60_000;
  });
  if (duplicate) {
    throw new FinanceInputError(
      `Nothing was recorded: financial transaction ${duplicate.id} with the same payment item, account, amount, date and comment already exists — this looks like a repeat of the same call. To record a second identical transaction, give it a different comment.`
    );
  }

  const created = await finance.createFinancialTransaction(
    input.location_id,
    fields,
    writeOptions(confirmation)
  );
  return {
    text: withUntrustedBlock(
      lines(
        `Recorded financial transaction ${created.id}: ${signed(created.amount, currency)} (${created.direction}) in account ${created.account_id} under payment item ${created.payment_item_id}, dated ${created.date ?? local}.`,
        'Undo it with financial_transactions_delete.',
        ...currencyNote(currency)
      ),
      transactionUntrusted([created]),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: { location_id: input.location_id, currency, ...created },
  };
}

/** The confirmation target of a new transaction, with its amount in currency. */
export async function describeNewTransaction(
  client: AltegioClient,
  input: { location_id: number; account_id: number; amount: number }
): Promise<string | undefined> {
  const currency = await resolveLocationCurrency(client, input.location_id);
  return `account or cash register ${input.account_id} at location ${input.location_id}: ${amountText(input.amount, currency)}`;
}

export async function describeTransaction(
  client: AltegioClient,
  input: { location_id: number; transaction_id: number }
): Promise<string | undefined> {
  const [t, currency] = await Promise.all([
    api(client).getFinancialTransaction(
      input.location_id,
      input.transaction_id
    ),
    resolveLocationCurrency(client, input.location_id),
  ]);
  return `financial transaction ${t.id}: ${signed(t.amount, currency)}, account ${t.account_id}, payment item ${t.payment_item_id}, dated ${t.date ?? 'not reported'}`;
}

export interface UpdateTransactionInput {
  location_id: number;
  transaction_id: number;
  payment_item_id?: number;
  account_id?: number;
  amount?: number;
  date?: string;
  client_id?: number;
  team_member_id?: number;
  supplier_id?: number;
  comment?: string;
  clear?: Array<'client' | 'team_member' | 'supplier' | 'comment'>;
}

/** A change to a transaction, worked out on the transaction as just read. */
interface TransactionUpdatePlan {
  before: FinancialTransaction;
  fields: FinancialTransactionFields;
  /** `before.date` as location wall time, `YYYY-MM-DD HH:MM:SS`. */
  beforeLocal: string | null;
  currency: string | null;
  /**
   * `stateVersion` of every field the update overwrites, as read: what the
   * confirmation shows, and what the confirmed call must still find.
   */
  version: string;
}

async function planTransactionUpdate(
  client: AltegioClient,
  input: UpdateTransactionInput
): Promise<TransactionUpdatePlan> {
  const finance = api(client);
  const [before, zone, currency] = await Promise.all([
    finance.getFinancialTransaction(input.location_id, input.transaction_id),
    requireZone(client, input.location_id),
    resolveLocationCurrency(client, input.location_id),
  ]);
  refuseLinked(before, 'edited');
  const clear = new Set(input.clear ?? []);
  const beforeLocal = before.date ? localWallTime(before.date, zone) : null;
  const local =
    input.date !== undefined ? localWallTime(input.date, zone) : beforeLocal;
  if (local === null) {
    throw new FinanceInputError(
      `Financial transaction ${before.id} reports no date; pass date to update it.`
    );
  }
  const fields: FinancialTransactionFields = {
    payment_item_id: input.payment_item_id ?? before.payment_item_id ?? 0,
    account_id: input.account_id ?? before.account_id ?? 0,
    amount:
      input.amount !== undefined
        ? moneyArg(input.amount, currency, 'amount', 'changed')
        : moneyOf(Math.abs(before.amount), currency),
    local_date: local,
    client_id: clear.has('client')
      ? null
      : (input.client_id ?? before.client_id),
    team_member_id: clear.has('team_member')
      ? null
      : (input.team_member_id ?? before.team_member_id),
    supplier_id: clear.has('supplier')
      ? null
      : (input.supplier_id ?? before.supplier_id),
    comment: clear.has('comment')
      ? ''
      : (input.comment ?? before.comment ?? ''),
  };
  if (!fields.payment_item_id || !fields.account_id) {
    throw new FinanceInputError(
      `Financial transaction ${before.id} reports no payment item or account; pass payment_item_id and account_id.`
    );
  }
  return {
    before,
    fields,
    beforeLocal,
    currency,
    version: stateVersion({
      payment_item_id: before.payment_item_id,
      account_id: before.account_id,
      amount: roundMajor(before.amount),
      date: before.date,
      client_id: before.client_id,
      team_member_id: before.team_member_id,
      supplier_id: before.supplier_id,
      comment: before.comment ?? '',
    }),
  };
}

/** The confirmation detail: the transaction now, and what the call changes. */
export async function describeTransactionChange(
  client: AltegioClient,
  input: UpdateTransactionInput
): Promise<ConfirmationDetail> {
  let plan: TransactionUpdatePlan;
  try {
    plan = await planTransactionUpdate(client, input);
  } catch (error) {
    if (error instanceof FinanceInputError) {
      throw new ConfirmationRefusal(
        error.message.replace(/^Nothing was changed: /, '')
      );
    }
    throw error;
  }
  const { before, fields, beforeLocal, currency } = plan;
  const none = (id: number | null) => (id === null ? 'none' : String(id));
  const changes = [
    !sameMoney(Math.abs(before.amount), majorOf(fields.amount)) &&
      `amount ${amountText(Math.abs(before.amount), currency)} → ${amountText(majorOf(fields.amount), currency)}`,
    before.payment_item_id !== fields.payment_item_id &&
      `payment item ${none(before.payment_item_id)} → ${fields.payment_item_id}`,
    before.account_id !== fields.account_id &&
      `account ${none(before.account_id)} → ${fields.account_id}`,
    beforeLocal !== fields.local_date &&
      `date ${beforeLocal ?? 'none'} → ${fields.local_date} (location time)`,
    before.client_id !== fields.client_id &&
      `client ${none(before.client_id)} → ${none(fields.client_id)}`,
    before.team_member_id !== fields.team_member_id &&
      `team member ${none(before.team_member_id)} → ${none(fields.team_member_id)}`,
    before.supplier_id !== fields.supplier_id &&
      `supplier ${none(before.supplier_id)} → ${none(fields.supplier_id)}`,
    (before.comment ?? '') !== fields.comment &&
      (fields.comment === '' ? 'comment removed' : 'comment replaced'),
  ].filter((c): c is string => typeof c === 'string');
  if (changes.length === 0) {
    throw new ConfirmationRefusal(
      `financial transaction ${before.id} already holds these values; there is nothing to change.`
    );
  }
  return {
    text: [
      `Now: ${transactionLine(before, currency).slice(2)}${before.comment ? ' · with a comment' : ''}.`,
      'Changes:',
      ...changes.map((c) => `- ${c}`),
    ].join('\n'),
    version: plan.version,
  };
}

export async function updateFinancialTransaction(
  client: AltegioClient,
  input: UpdateTransactionInput,
  confirmation?: ConfirmedCall
): Promise<FinanceResult> {
  const plan = await planTransactionUpdate(client, input);
  const { before, fields, currency } = plan;
  // The update replaces every field, so it must run on the transaction the
  // person saw: a change made since would be overwritten unseen.
  if (
    confirmation?.version !== undefined &&
    confirmation.version !== plan.version
  ) {
    throw new FinanceInputError(
      `Nothing was changed: financial transaction ${before.id} was changed after the confirmation was shown, so the change approved is no longer the change this call would make. Read it again with financial_transactions_list, then repeat the call without confirmation_token to confirm against what it holds now.`
    );
  }
  const after = await api(client).updateFinancialTransaction(
    input.location_id,
    input.transaction_id,
    fields,
    writeOptions(confirmation)
  );
  const changes = [
    !sameMoney(before.amount, after.amount) &&
      `amount ${signed(before.amount, currency)} → ${signed(after.amount, currency)}`,
    before.payment_item_id !== after.payment_item_id &&
      `payment item ${before.payment_item_id} → ${after.payment_item_id}`,
    before.account_id !== after.account_id &&
      `account ${before.account_id} → ${after.account_id}`,
    before.date !== after.date && `date ${before.date} → ${after.date}`,
    before.client_id !== after.client_id &&
      `client ${before.client_id ?? 'none'} → ${after.client_id ?? 'none'}`,
    before.team_member_id !== after.team_member_id &&
      `team member ${before.team_member_id ?? 'none'} → ${after.team_member_id ?? 'none'}`,
    before.supplier_id !== after.supplier_id &&
      `supplier ${before.supplier_id ?? 'none'} → ${after.supplier_id ?? 'none'}`,
    (before.comment ?? '') !== (after.comment ?? '') && 'comment changed',
  ].filter((c): c is string => typeof c === 'string');
  return {
    text: withUntrustedBlock(
      lines(
        `Updated financial transaction ${after.id}: ${changes.length > 0 ? changes.join('; ') : 'no field changed'}.`,
        ...currencyNote(currency)
      ),
      transactionUntrusted([after]),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: {
      location_id: input.location_id,
      currency,
      ...after,
      previous: before,
    },
  };
}

export async function deleteFinancialTransaction(
  client: AltegioClient,
  input: { location_id: number; transaction_id: number },
  confirmation?: ConfirmedCall
): Promise<FinanceResult> {
  const finance = api(client);
  const [before, currency] = await Promise.all([
    finance.getFinancialTransaction(input.location_id, input.transaction_id),
    resolveLocationCurrency(client, input.location_id),
  ]);
  refuseLinked(before, 'deleted');
  await finance.deleteFinancialTransaction(
    input.location_id,
    input.transaction_id,
    writeOptions(confirmation)
  );
  return {
    text: withUntrustedBlock(
      lines(
        `Deleted financial transaction ${before.id} (${signed(before.amount, currency)}, account ${before.account_id}, payment item ${before.payment_item_id}, dated ${before.date ?? 'not reported'}).`,
        ...currencyNote(currency)
      ),
      transactionUntrusted([before]),
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: {
      location_id: input.location_id,
      currency,
      deleted: true,
      transaction: before,
    },
  };
}

// ========== payroll ==========

export async function getPayroll(
  client: AltegioClient,
  input: {
    location_id: number;
    team_member_id: number;
    date_from: string;
    date_to: string;
  }
): Promise<FinanceResult> {
  checkPeriod(input.date_from, input.date_to);
  const [report, currency] = await Promise.all([
    api(client).getPayroll(input.location_id, input.team_member_id, {
      date_from: input.date_from,
      date_to: input.date_to,
    }),
    resolveLocationCurrency(client, input.location_id),
  ]);
  const c = report.calculation;
  const s = report.settlements;
  const m = (v: number | null) => amountText(v, currency);
  const summary = lines(
    `Payroll of team member ${input.team_member_id} at location ${input.location_id} for ${input.date_from}..${input.date_to}:`,
    c
      ? lines(
          `- computed payroll ${m(c.payroll_amount)}, from revenue ${m(c.revenue_amount)}: services ${m(c.services_amount)} (${c.services_count ?? '?'} services${c.group_services_count ? `, ${c.group_services_count} in group events` : ''}), product sales ${m(c.product_sales_amount)} (${c.product_sales_count ?? '?'}).`,
          `- ${c.working_days ?? '?'} working day(s), ${c.working_hours ?? '?'} hour(s); guaranteed minimum ${m(c.guaranteed_minimum_amount)}; bonuses ${c.bonus_count ?? 0} (${m(c.bonus_amount)}); penalties ${c.penalty_count ?? 0} (${m(c.penalty_amount)}).`
        )
      : '- No payroll scheme applies to this team member in the period, so nothing is computed. Payroll rules are set in Altegio.',
    s &&
      `- settlements: accrued ${m(s.accrued_amount)}, paid ${m(s.paid_amount)}, balance ${m(s.balance)}${s.balance !== null && s.balance > 0 ? ' still owed to the team member' : ''}.`,
    `- saved payroll calculations: ${report.saved_calculations_total ?? report.saved_calculations.length}${report.saved_calculations.length > 0 ? ` — ${report.saved_calculations.map((x) => `${x.id} (${x.date_from}..${x.date_to}) ${m(x.amount)}${x.status ? `, ${x.status}` : ''}`).join('; ')}` : ''}${(report.saved_calculations_total ?? 0) > report.saved_calculations.length ? ` (first ${report.saved_calculations.length} shown)` : ''}.`,
    'The computed payroll is what the rules give for the period; settlements count only calculations saved in Altegio and the payouts recorded against them.',
    ...currencyNote(currency)
  );
  return {
    text: summary,
    structuredContent: {
      location_id: input.location_id,
      team_member_id: input.team_member_id,
      date_from: input.date_from,
      date_to: input.date_to,
      currency,
      ...report,
    },
  };
}
