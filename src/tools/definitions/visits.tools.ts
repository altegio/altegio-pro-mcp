/**
 * `[Visits]` tool pack — the bill of an appointment's visit and the payments
 * recorded against it.
 *
 * A visit's bill lists what the client pays for (service lines from the
 * appointment, product lines sold with it), the payments already recorded, the
 * amount due, and the payment methods that can pay it now. A payment records
 * money received — cash or non-cash into one of the accounts and cash
 * registers, or from a client account, loyalty card, loyalty program, gift
 * card, membership or advance payment hold. An advance payment is a payment
 * recorded before the visit, for part of the amount due.
 *
 * Names, parameters and results use the product glossary; the wire vocabulary
 * (`document`, `sale`, `deposit`, `loyalty_certificate`, `loyalty_abonement`,
 * `prepay_hold`, `record`, `good`) stops in `src/api/v1/finance-adapter.ts`.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import * as finance from '../../capabilities/finance/use-cases.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const int = { type: ['integer', 'null'] as const };
const num = { type: ['number', 'null'] as const };
const str = { type: ['string', 'null'] as const };
const boolOrNull = { type: ['boolean', 'null'] as const };

const locationId = z
  .number()
  .int()
  .positive()
  .describe('Location id, from locations_list.');

const appointmentId = z
  .number()
  .int()
  .positive()
  .describe('Appointment id, from appointments_list.');

/** Major units, positive, at most two decimals. */
export const moneyAmount = (what: string) =>
  z
    .number()
    .positive()
    .max(1_000_000_000)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
      message: 'Use at most two decimals.',
    })
    .describe(
      `${what} In the location's currency, major units (550.5, not cents).`
    );

const lineSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'integer' as const },
    appointment_id: int,
    kind: { type: 'string' as const, enum: ['service', 'product', 'other'] },
    service_id: int,
    product_id: int,
    title: str,
    quantity: num,
    unit_price: num,
    amount_before_discount: num,
    client_discount_percent: num,
    amount: num,
  },
  required: ['id', 'kind'],
};

const METHODS = [
  'account',
  'client_account',
  'loyalty_card',
  'loyalty_program',
  'gift_card',
  'membership',
  'referral_program',
  'advance_payment_hold',
  'other',
] as const;

const paymentSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'string' as const },
    method: { type: 'string' as const, enum: [...METHODS] },
    amount: { type: 'number' as const },
    bill_line_id: int,
    account_id: int,
    account_title: str,
    payment_method_name: str,
    client_account_id: int,
    loyalty_card_id: int,
    loyalty_program_id: int,
    gift_card_id: int,
    membership_id: int,
  },
  required: ['id', 'method', 'amount'],
};

const optionSchema = {
  type: 'object' as const,
  properties: {
    method: { type: 'string' as const, enum: [...METHODS] },
    applicable: { type: 'boolean' as const },
    applicable_amount: num,
    partial_allowed: { type: 'boolean' as const },
    account_id: int,
    account_title: str,
    cash: boolOrNull,
    client_account_id: int,
    loyalty_card_id: int,
    loyalty_card_number: str,
    loyalty_program_id: int,
    loyalty_program_title: str,
    gift_card_id: int,
    membership_id: int,
    number_required: boolOrNull,
    applicable_visits: num,
    advance_payment_hold_id: int,
    balance: num,
    chain_id: int,
  },
  required: ['method', 'applicable', 'partial_allowed'],
};

const billSchema = {
  type: 'object' as const,
  properties: {
    location_id: { type: 'integer' as const },
    appointment_id: { type: 'integer' as const },
    visit_id: int,
    client_id: int,
    currency: str,
    total_amount: { type: 'number' as const },
    paid_amount: { type: 'number' as const },
    amount_due: { type: 'number' as const },
    lines: { type: 'array' as const, items: lineSchema },
    payments: { type: 'array' as const, items: paymentSchema },
    advance_payment_holds: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          id: { type: 'integer' as const },
          client_account_id: int,
          amount: num,
          status: str,
        },
        required: ['id'],
      },
    },
    payment_options: { type: 'array' as const, items: optionSchema },
    unavailable_payment_options: { type: 'integer' as const },
    added_payment_ids: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    cancelled_payment_id: str,
  },
  required: [
    'location_id',
    'appointment_id',
    'currency',
    'total_amount',
    'paid_amount',
    'amount_due',
    'lines',
    'payments',
    'payment_options',
  ],
};

