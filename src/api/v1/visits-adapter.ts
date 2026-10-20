/**
 * V1 adapter for the visit and its payments: the `getVisit`, `addPayment`
 * and `cancelPayment` methods of the `VisitsApi` port.
 *
 * V2 has no visit or payment operation, and the V3 ones (`getVisit`,
 * `createPayment`, `cancelPayment`) are still `planned` in the spec and not
 * served, so these calls are V1 (the product owner's rule of 2026-09-29: V2
 * first, V1 only where V2 has nothing). The wire names stop here: `document`,
 * `sale`, `good`, `record`, `loyalty_certificate`, `loyalty_abonement`,
 * `prepay_hold`.
 *
 * Contract details verified live on the test location (2026-10-19):
 *
 * - A visit, as the tools read it, is the sale state of the appointment's
 *   visit document (`documents[]` with `type_id` 7 on the appointment). Its
 *   `payment_methods` say what can pay now; an account method's
 *   `applicable_amount` is the amount due (0 once the visit is paid).
 * - V1 reads and writes money as decimal major units; a payment's `Money` is
 *   sent as `majorOf(money)`, and visit totals are summed in minor units.
 * - V1 has no idempotency header, so the write methods ignore the
 *   `idempotency_key` of their `WriteOptions` (`../write-options.ts`).
 */
import { httpFromClient, type AltegioHttp } from '../altegio-http.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import { majorOf, roundMajor, sumMajor } from '../money.js';
import {
  FinanceInputError,
  FinanceNotFoundError,
  mapFinanceHttpError,
  type FinanceErrorHints,
} from '../../capabilities/finance/errors.js';
import {
  asRow,
  id,
  num,
  rows,
  text,
  flag,
  v1Read,
  type Method,
  type Row,
  type V1CallOptions,
  type V1Envelope,
} from './envelope.js';
import type {
  AdvancePaymentHold,
  AppointmentAttendance,
  PaymentMethod,
  PaymentOption,
  PaymentRequest,
  Visit,
  VisitItem,
  VisitPayment,
  VisitPaymentsApi,
} from '../visits-api.js';

/** The visit document type on an appointment's `documents[]`. */
const VISIT_DOCUMENT_TYPE = 7;

const ATTENDANCE_FROM_WIRE: Record<number, AppointmentAttendance> = {
  [-1]: 'no_show',
  0: 'waiting',
  1: 'arrived',
  2: 'confirmed',
};

/** The appointment as the visit read reports it. */
interface VisitRecord {
  location_id: number;
  appointment_id: number;
  visit_id: number | null;
  client_id: number | null;
  attendance: AppointmentAttendance;
  starts_at: string | null;
}

// ========== visit: wire → port ==========

function itemFromWire(row: Row): VisitItem {
  const type = text(row.type);
  const kind: VisitItem['kind'] =
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
    visit_item_id: id(row.sale_item_id),
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
    visit_item_id: id(row.sale_item_id),
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

/** Project the sale state of a visit document onto the visit. */
export function visitFromWire(sale: Row, context: VisitRecord): Visit {
  const state = asRow(sale.state);
  const items = rows(state.items).map(itemFromWire);
  const payments = [
    ...rows(state.payment_transactions).map(moneyPaymentFromWire),
    ...rows(state.loyalty_transactions).map(loyaltyPaymentFromWire),
  ];
  const options = rows(sale.payment_methods).map(optionFromWire);
  const total = sumMajor(items.map((item) => item.amount ?? 0));
  const paid = sumMajor(payments.map((payment) => payment.amount));
  // The account methods carry the backend's own amount due; without any,
  // fall back to the difference.
  const accountDue = options
    .filter((o) => o.method === 'account' && o.applicable)
    .map((o) => o.applicable_amount ?? 0);
  const due =
    accountDue.length > 0
      ? roundMajor(Math.max(...accountDue))
      : Math.max(0, sumMajor([total, -paid]));
  return {
    ...context,
    items,
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
          amount: majorOf(payment.amount),
        },
      };
    case 'client_account':
      return {
        payment: {
          method: { slug: 'deposit', deposit_id: payment.client_account_id },
          amount: majorOf(payment.amount),
        },
      };
    case 'loyalty_card':
      return {
        payment: {
          method: {
            slug: 'loyalty_card',
            loyalty_card_id: payment.loyalty_card_id,
          },
          amount: majorOf(payment.amount),
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
          amount: majorOf(payment.amount),
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
          amount: majorOf(payment.amount),
        },
      };
  }
}

