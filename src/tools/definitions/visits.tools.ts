/**
 * `[Visits]` tool pack — an appointment's visit, the products sold on it (and
 * taken off again) and the payments recorded on it.
 *
 * The visit is what the client pays: its visit items (services from the
 * appointment, products sold with it), the payments already recorded, the
 * amount due, and the payment methods that can pay it now. The visit itself is
 * the billing object; what is printed for it is its printed receipt. A payment
 * records money received — cash or non-cash into one of the accounts and cash
 * registers, or from a client account, loyalty card, loyalty program, gift
 * card, membership or advance payment hold. An advance payment is a payment
 * recorded before the visit, for part of the amount due.
 *
 * Names, parameters and results use the product glossary; the wire vocabulary
 * (`document`, `sale`, `deposit`, `loyalty_certificate`, `loyalty_abonement`,
 * `prepay_hold`, `record`, `good`, `storage`, `attendance_good_items`) stops in
 * `src/api/v1/finance-adapter.ts` and `src/api/v2/visit-products-adapter.ts`.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import * as finance from '../../capabilities/finance/use-cases.js';
import * as visitProducts from '../../capabilities/finance/visit-products.js';

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

const itemSchema = {
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
    visit_item_id: int,
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

const visitSchema = {
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
    items: { type: 'array' as const, items: itemSchema },
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
    'items',
    'payments',
    'payment_options',
  ],
};

export const visitsGetTool = defineTool({
  name: 'visits_get',
  category: 'Visits',
  description:
    'The visit an appointment belongs to: its visit items (services and products) with amounts, payments recorded, total amount, amount paid and amount due, and the payment methods that can pay it now (accounts and cash registers, client account, loyalty card or program, gift card, membership, advance payment hold) with what each accepts. Read it before visits_add_payment or visits_cancel_payment.',
  annotations: { title: 'Visits: read a visit', ...READ_ONLY },
  input: z.object({ location_id: locationId, appointment_id: appointmentId }),
  outputSchema: visitSchema,
  handler: async ({ input, client }) => finance.getVisit(client, input),
});

const optionalId = (what: string) =>
  z.number().int().positive().optional().describe(what);

export const visitsAddPaymentTool = defineTool({
  name: 'visits_add_payment',
  category: 'Visits',
  description:
    'Record a payment or an advance payment on an appointment’s visit: money received into an account or cash register (method account + account_id), or paid from a client account, loyalty card, loyalty program, gift card, membership or advance payment hold — method and its id from payment_options in visits_get. Pass amount_due from visits_get as expected_amount_due; the call is refused if the visit changed. Records money received; charges no card. Asks for confirmation first.',
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
    resolve: (input, client) => finance.describeVisit(client, input),
    consequence: (input) =>
      `Records ${finance.paymentSummary(input)} against the visit: the amount due drops by it and the location's finances and reports include it. No card is charged — this records money already received. It can be undone with visits_cancel_payment.`,
  },
  outputSchema: visitSchema,
  handler: async ({ input, client, confirmation }) =>
    finance.addPayment(client, input, confirmation),
});

export const visitsCancelPaymentTool = defineTool({
  name: 'visits_cancel_payment',
  category: 'Visits',
  description:
    'Cancel one payment recorded on an appointment’s visit, by its payment id from visits_get (t… or l…). The amount becomes due again; a client account or loyalty payment goes back to its balance. This reverses the record in Altegio only — it is not a refund through a card terminal or online acquiring. Asks for confirmation first.',
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
      'The payment is removed from the visit and from the location’s finances, and its amount becomes due again. Money taken by card or online acquiring is not returned to the client by this — refund it in the terminal or acquiring service. A payment applied from an advance payment hold cannot be cancelled.',
  },
  outputSchema: visitSchema,
  handler: async ({ input, client, confirmation }) =>
    finance.cancelPayment(client, input, confirmation),
});

const productItemSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'integer' as const },
    product_id: { type: 'integer' as const },
    quantity: { type: 'number' as const },
    unit_kind: { type: 'string' as const, enum: ['sale', 'consumable'] },
    inventory_id: { type: 'integer' as const },
    team_member_id: { type: 'integer' as const },
    unit_price: { type: 'number' as const },
    discount_percent: { type: 'number' as const },
    amount: { type: 'number' as const },
    amount_after_loyalty: num,
    marks: { type: 'array' as const, items: { type: 'string' as const } },
  },
  required: ['id', 'product_id', 'quantity', 'amount'],
};

const ATTENDANCE = ['waiting', 'confirmed', 'arrived', 'no_show', 'unknown'];

const quantity = z
  .number()
  .positive()
  .max(1_000_000)
  .refine(
    (v) => v >= 0.001 && Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6,
    {
      message: 'Use at least 0.001 and at most three decimals.',
    }
  );

const visitAmountsSchema = {
  anyOf: [
    {
      type: 'object' as const,
      properties: {
        total_amount: { type: 'number' as const },
        paid_amount: { type: 'number' as const },
        amount_due: { type: 'number' as const },
      },
      required: ['total_amount', 'paid_amount', 'amount_due'],
    },
    { type: 'null' as const },
  ],
};

export const visitsAddProductTool = defineTool({
  name: 'visits_add_product',
  category: 'Visits',
  description:
    'Sell a product on an appointment’s visit, as the appointment window in Altegio does: a product already on the appointment gets its quantity raised, otherwise a visit item is added at the product’s sale price in its sale unit, sold by the appointment’s team member, with the client’s personal discount, from the inventory Altegio would pick (override with inventory_id, team_member_id, discount_percent). Stock is written off at once; loyalty programs may take more off the item, and the result shows the item and the visit’s amounts as saved. The appointment must be arrived or confirmed — for a waiting one pass mark_arrived: true once the client is there. Pass the quantity of this product already on the visit (visits_get; 0 if none) as expected_current_quantity; the call is refused if it differs. Refused for group event appointments, a printed receipt, gift cards and memberships, and a visit whose other appointments sell products. Altegio saves the whole appointment again from a fresh read and the call is refused if it changed meanwhile; a change made in the same instant can still be overwritten. visits_remove_product undoes a sale. Asks for confirmation first.',
  annotations: {
    title: 'Visits: sell a product',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    appointment_id: appointmentId,
    product_id: z
      .number()
      .int()
      .positive()
      .describe('Product id, from products_search.'),
    quantity: quantity.describe(
      'How much to sell, in the product’s sale unit.'
    ),
    expected_current_quantity: z
      .number()
      .min(0)
      .describe(
        'Quantity of this product already on the visit, from visits_get (0 if none).'
      ),
    inventory_id: optionalId(
      'Inventory to take it from (inventory_list). Default: as Altegio picks.'
    ),
    team_member_id: optionalId(
      'Team member credited with the sale. Default: the appointment’s.'
    ),
    discount_percent: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(
        'Item discount in percent. Default: the client’s personal discount.'
      ),
    marks: z
      .array(z.string().min(1).max(256))
      .max(100)
      .optional()
      .describe('Product marking codes, where marked products are enforced.'),
    mark_arrived: z
      .boolean()
      .default(false)
      .describe(
        'Mark a waiting appointment arrived with the sale (only when the client is there).'
      ),
  }),
  confirm: {
    action: 'Sell a product on a visit',
    target: (input) =>
      `product ${input.product_id} ×${input.quantity} on appointment ${input.appointment_id} at location ${input.location_id}`,
    consequence: (input) =>
      `Altegio saves the appointment again exactly as it reads now, with the product’s visit item added or its quantity raised. The product is written off the inventory at once, and the visit’s amount due grows by the item total after loyalty programs. Integrations receive an appointment update; the client gets no message.${input.mark_arrived ? ' If the appointment is waiting, it is marked arrived.' : ''} Where the client’s personal discount follows what the client spends, a large sale can raise it for good: those levels only rise. visits_remove_product can take the item off again, but does not lower that discount.`,
    detail: (input, client) => visitProducts.describeSale(client, input),
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      appointment_id: { type: 'integer' as const },
      visit_id: int,
      currency: str,
      added_item: { type: 'boolean' as const },
      previous_quantity: { type: 'number' as const },
      item: { anyOf: [productItemSchema, { type: 'null' as const }] },
      attendance_before: { type: 'string' as const, enum: ATTENDANCE },
      attendance: { type: 'string' as const, enum: ATTENDANCE },
      visit_amounts: visitAmountsSchema,
      product_items: { type: 'array' as const, items: productItemSchema },
      unexpected_changes: {
        type: 'array' as const,
        items: { type: 'string' as const },
      },
    },
    required: [
      'location_id',
      'appointment_id',
      'currency',
      'item',
      'visit_amounts',
      'product_items',
      'unexpected_changes',
    ],
  },
  handler: async ({ input, client, confirmation }) =>
    visitProducts.addProduct(client, input, confirmation),
});

export const visitsRemoveProductTool = defineTool({
  name: 'visits_remove_product',
  category: 'Visits',
  description:
    'Take a product off an appointment’s visit, or lower its quantity — the undo of visits_add_product. The product returns to the item’s inventory at once and the visit’s amount due falls by the item total after loyalty programs; payments already recorded are not changed. Pass visit_item_id (visits_get or the visits_add_product result) and the item’s current quantity as expected_current_quantity; the call is refused if it differs, so a repeated call cannot take off twice. Omit quantity to take off the whole item. Items sold in the sale unit only; an item with product marking codes is taken off whole. The appointment must be arrived or confirmed. Refused for group event appointments, a printed receipt, gift cards and memberships, and a visit whose other appointments sell products. Altegio saves the whole appointment again from a fresh read and the call is refused if it changed meanwhile; a change made in the same instant can still be overwritten. Asks for confirmation first.',
  annotations: {
    title: 'Visits: take a product off',
    destructiveHint: true,
    // A repeat with the same expected_current_quantity is refused, so it
    // takes nothing further off.
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    appointment_id: appointmentId,
    visit_item_id: z
      .number()
      .int()
      .positive()
      .describe(
        'The product’s visit item id, from visits_get or the visits_add_product result.'
      ),
    quantity: quantity
      .optional()
      .describe(
        'How much to take off, in the product’s sale unit. Default: the whole item.'
      ),
    expected_current_quantity: z
      .number()
      .positive()
      .describe('Quantity the item holds now, from visits_get.'),
  }),
  confirm: {
    action: 'Take a product off a visit',
    target: (input) =>
      `${input.quantity === undefined ? 'the whole of' : `×${input.quantity} of`} visit item ${input.visit_item_id} on appointment ${input.appointment_id} at location ${input.location_id}`,
    consequence: () =>
      'Altegio saves the appointment again exactly as it reads now, with the product’s visit item taken off or its quantity lowered. The product returns to the inventory at once and the visit’s amount due falls by the item total after loyalty programs; payments already recorded are not changed, so a fully paid visit becomes overpaid. A personal discount the sale raised stays raised. Integrations receive an appointment update; the client gets no message.',
    detail: (input, client) => visitProducts.describeRemoval(client, input),
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      appointment_id: { type: 'integer' as const },
      visit_id: int,
      currency: str,
      removed_item: { type: 'boolean' as const },
      removed_quantity: { type: 'number' as const },
      item_before: productItemSchema,
      item: { anyOf: [productItemSchema, { type: 'null' as const }] },
      stock: {
        type: 'object' as const,
        properties: {
          inventory_id: { type: 'integer' as const },
          before: num,
          after: num,
        },
        required: ['inventory_id', 'before', 'after'],
      },
      visit_amounts: visitAmountsSchema,
      product_items: { type: 'array' as const, items: productItemSchema },
      unexpected_changes: {
        type: 'array' as const,
        items: { type: 'string' as const },
      },
    },
    required: [
      'location_id',
      'appointment_id',
      'currency',
      'item_before',
      'item',
      'stock',
      'visit_amounts',
      'product_items',
      'unexpected_changes',
    ],
  },
  handler: async ({ input, client, confirmation }) =>
    visitProducts.removeProduct(client, input, confirmation),
});
