/**
 * Adapter for the `FinanceApi` port over V1.
 *
 * V2 has no visit, payment or finance operation, and the V3 visit and payment
 * operations (`getVisit`, `createPayment`, `cancelPayment`, `addVisitItem`,
 * `listAccounts`) are still `planned` in the spec and not served, so every call
 * here is V1 (the product owner's rule of 2026-09-29: V2 first, V1 only where
 * V2 has nothing). The port speaks the product glossary; the wire names stop
 * here: `document`, `sale`, `good`, `record`, `deposit`, `loyalty_certificate`,
 * `loyalty_abonement`, `prepay_hold`, `expense`, `master`, `salary`.
 *
 * Contract details verified live on the test location (2026-10-19):
 *
 * - A visit's bill is the sale state of the appointment's visit document
 *   (`documents[]` with `type_id` 7 on the appointment). Its `payment_methods`
 *   say what can pay now; an account method's `applicable_amount` is the amount
 *   due (0 once the bill is paid).
 * - A financial transaction's sign follows its payment item: an expense item
 *   stores a positive amount as negative, an income item stores any amount as
 *   positive. The tools therefore take a positive amount.
 * - `PUT /finance_transactions/{id}` replaces every field — an omitted team
 *   member, client, supplier or document is cleared — so an update reads the
 *   transaction first and sends every field back.
 * - Create stores `date` as server wall time and update converts it from the
 *   location's; see `./server-time.ts`.
 * - The payroll period read answers 416 when no payroll scheme applies to the
 *   team member; that is reported as "no calculation", not as a failure.
 */
import {
  httpFromClient,
  queryString,
  type AltegioHttp,
} from '../altegio-http.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import {
  FinanceInputError,
  FinanceNotFoundError,
  mapFinanceHttpError,
  type FinanceErrorHints,
} from '../../capabilities/finance/errors.js';
import { knownLocationTimezone } from '../../capabilities/analytics/location-timezone.js';
import {
  V1_SERVER_TIMEZONE,
  instantOfWallTime,
  v1DateForLocation,
  wallTime,
} from './server-time.js';
import type {
  AdvancePaymentHold,
  BillLine,
  CashRegisterOrAccount,
  ClientAccount,
  ClientAccountDepositRequest,
  ClientAccountDepositResult,
  FinanceApi,
  FinancialTransaction,
  FinancialTransactionFields,
  FinancialTransactionQuery,
  IncomeExpenseCategory,
  PaymentItem,
  PaymentMethod,
  PaymentOption,
  PaymentRequest,
  PayrollCalculation,
  PayrollReport,
  PayrollSettlements,
  SavedPayrollCalculation,
  VisitBill,
  VisitPayment,
} from '../finance-api.js';

type Row = Record<string, unknown>;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** The visit document type on an appointment's `documents[]`. */
const VISIT_DOCUMENT_TYPE = 7;

/** Saved payroll calculations listed next to the period's payroll. */
const SAVED_CALCULATIONS_SHOWN = 20;

// ========== coercions ==========