// ========== the adapter ==========

export class VisitsV1Adapter implements VisitPaymentsApi {
  constructor(private readonly http: AltegioHttp) {}

  static forClient(client: AltegioClient): VisitsV1Adapter {
    return new VisitsV1Adapter(httpFromClient(client));
  }

  private async read(
    path: string,
    context: string,
    options: V1CallOptions<FinanceErrorHints> = {}
  ): Promise<V1Envelope> {
    return v1Read(this.http, path, context, mapFinanceHttpError, options);
  }

  /** The appointment's visit document and the ids the visit reports. */
  private async visitDocument(
    locationId: number,
    appointmentId: number
  ): Promise<{ document_id: number; record: VisitRecord }> {
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
        `Appointment ${appointmentId} has nothing to pay yet: Altegio opens its visit for payment once the appointment has a client. Add a client with appointments_update, then read the visit again.`
      );
    }
    const attendance = num(record.attendance);
    return {
      document_id: documentId,
      record: {
        location_id: locationId,
        appointment_id: appointmentId,
        visit_id: id(record.visit_id),
        client_id: id(asRow(record.client).id) ?? id(record.client_id),
        attendance:
          (attendance !== null
            ? ATTENDANCE_FROM_WIRE[attendance]
            : undefined) ?? 'unknown',
        starts_at: text(record.datetime),
      },
    };
  }

  private async saleVisit(
    locationId: number,
    doc: { document_id: number; record: VisitRecord },
    request: {
      method?: Method;
      path?: string;
      body?: unknown;
      context: string;
      hints?: FinanceErrorHints;
    }
  ): Promise<Visit> {
    const { data } = await this.read(
      `/locations/${locationId}/sale/${doc.document_id}${request.path ?? ''}`,
      request.context,
      {
        method: request.method ?? 'GET',
        ...(request.body !== undefined ? { body: request.body } : {}),
        ...(request.hints ? { hints: request.hints } : {}),
      }
    );
    return visitFromWire(asRow(data), doc.record);
  }

  async getVisit(locationId: number, appointmentId: number): Promise<Visit> {
    const doc = await this.visitDocument(locationId, appointmentId);
    return this.saleVisit(locationId, doc, {
      context: `read the visit of appointment ${appointmentId}`,
    });
  }

  async addPayment(
    locationId: number,
    appointmentId: number,
    payment: PaymentRequest
  ): Promise<Visit> {
    const doc = await this.visitDocument(locationId, appointmentId);
    return this.saleVisit(locationId, doc, {
      method: 'POST',
      path: '/payment',
      body: paymentBody(payment),
      context: `record a payment on the visit of appointment ${appointmentId}`,
      hints: {
        invalid:
          'Read the visit with visits_get and take the method, its id and an amount no larger than its applicable_amount from payment_options.',
        forbidden:
          'Recording payments needs the right to accept payments for visits at this location; ask the location owner for it.',
      },
    });
  }

  async cancelPayment(
    locationId: number,
    appointmentId: number,
    paymentId: string
  ): Promise<Visit> {
    const match = /^([tl])(\d+)$/.exec(paymentId);
    if (!match) {
      throw new FinanceInputError(
        `Payment id "${paymentId.slice(0, 40)}" is not one visits_get reports (t<number> or l<number>).`
      );
    }
    const kind =
      match[1] === 't' ? 'payment_transaction' : 'loyalty_transaction';
    const doc = await this.visitDocument(locationId, appointmentId);
    return this.saleVisit(locationId, doc, {
      method: 'DELETE',
      path: `/payment/${kind}/${match[2]}`,
      context: `cancel payment ${paymentId} on the visit of appointment ${appointmentId}`,
      hints: {
        invalid:
          'A payment applied from an advance payment hold cannot be cancelled here.',
        notFound: 'Read the visit with visits_get for the current payment ids.',
      },
    });
  }
}