export const visitsGetTool = defineTool({
  name: 'visits_get',
  category: 'Visits',
  description:
    'The bill of an appointment’s visit: service and product lines with amounts, payments recorded, total amount, amount paid and amount due, and the payment methods that can pay it now (accounts and cash registers, client account, loyalty card or program, gift card, membership, advance payment hold) with what each accepts. Read it before visits_add_payment or visits_cancel_payment.',
  annotations: { title: 'Visits: read the bill', ...READ_ONLY },
  input: z.object({ location_id: locationId, appointment_id: appointmentId }),
  outputSchema: billSchema,
  handler: async ({ input, client }) => finance.getVisitBill(client, input),
});

const optionalId = (what: string) =>
  z.number().int().positive().optional().describe(what);

export const visitsAddPaymentTool = defineTool({
  name: 'visits_add_payment',
  category: 'Visits',
  description:
    'Record a payment or an advance payment on an appointment’s bill: money received into an account or cash register (method account + account_id), or paid from a client account, loyalty card, loyalty program, gift card, membership or advance payment hold — method and its id from payment_options in visits_get. Pass amount_due from visits_get as expected_amount_due; the call is refused if the bill changed. Records money received; charges no card. Asks for confirmation first.',
  annotations: {
    title: 'Visits: record a payment',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    appointment_id: appointmentId,
    method: z
      .enum([
        'account',
        'client_account',
        'loyalty_card',
        'loyalty_program',
        'gift_card',
        'membership',
        'advance_payment_hold',
      ])
      .describe('How it is paid, as payment_options in visits_get names it.'),
    amount: moneyAmount(
      'Amount paid, at most the option’s applicable_amount; less records a partial or advance payment. Not for loyalty_program or membership, which compute their own.'
    ).optional(),
    account_id: optionalId(
      'method account: the account or cash register that receives the money.'
    ),
    client_account_id: optionalId('method client_account.'),
    loyalty_card_id: optionalId('method loyalty_card or loyalty_program.'),
    loyalty_program_id: optionalId('method loyalty_program.'),
    gift_card_id: optionalId('method gift_card.'),
    membership_id: optionalId('method membership.'),
    advance_payment_hold_id: optionalId(
      'method advance_payment_hold; pays its full applicable_amount.'
    ),
    number: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe(
        'Gift card or membership number, when payment_options says number_required.'
      ),
    expected_amount_due: z
      .number()
      .min(0)
      .describe(
        'amount_due from the visits_get read this payment is based on.'
      ),
  }),
  confirm: {
    action: 'Record a payment',
    target: (input) =>
      `appointment ${input.appointment_id} at location ${input.location_id}`,
    resolve: (input, client) => finance.describeBill(client, input),
    consequence: (input) =>
      `Records ${finance.paymentSummary(input)} against the visit: the amount due drops by it and the location's finances and reports include it. No card is charged — this records money already received. It can be undone with visits_cancel_payment.`,
  },
  outputSchema: billSchema,
  handler: async ({ input, client }) => finance.addPayment(client, input),
});

export const visitsCancelPaymentTool = defineTool({
  name: 'visits_cancel_payment',
  category: 'Visits',
  description:
    'Cancel one payment recorded on an appointment’s bill, by its payment id from visits_get (t… or l…). The amount becomes due again; a client account or loyalty payment goes back to its balance. This reverses the record in Altegio only — it is not a refund through a card terminal or online acquiring. Asks for confirmation first.',
  annotations: {
    title: 'Visits: cancel a payment',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    appointment_id: appointmentId,
    payment_id: z
      .string()
      .regex(/^[tl]\d+$/, 'Use a payment id from visits_get, e.g. t588834559.')
      .describe('Payment id from visits_get.'),
  }),
  confirm: {
    action: 'Cancel a payment',
    target: (input) =>
      `payment ${input.payment_id} on appointment ${input.appointment_id}`,
    resolve: (input, client) => finance.describePayment(client, input),
    consequence:
      'The payment is removed from the visit’s bill and from the location’s finances, and its amount becomes due again. Money taken by card or online acquiring is not returned to the client by this — refund it in the terminal or acquiring service. A payment applied from an advance payment hold cannot be cancelled.',
  },
  outputSchema: billSchema,
  handler: async ({ input, client }) => finance.cancelPayment(client, input),
});