function asRow(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {};
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(asRow) : [];
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** A positive id, or null for 0, empty and missing (V1 writes 0 for "none"). */
function id(value: unknown): number | null {
  const n = num(value);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

function text(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}

function flag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const n = num(value);
  return n === null ? null : n !== 0;
}

/** Round a sum of money to cents, so float noise never reaches the model. */
export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

async function safeJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

// ========== visit bill: wire → port ==========

function lineFromWire(row: Row): BillLine {
  const type = text(row.type);
  const kind: BillLine['kind'] =
    type === 'service' ? 'service' : type === 'good' ? 'product' : 'other';
  return {
    id: id(row.id) ?? 0,
    appointment_id: id(row.record_id),
    kind,
    service_id:
      kind === 'service' ? (id(row.service_id) ?? id(row.item_id)) : null,
    product_id:
      kind === 'product' ? (id(row.good_id) ?? id(row.item_id)) : null,
    title: text(row.title),
    quantity: num(row.amount),
    unit_price: num(row.default_cost_per_unit),
    amount_before_discount: num(row.default_cost_total),
    client_discount_percent: num(row.client_discount_percent),
    amount: num(row.cost_to_pay_total),
  };
}

const NO_INSTRUMENT = {
  client_account_id: null,
  loyalty_card_id: null,
  loyalty_program_id: null,
  gift_card_id: null,
  membership_id: null,
};

function moneyPaymentFromWire(row: Row): VisitPayment {
  const account = asRow(row.account);
  const snapshot = asRow(row.payment_method_snapshot);
  return {
    id: `t${id(row.id) ?? 0}`,
    method: 'account',
    amount: num(row.amount) ?? 0,
    bill_line_id: id(row.sale_item_id),
    account_id: id(row.account_id) ?? id(account.id),
    account_title: text(account.title),
    payment_method_name: text(snapshot.payment_method_name),
    ...NO_INSTRUMENT,
  };
}

function loyaltyPaymentFromWire(row: Row): VisitPayment {
  const clientAccountId = id(asRow(row.deposit).id) ?? id(row.deposit_id);
  const giftCardId =
    id(row.loyalty_certificate_id) ?? id(asRow(row.loyalty_certificate).id);
  const membershipId =
    id(row.loyalty_abonement_id) ?? id(asRow(row.loyalty_abonement).id);
  const programId = id(row.loyalty_program_id);
  const cardId = id(row.loyalty_card_id);
  const method: PaymentMethod =
    clientAccountId !== null || id(row.deposit_transaction_id) !== null
      ? 'client_account'
      : giftCardId !== null
        ? 'gift_card'
        : membershipId !== null
          ? 'membership'
          : programId !== null
            ? 'loyalty_program'
            : cardId !== null
              ? 'loyalty_card'
              : 'other';
  return {
    id: `l${id(row.id) ?? 0}`,
    method,
    amount: num(row.amount) ?? 0,
    bill_line_id: id(row.sale_item_id),
    account_id: null,
    account_title: null,
    payment_method_name: null,
    client_account_id: clientAccountId,
    loyalty_card_id: cardId,
    loyalty_program_id: programId,
    gift_card_id: giftCardId,
    membership_id: membershipId,
  };
}

function holdFromWire(row: Row): AdvancePaymentHold {
  return {
    id: id(row.id) ?? 0,
    client_account_id: id(row.deposit_id),
    amount: num(row.amount_major) ?? num(row.amount),
    status: text(row.status),
  };
}

const SLUG_TO_METHOD: Record<string, PaymentMethod> = {
  account: 'account',
  deposit: 'client_account',
  loyalty_card: 'loyalty_card',
  loyalty_program: 'loyalty_program',
  loyalty_certificate: 'gift_card',
  loyalty_abonement: 'membership',
  referral_loyalty_program: 'referral_program',
  prepay_hold: 'advance_payment_hold',
};

function optionFromWire(row: Row): PaymentOption {
  const slug = text(row.slug) ?? '';
  const method = SLUG_TO_METHOD[slug] ?? 'other';
  const account = asRow(row.account);
  const deposit = asRow(row.deposit);
  const card = asRow(row.loyalty_card);
  const program = asRow(row.loyalty_program);
  const certificate = asRow(row.loyalty_certificate);
  const membership = asRow(row.loyalty_abonement);
  const instrument =
    method === 'gift_card'
      ? certificate
      : method === 'membership'
        ? membership
        : method === 'loyalty_program' || method === 'referral_program'
          ? program
          : card;
  const codeRequired = flag(asRow(instrument.type).is_code_required);
  return {
    method,
    applicable: flag(row.is_applicable) === true,
    applicable_amount: num(row.applicable_amount),
    partial_allowed: flag(row.is_partial_allowed) !== false,
    account_id: method === 'account' ? id(row.account_id) : null,
    account_title: method === 'account' ? text(account.title) : null,
    cash: method === 'account' ? flag(account.is_cash) : null,
    client_account_id:
      method === 'client_account'
        ? (id(row.deposit_id) ?? id(deposit.id))
        : null,
    loyalty_card_id: id(row.loyalty_card_id),
    loyalty_card_number: text(card.number),
    loyalty_program_id: id(row.loyalty_program_id),
    loyalty_program_title: text(program.title),
    gift_card_id: id(row.loyalty_certificate_id),
    membership_id: id(row.loyalty_abonement_id),
    number_required:
      method === 'gift_card' || method === 'membership' ? codeRequired : null,
    applicable_visits:
      method === 'membership' ? num(row.applicable_count) : null,
    advance_payment_hold_id:
      method === 'advance_payment_hold' ? id(row.hold_id) : null,
    balance:
      method === 'client_account'
        ? num(deposit.balance)
        : method === 'gift_card'
          ? (num(certificate.applicable_balance) ?? num(certificate.balance))
          : method === 'loyalty_card' || method === 'loyalty_program'
            ? num(card.balance)
            : null,
    chain_id: id(asRow(instrument.chain).id),
  };
}

/** Project the sale state of a visit document onto the bill. */
export function billFromWire(
  sale: Row,
  context: {
    location_id: number;
    appointment_id: number;
    visit_id: number | null;
    client_id: number | null;
  }
): VisitBill {
  const state = asRow(sale.state);
  const lines = rows(state.items).map(lineFromWire);
  const payments = [
    ...rows(state.payment_transactions).map(moneyPaymentFromWire),
    ...rows(state.loyalty_transactions).map(loyaltyPaymentFromWire),
  ];
  const options = rows(sale.payment_methods).map(optionFromWire);
  const total = roundMoney(
    lines.reduce((sum, line) => sum + (line.amount ?? 0), 0)
  );
  const paid = roundMoney(
    payments.reduce((sum, payment) => sum + payment.amount, 0)
  );
  // The account methods carry the backend's own amount due; without any,
  // fall back to the difference.
  const accountDue = options
    .filter((o) => o.method === 'account' && o.applicable)
    .map((o) => o.applicable_amount ?? 0);
  const due =
    accountDue.length > 0
      ? roundMoney(Math.max(...accountDue))
      : roundMoney(Math.max(0, total - paid));
  return {
    ...context,
    lines,
    payments,
    advance_payment_holds: rows(state.deposit_holds).map(holdFromWire),
    payment_options: options,
    total_amount: total,
    paid_amount: paid,
    amount_due: due,
  };
}

/** The wire body of one payment. */
export function paymentBody(payment: PaymentRequest): Row {
  switch (payment.method) {
    case 'account':
      return {
        payment: {
          method: { slug: 'account', account_id: payment.account_id },
          amount: payment.amount,
        },
      };
    case 'client_account':
      return {
        payment: {
          method: { slug: 'deposit', deposit_id: payment.client_account_id },
          amount: payment.amount,
        },
      };
    case 'loyalty_card':
      return {
        payment: {
          method: {
            slug: 'loyalty_card',
            loyalty_card_id: payment.loyalty_card_id,
          },
          amount: payment.amount,
        },
      };
    case 'loyalty_program':
      return {
        payment: {
          method: {
            slug: 'loyalty_program',
            loyalty_card_id: payment.loyalty_card_id,
            loyalty_program_id: payment.loyalty_program_id,
          },
        },
      };
    case 'gift_card':
      return {
        payment: {
          method: {
            slug: 'loyalty_certificate',
            loyalty_certificate_id: payment.gift_card_id,
          },
          amount: payment.amount,
          ...(payment.number ? { number: payment.number } : {}),
        },
      };
    case 'membership':
      return {
        payment: {
          method: {
            slug: 'loyalty_abonement',
            loyalty_abonement_id: payment.membership_id,
          },
          ...(payment.number ? { number: payment.number } : {}),
        },
      };
    case 'advance_payment_hold':
      return {
        payment: {
          method: {
            slug: 'prepay_hold',
            hold_id: payment.advance_payment_hold_id,
          },
          amount: payment.amount,
        },
      };
  }
}

// ========== client accounts, accounts and cash registers ==========

function clientAccountFromWire(row: Row): ClientAccount {
  const account = asRow(row.deposit);
  const type = asRow(row.deposit_type);
  return {
    id: id(account.id) ?? 0,
    chain_id: id(account.salon_group_id) ?? id(type.salon_group_id),
    type_id: id(account.deposit_type_id) ?? id(type.id),
    type_title: text(type.title),
    balance: num(account.balance),
    reserved_balance: num(account.reserved_balance),
    initial_balance: num(account.initial_balance),
    blocked: flag(account.blocked) === true,
    created_at: text(account.date_create),
  };
}

function cashRegisterFromWire(row: Row): CashRegisterOrAccount {
  const slug = text(row.type_slug);
  const cash = slug ? slug === 'cash' : num(row.type) === 0;
  return {
    id: id(row.id) ?? 0,
    title: text(row.title),
    settlement: cash ? 'cash' : 'non_cash',
    acquiring: flag(row.is_acquiring) === true,
    comment: text(row.comment),
  };
}

// ========== financial transactions ==========

const CATEGORY_FROM_WIRE: Record<number, IncomeExpenseCategory> = {
  1: 'prime_cost',
  2: 'commercial',
  3: 'personnel',
  4: 'administrative',
  5: 'taxes_and_fees',
  6: 'miscellaneous',
  7: 'income',
};

function paymentItemFromWire(row: Row): PaymentItem {
  const category = CATEGORY_FROM_WIRE[num(row.type) ?? 0] ?? 'unknown';
  return {
    id: id(row.id) ?? 0,
    title: text(row.title),
    category,
    direction: category === 'income' ? 'income' : 'expense',
  };
}

function transactionFromWire(
  row: Row,
  zone: string | null
): FinancialTransaction {
  const amount = num(row.amount) ?? 0;
  const item = asRow(row.expense);
  const account = asRow(row.account);
  const team = row.master;
  const teamId = Array.isArray(team) ? null : id(asRow(team).id);
  return {
    id: id(row.id) ?? 0,
    date: v1DateForLocation(row.date, zone),
    amount,
    direction:
      amount < 0 || (amount === 0 && num(item.type) !== 7)
        ? 'expense'
        : 'income',
    payment_item_id: id(row.expense_id) ?? id(item.id),
    payment_item_title: text(item.title),
    account_id: id(row.account_id) ?? id(account.id),
    account_title: text(account.title),
    client_id: id(row.client_id) ?? id(asRow(row.client).id),
    team_member_id: id(row.master_id) ?? teamId,
    supplier_id: id(row.supplier_id) ?? id(asRow(row.supplier).id),
    document_id: id(row.document_id),
    appointment_id: id(row.record_id),
    visit_id: id(row.visit_id),
    comment: text(row.comment),
    changed_at: v1DateForLocation(row.last_change_date, zone),
  };
}

function transactionBody(
  fields: FinancialTransactionFields,
  date: string
): Row {
  return {
    expense_id: fields.payment_item_id,
    account_id: fields.account_id,
    amount: fields.amount,
    date,
    comment: fields.comment,
    client_id: fields.client_id ?? 0,
    team_member_id: fields.team_member_id ?? 0,
    supplier_id: fields.supplier_id ?? 0,
  };
}

// ========== payroll ==========

function payrollFromWire(row: Row): PayrollCalculation {
  return {
    working_days: num(row.working_days_count),
    working_hours: num(row.working_hours_count),
    services_count: num(row.services_count),
    group_services_count: num(row.group_services_count),
    services_amount: num(row.services_sum),
    product_sales_count: num(row.goods_sales_count),
    product_sales_amount: num(row.goods_sales_sum),
    revenue_amount: num(row.total_sum),
    payroll_amount: num(row.salary),
    guaranteed_minimum_amount: num(row.guaranteed_minimum_sum),
    bonus_count: num(row.bonus_count),
    bonus_amount: num(row.bonus_sum),
    penalty_count: num(row.penalty_count),
    penalty_amount: num(row.penalty_sum),
  };
}

function settlementsFromWire(row: Row): PayrollSettlements {
  const total = asRow(row.total_sum);
  const paid = num(total.expense);
  return {
    accrued_amount: num(total.income),
    paid_amount: paid === null ? null : Math.abs(paid),
    balance: num(total.balance),
  };
}

function savedCalculationFromWire(row: Row): SavedPayrollCalculation {
  return {
    id: id(row.id) ?? 0,
    date_from: text(row.date_from),
    date_to: text(row.date_to),
    amount: num(row.amount),
    status: text(row.status),
  };
}

// ========== the adapter ==========

export type ZoneResolver = (locationId: number) => Promise<string | null>;

export class FinanceAdapter implements FinanceApi {
  constructor(
    private readonly http: AltegioHttp,
    private readonly zoneOf: ZoneResolver = async () => null,
    private readonly now: () => number = Date.now
  ) {}

  static forClient(client: AltegioClient): FinanceAdapter {
    return new FinanceAdapter(httpFromClient(client), (locationId) =>
      knownLocationTimezone(client, locationId)
    );
  }

  private async call(
    path: string,
    context: string,
    options: {
      method?: Method;
      query?: Record<string, string | number | boolean | undefined | null>;
      body?: unknown;
      hints?: FinanceErrorHints;
      /** Statuses answered with `null` instead of an error. */
      tolerate?: readonly number[];
    } = {}
  ): Promise<{ data: unknown; meta: Row } | null> {
    if (!this.http.isAuthenticated()) {
      throw mapFinanceHttpError(401, undefined, context);
    }
    const headers: Record<string, string> = {};
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    const response = await this.http.request(
      `${path}${options.query ? queryString(options.query) : ''}`,
      {
        method: options.method ?? 'GET',
        headers,
        ...(body !== undefined ? { body } : {}),
      }
    );
    const payload = await safeJson(response);
    if (options.tolerate?.includes(response.status)) return null;
    if (!response.ok) {
      throw mapFinanceHttpError(
        response.status,
        payload,
        context,
        options.hints
      );
    }
    const envelope = asRow(payload);
    if (envelope.success === false) {
      throw mapFinanceHttpError(422, payload, context, options.hints);
    }
    return { data: envelope.data ?? null, meta: asRow(envelope.meta) };
  }

  private async read(
    path: string,
    context: string,
    options: Parameters<FinanceAdapter['call']>[2] = {}
  ): Promise<{ data: unknown; meta: Row }> {
    const result = await this.call(path, context, options);
    return result ?? { data: null, meta: {} };
  }

  // ----- visit bill -----

  /** The appointment's visit document and the ids the bill reports. */
  private async visitDocument(
    locationId: number,
    appointmentId: number
  ): Promise<{
    document_id: number;
    visit_id: number | null;
    client_id: number | null;
  }> {
    const { data } = await this.read(
      `/locations/${locationId}/appointments/${appointmentId}`,
      `read appointment ${appointmentId}`,
      {
        hints: {
          notFound:
            'Check the appointment id with appointments_list for this location.',
        },
      }
    );
    const record = asRow(data);
    const owner = id(record.company_id);
    if (
      id(record.id) !== appointmentId ||
      (owner !== null && owner !== locationId)
    ) {
      throw new FinanceNotFoundError(
        `Appointment ${appointmentId} was not found at location ${locationId}. Check the id with appointments_list.`
      );
    }
    const documents = rows(record.documents).filter(
      (doc) => num(doc.type_id) === VISIT_DOCUMENT_TYPE
    );
    const document =
      documents.find((doc) => id(doc.record_id) === appointmentId) ??
      documents[0];
    const documentId = document ? id(document.id) : null;
    if (documentId === null) {
      throw new FinanceInputError(
        `Appointment ${appointmentId} has no bill yet: Altegio opens one when the appointment has a client. Add a client with appointments_update, then read the bill again.`
      );
    }
    return {
      document_id: documentId,
      visit_id: id(record.visit_id),
      client_id: id(asRow(record.client).id) ?? id(record.client_id),
    };
  }

  private async saleBill(
    locationId: number,
    appointmentId: number,
    doc: {
      document_id: number;
      visit_id: number | null;
      client_id: number | null;
    },
    request: {
      method?: Method;
      path?: string;
      body?: unknown;
      context: string;
      hints?: FinanceErrorHints;
    }
  ): Promise<VisitBill> {
    const { data } = await this.read(
      `/locations/${locationId}/sale/${doc.document_id}${request.path ?? ''}`,
      request.context,
      {
        method: request.method ?? 'GET',
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.hints ? { hints: request.hints } : {}),
      }
    );
    return billFromWire(asRow(data), {
      location_id: locationId,
      appointment_id: appointmentId,
      visit_id: doc.visit_id,
      client_id: doc.client_id,
    });
  }

  async getVisitBill(
    locationId: number,
    appointmentId: number
  ): Promise<VisitBill> {
    const doc = await this.visitDocument(locationId, appointmentId);
    return this.saleBill(locationId, appointmentId, doc, {
      context: `read the bill of appointment ${appointmentId}`,
    });
  }

  async addPayment(
    locationId: number,
    appointmentId: number,
    payment: PaymentRequest
  ): Promise<VisitBill> {
    const doc = await this.visitDocument(locationId, appointmentId);
    return this.saleBill(locationId, appointmentId, doc, {
      method: 'POST',
      path: '/payment',
      body: paymentBody(payment),
      context: `record a payment on the bill of appointment ${appointmentId}`,
      hints: {
        invalid:
          'Read the bill with visits_get and take the method, its id and an amount no larger than its applicable_amount from payment_options.',
        forbidden:
          'Recording payments needs the right to accept payments for visits at this location; ask the location owner for it.',
      },
    });
  }

  async cancelPayment(
    locationId: number,
    appointmentId: number,
    paymentId: string
  ): Promise<VisitBill> {
    const match = /^([tl])(\d+)$/.exec(paymentId);
    if (!match) {
      throw new FinanceInputError(
        `Payment id "${paymentId.slice(0, 40)}" is not one visits_get reports (t<number> or l<number>).`
      );
    }
    const kind =
      match[1] === 't' ? 'payment_transaction' : 'loyalty_transaction';
    const doc = await this.visitDocument(locationId, appointmentId);
    return this.saleBill(locationId, appointmentId, doc, {
      method: 'DELETE',
      path: `/payment/${kind}/${match[2]}`,
      context: `cancel payment ${paymentId} on the bill of appointment ${appointmentId}`,
      hints: {
        invalid:
          'A payment applied from an advance payment hold cannot be cancelled here.',
        notFound: 'Read the bill with visits_get for the current payment ids.',
      },
    });
  }

  // ----- client accounts -----

  async listClientAccounts(
    locationId: number,
    clientId: number
  ): Promise<ClientAccount[]> {
    const { data } = await this.read(
      `/deposits/company/${locationId}/client/${clientId}`,
      `list the client accounts of client ${clientId}`,
      {
        hints: {
          notFound:
            'Check the client id with clients_lookup or clients_search for this location.',
        },
      }
    );
    return rows(data)
      .map(clientAccountFromWire)
      .filter((account) => account.id > 0);
  }

  async deposit(
    locationId: number,
    request: ClientAccountDepositRequest
  ): Promise<ClientAccountDepositResult> {
    const { data } = await this.read(
      `/deposits_operations/${locationId}`,
      `deposit money to client account ${request.client_account_id}`,
      {
        method: 'POST',
        body: {
          client_id: request.client_id,
          deposit_id: request.client_account_id,
          amount: request.amount,
          account_id: request.account_id,
          ...(request.team_member_id !== undefined
            ? { team_member_id: request.team_member_id }
            : {}),
        },
        hints: {
          invalid:
            'Take client_account_id from client_accounts_list_for_client for this client and account_id from accounts_and_cash_registers_list; the amount must be above zero.',
        },
      }
    );
    const body = asRow(data);
    const movement =
      rows(body.deposits_transactions).find(
        (row) => id(row.deposit_id) === request.client_account_id
      ) ?? rows(body.deposits_transactions)[0];
    const money = rows(body.payment_transactions)[0];
    return {
      client_account_id: request.client_account_id,
      amount: num(movement?.amount) ?? request.amount,
      balance_after: num(movement?.balance_after),
      reserved_balance_after: num(movement?.reserved_balance_after),
      financial_transaction_id: money ? id(money.id) : null,
    };
  }

  // ----- accounts and cash registers -----

  async listCashRegistersAndAccounts(
    locationId: number
  ): Promise<CashRegisterOrAccount[]> {
    const { data } = await this.read(
      `/accounts/${locationId}`,
      'list the accounts and cash registers of this location'
    );
    return rows(data)
      .map(cashRegisterFromWire)
      .filter((account) => account.id > 0);
  }

  // ----- financial transactions -----

  async listPaymentItems(locationId: number): Promise<PaymentItem[]> {
    const { data } = await this.read(
      `/references/expenses/${locationId}`,
      'list the payment items of this location'
    );
    return rows(data)
      .map(paymentItemFromWire)
      .filter((item) => item.id > 0);
  }

  async listFinancialTransactions(
    locationId: number,
    query: FinancialTransactionQuery
  ): Promise<FinancialTransaction[]> {
    const [{ data }, zone] = await Promise.all([
      this.read(
        `/transactions/${locationId}`,
        'list the financial transactions of this location',
        {
          query: {
            start_date: query.date_from,
            end_date: query.date_to,
            account_id: query.account_id,
            client_id: query.client_id,
            team_member_id: query.team_member_id,
            supplier_id: query.supplier_id,
            page: query.page,
            count: query.page_size,
          },
        }
      ),
      this.zoneOf(locationId),
    ]);
    return rows(data).map((row) => transactionFromWire(row, zone));
  }

  async getFinancialTransaction(
    locationId: number,
    transactionId: number
  ): Promise<FinancialTransaction> {
    const [{ data }, zone] = await Promise.all([
      this.read(
        `/finance_transactions/${locationId}/${transactionId}`,
        `read financial transaction ${transactionId}`,
        {
          hints: {
            notFound:
              'Check the id with financial_transactions_list; a deleted transaction is not found.',
          },
        }
      ),
      this.zoneOf(locationId),
    ]);
    return transactionFromWire(asRow(data), zone);
  }

  async createFinancialTransaction(
    locationId: number,
    fields: FinancialTransactionFields
  ): Promise<FinancialTransaction> {
    const zone = await this.zoneOf(locationId);
    if (zone === null) {
      throw new FinanceInputError(
        `The time zone of location ${locationId} is unknown, so the transaction date cannot be placed. Check the location with locations_list.`
      );
    }
    const instant = instantOfWallTime(fields.local_date, zone) ?? this.now();
    const { data } = await this.read(
      `/finance_transactions/${locationId}`,
      'create a financial transaction',
      {
        method: 'POST',
        body: transactionBody(fields, wallTime(instant, V1_SERVER_TIMEZONE)),
        hints: TRANSACTION_WRITE_HINTS,
      }
    );
    return transactionFromWire(asRow(data), zone);
  }

  async updateFinancialTransaction(
    locationId: number,
    transactionId: number,
    fields: FinancialTransactionFields
  ): Promise<FinancialTransaction> {
    const zone = await this.zoneOf(locationId);
    const { data } = await this.read(
      `/finance_transactions/${locationId}/${transactionId}`,
      `update financial transaction ${transactionId}`,
      {
        method: 'PUT',
        // The update converts `date` from location time itself.
        body: transactionBody(fields, fields.local_date),
        hints: TRANSACTION_WRITE_HINTS,
      }
    );
    return transactionFromWire(asRow(data), zone);
  }

  async deleteFinancialTransaction(
    locationId: number,
    transactionId: number
  ): Promise<void> {
    await this.read(
      `/finance_transactions/${locationId}/${transactionId}`,
      `delete financial transaction ${transactionId}`,
      {
        method: 'DELETE',
        hints: {
          notFound:
            'Check the id with financial_transactions_list; it may already be deleted.',
        },
      }
    );
  }

  // ----- payroll -----

  async getPayroll(
    locationId: number,
    teamMemberId: number,
    period: { date_from: string; date_to: string }
  ): Promise<PayrollReport> {
    const base = `/locations/${locationId}/salary`;
    const query = { date_from: period.date_from, date_to: period.date_to };
    const hints: FinanceErrorHints = {
      notFound:
        'Check the team member id with team_members_list for this location.',
      forbidden:
        'Payroll needs the Payroll right at this location (or the right to see this team member’s own payroll); ask the location owner for it.',
    };
    const [calculation, settlements, saved] = await Promise.all([
      this.call(
        `${base}/period/team_members/${teamMemberId}`,
        `read the payroll of team member ${teamMemberId}`,
        { query, hints, tolerate: [416] }
      ),
      this.read(
        `${base}/calculation/team_members/${teamMemberId}`,
        `read the settlements with team member ${teamMemberId}`,
        { query, hints }
      ),
      this.read(
        `${base}/payroll/team_members/${teamMemberId}/calculation`,
        `list the saved payroll calculations of team member ${teamMemberId}`,
        { query, hints }
      ),
    ]);
    const savedRows = rows(saved.data);
    return {
      calculation: calculation
        ? payrollFromWire(asRow(calculation.data))
        : null,
      settlements: settlementsFromWire(asRow(settlements.data)),
      saved_calculations: savedRows
        .slice(0, SAVED_CALCULATIONS_SHOWN)
        .map(savedCalculationFromWire),
      saved_calculations_total: num(saved.meta.count) ?? savedRows.length,
    };
  }
}

const TRANSACTION_WRITE_HINTS: FinanceErrorHints = {
  invalid:
    'Take account_id from accounts_and_cash_registers_list and payment_item_id from financial_transactions_list_payment_items; the amount must be above zero, and a user may be limited to some accounts, payment items or recent days.',
};
