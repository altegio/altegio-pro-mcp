/**
 * Selling a product on a visit — what `visits_add_product` does — and taking
 * it off again — what `visits_remove_product` does.
 *
 * It follows the web app's appointment window: a product already on the
 * appointment gets its quantity raised instead of a second line; a new line
 * takes the product's sale price, its sale unit, the appointment's team member
 * as the seller, the client's personal discount, and the inventory the web app
 * would pick (the highest-ranked inventory for sale that holds the product,
 * else the highest-ranked one that does). Products are sold only on an
 * appointment marked arrived or confirmed; the web app marks a waiting one
 * arrived on its own, this tool only when the caller asks.
 *
 * The plan is computed twice from fresh reads: once for the confirmation
 * detail, so a person sees the line, the stock and any status change before
 * agreeing, and again when the call runs. The caller states how much of the
 * product the visit already holds (`expected_current_quantity`), so a repeated
 * confirmed call cannot sell twice, and the adapter refuses to save over any
 * change made since the plan's read. Calls that cannot be saved back exactly
 * are refused before anyone is asked.
 *
 * Removal is the undo of a sale: it drops one product line, or lowers its
 * quantity, and the product returns to the line's inventory. It takes the
 * same guards — the caller states the line's quantity as read
 * (`expected_current_quantity`), so a repeated confirmed call cannot take off
 * twice — and the confirmation shows the line before and after and the stock
 * that comes back.
 *
 * Both writes hand the port the confirmed call's idempotency key
 * (`../../api/write-options.ts`).
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { InventoryAdapter } from '../../api/v1/inventory-adapter.js';
import { resolveLocationCurrency } from '../../api/v1/location-currency.js';
import type {
  AppointmentSale,
  ProductForSale,
  ProductLineWrite,
  Visit,
  VisitProductLine,
  VisitsApi,
} from '../../api/visits-api.js';
import { knownInventory } from '../inventory/shared.js';
import type {
  ConfirmationDetail,
  ConfirmedCall,
} from '../../tools/confirmation.js';
import { planConfirmed, planForConfirmation } from '../guarded-change.js';
import { writeOptions } from '../../api/write-options.js';
import { lineTotal, majorOf, moneyOf, roundMajor } from '../../api/money.js';
import { withUntrustedBlock } from '../../tools/tool-result.js';
import { FinanceInputError } from './errors.js';
import { visitsApi } from './ports.js';

export interface VisitProductsResult {
  text: string;
  structuredContent: unknown;
  isError?: boolean;
}

export interface AddProductInput {
  location_id: number;
  appointment_id: number;
  product_id: number;
  /** In the product's sale unit. */
  quantity: number;
  /** How much of the product the appointment already sells, as the caller read it. */
  expected_current_quantity: number;
  inventory_id?: number;
  team_member_id?: number;
  discount_percent?: number;
  marks?: string[];
  mark_arrived?: boolean;
}

const FIELD_MAX_CHARS = 200;

const round2 = (value: number): number => roundMajor(value);

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

function money(value: number | null, currency: string | null): string {
  if (value === null) return 'not reported';
  return `${round2(value)} ${currency ?? '(currency not reported)'}`;
}

/**
 * The web app's line total: quantity × price less the line's discount, in
 * minor units (`../../api/money.ts`).
 */
export function lineAmount(
  unitPrice: number,
  quantity: number,
  discountPercent: number
): number {
  return majorOf(
    lineTotal(quantity, moneyOf(unitPrice, null), discountPercent)
  );
}

async function currencyOf(
  client: AltegioClient,
  locationId: number
): Promise<string | null> {
  try {
    return await resolveLocationCurrency(client, locationId);
  } catch {
    return null;
  }
}

/** The sale-unit lines of this product on the appointment. */
function linesOf(sale: AppointmentSale, productId: number): VisitProductLine[] {
  return sale.product_lines.filter(
    (l) => l.product_id === productId && l.unit_kind === 'sale'
  );
}

/** Where the web app takes a product from when nobody says. */
export function defaultSaleInventory(
  product: ProductForSale
): { inventory_id: number; for_sale: boolean } | null {
  const rank = (rows: ProductForSale['stock']) =>
    [...rows].sort(
      (a, b) =>
        (b.sort_weight ?? Number.NEGATIVE_INFINITY) -
        (a.sort_weight ?? Number.NEGATIVE_INFINITY)
    )[0];
  const pick =
    rank(product.stock.filter((s) => s.for_sale)) ?? rank(product.stock);
  return pick
    ? { inventory_id: pick.inventory_id, for_sale: pick.for_sale }
    : null;
}

/** Everything one sale writes, computed from fresh reads. */
export interface SalePlan {
  sale: AppointmentSale;
  product: ProductForSale;
  line: ProductLineWrite;
  /** The line whose quantity is raised, or null for a new line. */
  existing: VisitProductLine | null;
  /** Stock of the product in the line's inventory before the sale. */
  stock_before: number | null;
  /** Where the line's discount came from. */
  discount_source: 'argument' | 'client' | 'line' | 'none';
  /** The default inventory was chosen, and it is not one for sale. */
  inventory_not_for_sale: boolean;
  /** The sale marks a waiting appointment arrived. */
  marks_arrived: boolean;
  /** `version` of the appointment as read: what the confirmation binds. */
  version: string;
}

function refuse(message: string): never {
  throw new FinanceInputError(`Nothing was sold: ${message}`);
}

/** Read the appointment and the product and decide the line, or refuse. */
export async function planSale(
  client: AltegioClient,
  api: VisitsApi,
  input: AddProductInput
): Promise<SalePlan> {
  const [sale, product] = await Promise.all([
    api.getAppointmentSale(input.location_id, input.appointment_id),
    api.getProductForSale(input.location_id, input.product_id),
  ]);
  const appt = `appointment ${input.appointment_id}`;

  if (sale.group_event && sale.service_lines.length !== 1) {
    refuse(
      `${appt} is a client's place in a group event and holds ${sale.service_lines.length} service lines; Altegio saves a group event appointment only with exactly one. Add the product in Altegio.`
    );
  }
  if (sale.unsupported) {
    refuse(
      `${appt} cannot be saved back exactly — ${sale.unsupported}. Add the product in Altegio.`
    );
  }
  if (sale.receipt_printed) {
    refuse(
      `${appt}'s visit has a printed receipt (or a fiscal receipt is being prepared), and Altegio refuses product changes after that.`
    );
  }
  const crowded = loyaltyPricedOthers(sale);
  if (crowded.length > 0) {
    refuse(
      `other appointments of the same visit (${crowded.join(', ')}) sell products at a loyalty discount. Saving this appointment would make Altegio rewrite those visit items from their discounted amounts, applying the discount twice; add the product in Altegio.`
    );
  }
  if (sale.attendance === 'waiting' && !input.mark_arrived) {
    refuse(
      `${appt} is waiting; Altegio sells products only on an appointment marked arrived or confirmed. Ask whether the client has arrived; if so, repeat with mark_arrived: true.`
    );
  }
  if (
    sale.attendance !== 'waiting' &&
    sale.attendance !== 'arrived' &&
    sale.attendance !== 'confirmed'
  ) {
    refuse(
      `${appt} is ${sale.attendance === 'no_show' ? 'marked no-show' : 'in a status this server does not know'}; Altegio sells products only on an appointment marked arrived or confirmed. Change its status in Altegio first.`
    );
  }
  if (product.loyalty_kind) {
    refuse(
      `product ${product.id} sells a ${product.loyalty_kind === 'gift_card' ? 'gift card' : 'membership'}; this tool sells regular products only. Sell it in Altegio, which asks for its number and activation date.`
    );
  }
  if (product.sale_price === null || product.sale_unit_id === null) {
    refuse(
      `product ${product.id} has no sale price or sale unit; set them with products_update first.`
    );
  }

  const existingLines = linesOf(sale, product.id);
  const current = round3(existingLines.reduce((sum, l) => sum + l.quantity, 0));
  if (round3(input.expected_current_quantity) !== current) {
    refuse(
      `${appt} sells ${current} of product ${product.id} now, not the ${round3(input.expected_current_quantity)} this sale was based on — the visit changed, or this sale was already recorded. Read the visit again with visits_get.`
    );
  }

  const marks = input.marks ?? [];
  const existing = existingLines[0] ?? null;
  let line: ProductLineWrite;
  let discountSource: SalePlan['discount_source'];
  let inventoryNotForSale = false;
  if (existing) {
    const conflicts = [
      input.inventory_id !== undefined &&
        input.inventory_id !== existing.inventory_id &&
        `inventory ${existing.inventory_id}`,
      input.team_member_id !== undefined &&
        input.team_member_id !== existing.team_member_id &&
        `team member ${existing.team_member_id}`,
      input.discount_percent !== undefined &&
        round2(input.discount_percent) !== round2(existing.discount_percent) &&
        `discount ${existing.discount_percent}%`,
    ].filter((c): c is string => typeof c === 'string');
    if (conflicts.length > 0) {
      refuse(
        `product ${product.id} is already on ${appt} as visit item ${existing.id} (${conflicts.join(', ')}); like the web app, this tool raises that item's quantity instead of adding a second item. Omit inventory_id, team_member_id and discount_percent to raise it, or change the item in Altegio.`
      );
    }
    const quantity = round3(existing.quantity + input.quantity);
    line = {
      line_id: existing.id,
      product_id: product.id,
      quantity,
      unit_id: existing.unit_id,
      inventory_id: existing.inventory_id,
      team_member_id: existing.team_member_id,
      unit_price: existing.unit_price,
      discount_percent: existing.discount_percent,
      amount: lineAmount(
        existing.unit_price,
        quantity,
        existing.discount_percent
      ),
      marks: [...existing.marks, ...marks],
    };
    discountSource = 'line';
  } else {
    let inventoryId = input.inventory_id;
    if (inventoryId !== undefined) {
      const inventories = await InventoryAdapter.forClient(
        client
      ).listInventories(input.location_id);
      try {
        knownInventory(inventories, inventoryId, input.location_id);
      } catch (error) {
        refuse((error as Error).message);
      }
    } else {
      const picked = defaultSaleInventory(product);
      if (!picked) {
        refuse(
          `product ${product.id} has no stock record in any inventory, so there is no inventory to take it from by default. Pass inventory_id (inventory_list).`
        );
      }
      inventoryId = picked.inventory_id;
      inventoryNotForSale = !picked.for_sale;
    }
    const discount =
      input.discount_percent ?? sale.client_discount_percent ?? 0;
    discountSource =
      input.discount_percent !== undefined
        ? 'argument'
        : (sale.client_discount_percent ?? 0) > 0
          ? 'client'
          : 'none';
    line = {
      line_id: null,
      product_id: product.id,
      quantity: round3(input.quantity),
      unit_id: product.sale_unit_id,
      inventory_id: inventoryId,
      team_member_id: input.team_member_id ?? sale.team_member_id,
      unit_price: product.sale_price,
      discount_percent: round2(discount),
      amount: lineAmount(product.sale_price, input.quantity, discount),
      marks,
    };
  }

  return {
    sale,
    version: sale.version,
    product,
    line,
    existing,
    stock_before:
      product.stock.find((s) => s.inventory_id === line.inventory_id)
        ?.sale_quantity ?? null,
    discount_source: discountSource,
    inventory_not_for_sale: inventoryNotForSale,
    marks_arrived: sale.attendance === 'waiting',
  };
}

// ========== rendering ==========

const STATUS_TEXT: Record<AppointmentSale['attendance'], string> = {
  waiting: 'waiting',
  confirmed: 'confirmed',
  arrived: 'arrived',
  no_show: 'no-show',
  unknown: 'in an unknown status',
};

const ARRIVED_EFFECTS =
  'Marking it arrived runs the loyalty auto-programs (cashback and the like), writes off the consumables of its services and reschedules the client’s repeat-visit reminder.';

const CUSTOM_FIELDS_UNREAD =
  'Its custom field values could not be read (the user lacks the right to view appointment custom fields), so the save cannot send them back; where the location requires custom fields once the client has arrived, Altegio refuses the save and nothing changes.';

/** Other appointments of the visit whose product lines carry a loyalty discount. */
function loyaltyPricedOthers(sale: AppointmentSale): number[] {
  return sale.other_appointments
    .filter((o) => o.loyalty_priced_lines > 0)
    .map((o) => o.appointment_id);
}

/**
 * What else the save sends back and keeps: the group event booking, the gift
 * card and membership items, and the other appointments' product items.
 */
function echoNotes(sale: AppointmentSale, changedLineId: number | null) {
  const notes: string[] = [];
  if (sale.group_event) {
    notes.push(
      `Appointment ${sale.appointment_id} is one client's place in a group event: only this appointment is saved, with its service and seats as they are; the event and its other clients do not change.`
    );
  }
  const loyalty = sale.product_lines.filter(
    (l) => l.loyalty_kind !== null && l.id !== changedLineId
  );
  if (loyalty.length > 0) {
    notes.push(
      `Gift card and membership visit items ${loyalty.map((l) => l.id).join(', ')} are sent back with their numbers and activation dates, unchanged.`
    );
  }
  const others = sale.other_appointments
    .filter((o) => o.product_lines > 0)
    .map((o) => o.appointment_id);
  if (others.length > 0) {
    notes.push(
      `Altegio also saves the product items of appointment${others.length === 1 ? '' : 's'} ${others.join(', ')} of the same visit again from their stored amounts; none carries a loyalty discount, so they keep their values.`
    );
  }
  return notes;
}

function appointmentHeader(sale: AppointmentSale): string {
  return `Appointment ${sale.appointment_id}${sale.visit_id ? ` (visit ${sale.visit_id}` : ' ('}${sale.client_id ? `, client ${sale.client_id})` : sale.visit_id ? ')' : 'no client)'} with team member ${sale.team_member_id}, ${STATUS_TEXT[sale.attendance]}, starts ${sale.start_local.replace('T', ' ')} at the location.`;
}

function planLines(plan: SalePlan, currency: string | null): string[] {
  const { sale, line, existing } = plan;
  const p = `product ${line.product_id}`;
  const lines = [
    appointmentHeader(sale),
    existing
      ? `Raises visit item ${existing.id} of ${p} from ${existing.quantity} to ${line.quantity} (${money(line.unit_price, currency)} each, discount ${line.discount_percent}%): item total ${money(existing.amount, currency)} → ${money(line.amount, currency)} before loyalty programs.`
      : `Adds ${p} ×${line.quantity} from inventory ${line.inventory_id}, sold by team member ${line.team_member_id}: ${money(line.unit_price, currency)} each, discount ${line.discount_percent}% → item total ${money(line.amount, currency)} before loyalty programs.`,
  ];
  if (plan.discount_source === 'client') {
    lines.push(
      `The discount is the client’s personal discount, as the web app applies it; pass discount_percent to set another.`
    );
  }
  if (plan.inventory_not_for_sale) {
    lines.push(
      `No inventory for sale holds ${p}, so it is taken from inventory ${line.inventory_id}, as the web app would; pass inventory_id to choose another.`
    );
  }
  const added = existing ? line.quantity - existing.quantity : line.quantity;
  if (plan.stock_before !== null) {
    const after = round3(plan.stock_before - added);
    lines.push(
      `Stock of ${p} in inventory ${line.inventory_id}: ${round3(plan.stock_before)} → ${after}${after < 0 ? ' (negative: Altegio refuses this where the location forbids negative stock)' : ''}.`
    );
  } else {
    lines.push(
      `Inventory ${line.inventory_id} has no stock record of ${p}; the sale takes it to −${round3(added)} (Altegio refuses this where the location forbids negative stock).`
    );
  }
  if (line.marks.length > (existing?.marks.length ?? 0)) {
    lines.push(
      `Product marking codes added: ${line.marks.length - (existing?.marks.length ?? 0)}.`
    );
  }
  if (plan.marks_arrived) {
    lines.push(`Status: waiting → arrived. ${ARRIVED_EFFECTS}`);
  }
  if (
    !sale.custom_fields_readable &&
    (sale.attendance === 'arrived' || plan.marks_arrived)
  ) {
    lines.push(CUSTOM_FIELDS_UNREAD);
  }
  lines.push(...echoNotes(sale, existing?.id ?? null));
  return lines;
}

/** The confirmation detail: the visit item, the stock and any status change. */
export async function describeSale(
  client: AltegioClient,
  input: AddProductInput
): Promise<ConfirmationDetail> {
  const plan = await planForConfirmation(
    () => planSale(client, visitsApi(client), input),
    FinanceInputError
  );
  const currency = await currencyOf(client, input.location_id);
  return { text: planLines(plan, currency).join('\n'), version: plan.version };
}

function lineText(l: VisitProductLine, currency: string | null): string {
  return `visit item ${l.id}: product ${l.product_id} ×${l.quantity}${l.unit_kind === 'consumable' ? ' (consumable unit)' : ''} from inventory ${l.inventory_id}, team member ${l.team_member_id}, ${money(l.unit_price, currency)} each, discount ${l.discount_percent}%, total ${money(l.amount, currency)}${l.amount_after_loyalty !== null && round2(l.amount_after_loyalty) !== round2(l.amount) ? `, ${money(l.amount_after_loyalty, currency)} after loyalty programs` : ''}`;
}

function lineStructured(l: VisitProductLine) {
  return {
    id: l.id,
    product_id: l.product_id,
    quantity: l.quantity,
    unit_kind: l.unit_kind,
    inventory_id: l.inventory_id,
    team_member_id: l.team_member_id,
    unit_price: l.unit_price,
    discount_percent: l.discount_percent,
    amount: l.amount,
    amount_after_loyalty: l.amount_after_loyalty,
    marks: l.marks,
  };
}

export async function addProduct(
  client: AltegioClient,
  input: AddProductInput,
  confirmation?: ConfirmedCall
): Promise<VisitProductsResult> {
  const api = visitsApi(client);
  const plan = await planConfirmed(
    () => planSale(client, api, input),
    confirmation,
    () =>
      new FinanceInputError(
        `Nothing was sold: appointment ${input.appointment_id} changed after the confirmation was shown, so this call would no longer make the sale approved. Read the visit again with visits_get, then repeat the call without confirmation_token to confirm against what it holds now.`
      )
  );
  const currency = await currencyOf(client, input.location_id);

  const { appointment: after, unexpected_changes: unexpected } =
    await api.addProductLine(
      input.location_id,
      input.appointment_id,
      {
        line: plan.line,
        mark_arrived: plan.marks_arrived,
        expected_version: plan.sale.version,
      },
      writeOptions(confirmation)
    );

  const saved =
    plan.line.line_id !== null
      ? after.product_lines.find((l) => l.id === plan.line.line_id)
      : after.product_lines.find(
          (l) =>
            l.product_id === plan.line.product_id &&
            !plan.sale.product_lines.some((b) => b.id === l.id)
        );
  const visit = await visitAfter(api, input.location_id, input.appointment_id);

  const p = `product ${plan.line.product_id}`;
  const adjusted =
    saved &&
    (round3(saved.quantity) !== round3(plan.line.quantity) ||
      round2(saved.discount_percent) !== round2(plan.line.discount_percent) ||
      round2(saved.amount) !== round2(plan.line.amount));
  const head = !saved
    ? `The save went through, but no visit item of ${p} reads back on appointment ${input.appointment_id}. Read the visit with visits_get before trying again; the user may lack the right to sell products in appointments.`
    : plan.existing
      ? `Raised visit item ${saved.id} of ${p} on appointment ${input.appointment_id} from ${plan.existing.quantity} to ${saved.quantity}.`
      : `Added ${p} ×${saved.quantity} to appointment ${input.appointment_id} as visit item ${saved.id}.`;
  const text = [
    head,
    ...(unexpected.length > 0
      ? [
          `Warning — the save also changed the appointment: ${unexpected.join('; ')}. Check appointment ${input.appointment_id} in Altegio and correct it there.`,
        ]
      : []),
    ...(saved ? [`Now: ${lineText(saved, currency)}.`] : []),
    ...(adjusted
      ? [
          `Altegio adjusted the visit item after the save (asked: ×${plan.line.quantity}, discount ${plan.line.discount_percent}%, total ${money(plan.line.amount, currency)}); the item above is what it holds.`,
        ]
      : []),
    ...(plan.marks_arrived
      ? [
          `Appointment ${input.appointment_id} is now ${STATUS_TEXT[after.attendance]}.`,
        ]
      : []),
    visit
      ? `Visit: total amount ${money(visit.total_amount, currency)}, paid ${money(visit.paid_amount, currency)}, amount due ${money(visit.amount_due, currency)}.`
      : 'The visit could not be read back; read it with visits_get.',
    'The product is written off the inventory at once. Record the payment with visits_add_payment. To undo the sale, visits_remove_product takes the visit item off or lowers its quantity; it does not lower a personal discount the sale raised.',
    ...(currency ? [] : ['Currency: not reported for this location.']),
  ].join('\n');

  return {
    text: withUntrustedBlock(
      text,
      [{ label: `${p} title`, value: plan.product.title }],
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: {
      location_id: input.location_id,
      appointment_id: input.appointment_id,
      visit_id: after.visit_id,
      currency,
      added_item: plan.existing === null,
      previous_quantity: plan.existing?.quantity ?? 0,
      item: saved ? lineStructured(saved) : null,
      attendance_before: plan.sale.attendance,
      attendance: after.attendance,
      visit_amounts: visit
        ? {
            total_amount: visit.total_amount,
            paid_amount: visit.paid_amount,
            amount_due: visit.amount_due,
          }
        : null,
      product_items: after.product_lines.map(lineStructured),
      unexpected_changes: unexpected,
    },
    ...(!saved || unexpected.length > 0 ? { isError: true } : {}),
  };
}

// ========== removing a product line ==========

export interface RemoveProductInput {
  location_id: number;
  appointment_id: number;
  /** The product's visit item, from visits_get or visits_add_product. */
  visit_item_id: number;
  /** How much to take off, in the line's unit; omitted takes the whole line. */
  quantity?: number;
  /** The line's quantity as the caller read it. */
  expected_current_quantity: number;
}

/** Everything one removal writes, computed from fresh reads. */
export interface RemovalPlan {
  sale: AppointmentSale;
  /** The line as it stands. */
  line: VisitProductLine;
  /** The quantity the line keeps; 0 drops it. */
  quantity: number;
  /** The line total it keeps, before loyalty programs. */
  amount: number;
  /** How much returns to the inventory. */
  removed: number;
  /** Null when the product could not be read (a deleted product). */
  product: ProductForSale | null;
  /** Stock of the product in the line's inventory before the removal. */
  stock_before: number | null;
  /** `version` of the appointment as read: what the confirmation binds. */
  version: string;
}

function refuseChange(message: string): never {
  throw new FinanceInputError(`Nothing was changed: ${message}`);
}

const CHANGE_IN_ALTEGIO = 'Make the change in Altegio.';

/** Read the appointment and decide what the line keeps, or refuse. */
export async function planRemoval(
  api: VisitsApi,
  input: RemoveProductInput
): Promise<RemovalPlan> {
  const sale = await api.getAppointmentSale(
    input.location_id,
    input.appointment_id
  );
  const appt = `appointment ${input.appointment_id}`;

  if (sale.group_event && sale.service_lines.length !== 1) {
    refuseChange(
      `${appt} is a client's place in a group event and holds ${sale.service_lines.length} service lines; Altegio saves a group event appointment only with exactly one. ${CHANGE_IN_ALTEGIO}`
    );
  }
  if (sale.unsupported) {
    refuseChange(
      `${appt} cannot be saved back exactly — ${sale.unsupported}. ${CHANGE_IN_ALTEGIO}`
    );
  }
  if (sale.receipt_printed) {
    refuseChange(
      `${appt}'s visit has a printed receipt (or a fiscal receipt is being prepared), and Altegio refuses product changes after that.`
    );
  }
  const crowded = loyaltyPricedOthers(sale);
  if (crowded.length > 0) {
    refuseChange(
      `other appointments of the same visit (${crowded.join(', ')}) sell products at a loyalty discount. Saving this appointment would make Altegio rewrite those visit items from their discounted amounts, applying the discount twice. ${CHANGE_IN_ALTEGIO}`
    );
  }
  if (sale.attendance !== 'arrived' && sale.attendance !== 'confirmed') {
    refuseChange(
      `${appt} is ${sale.attendance === 'no_show' ? 'marked no-show' : sale.attendance === 'waiting' ? 'waiting' : 'in a status this server does not know'}; Altegio changes products only on an appointment marked arrived or confirmed, and a save in another status can drop every product sold on the visit. ${CHANGE_IN_ALTEGIO}`
    );
  }

  const line = sale.product_lines.find((l) => l.id === input.visit_item_id);
  if (!line) {
    const ids = sale.product_lines.map((l) => l.id);
    refuseChange(
      `${appt} has no visit item ${input.visit_item_id} that sells a product (${ids.length > 0 ? `its product items: ${ids.join(', ')}` : 'it sells no products'}) — the item was taken off already, or the id is not a product item of this appointment. Read the visit with visits_get.`
    );
  }
  if (line.loyalty_kind) {
    refuseChange(
      `visit item ${line.id} issued a ${line.loyalty_kind === 'gift_card' ? 'gift card' : 'membership'}; remove it in Altegio, which handles the card it issued.`
    );
  }
  if (line.unit_kind !== 'sale') {
    refuseChange(
      `visit item ${line.id} is sold in the product's consumable unit; this tool changes items sold in the sale unit, as visits_add_product adds them. ${CHANGE_IN_ALTEGIO}`
    );
  }

  const current = round3(line.quantity);
  if (round3(input.expected_current_quantity) !== current) {
    refuseChange(
      `visit item ${line.id} holds ${current} of product ${line.product_id} now, not the ${round3(input.expected_current_quantity)} this change was based on — the visit changed, or this removal was already recorded. Read the visit again with visits_get.`
    );
  }
  const removed =
    input.quantity === undefined ? current : round3(input.quantity);
  if (removed > current) {
    refuseChange(
      `visit item ${line.id} holds ${current} of product ${line.product_id}, less than the ${removed} to take off. Omit quantity to take off the whole item.`
    );
  }
  const quantity = round3(current - removed);
  if (quantity > 0 && line.marks.length > 0) {
    refuseChange(
      `visit item ${line.id} carries product marking codes, and lowering its quantity would leave codes for units no longer sold. Take off the whole item (omit quantity) and sell the right quantity again with its codes, or change it in Altegio.`
    );
  }

  const product = await api
    .getProductForSale(input.location_id, line.product_id)
    .catch(() => null);
  return {
    sale,
    version: sale.version,
    line,
    quantity,
    amount:
      quantity > 0
        ? lineAmount(line.unit_price, quantity, line.discount_percent)
        : 0,
    removed,
    product,
    stock_before: stockIn(product, line.inventory_id),
  };
}

function stockIn(
  product: ProductForSale | null,
  inventoryId: number
): number | null {
  return (
    product?.stock.find((s) => s.inventory_id === inventoryId)?.sale_quantity ??
    null
  );
}

function removalLines(plan: RemovalPlan, currency: string | null): string[] {
  const { line } = plan;
  const p = `product ${line.product_id}`;
  const lines = [
    appointmentHeader(plan.sale),
    plan.quantity === 0
      ? `Takes off visit item ${line.id} of ${p} ×${line.quantity} (inventory ${line.inventory_id}, team member ${line.team_member_id}, ${money(line.unit_price, currency)} each, discount ${line.discount_percent}%): item total ${money(line.amount, currency)} before loyalty programs${line.amount_after_loyalty !== null && round2(line.amount_after_loyalty) !== round2(line.amount) ? `, ${money(line.amount_after_loyalty, currency)} after them,` : ''} comes off the amount due.`
      : `Lowers visit item ${line.id} of ${p} from ${line.quantity} to ${plan.quantity} (${money(line.unit_price, currency)} each, discount ${line.discount_percent}%): item total ${money(line.amount, currency)} → ${money(plan.amount, currency)} before loyalty programs.`,
    plan.stock_before !== null
      ? `Stock of ${p} in inventory ${line.inventory_id}: ${round3(plan.stock_before)} → ${round3(plan.stock_before + plan.removed)} (${plan.removed} returned).`
      : `Altegio returns ${plan.removed} of ${p} to inventory ${line.inventory_id}; its stock there could not be read.`,
  ];
  if (!plan.sale.custom_fields_readable && plan.sale.attendance === 'arrived') {
    lines.push(CUSTOM_FIELDS_UNREAD);
  }
  lines.push(...echoNotes(plan.sale, line.id));
  return lines;
}

/** The confirmation detail: the visit item before and after and the stock returned. */
export async function describeRemoval(
  client: AltegioClient,
  input: RemoveProductInput
): Promise<ConfirmationDetail> {
  const plan = await planForConfirmation(
    () => planRemoval(visitsApi(client), input),
    FinanceInputError
  );
  const currency = await currencyOf(client, input.location_id);
  return {
    text: removalLines(plan, currency).join('\n'),
    version: plan.version,
  };
}

async function visitAfter(
  api: VisitsApi,
  locationId: number,
  appointmentId: number
): Promise<Visit | null> {
  try {
    return await api.getVisit(locationId, appointmentId);
  } catch {
    return null;
  }
}

export async function removeProduct(
  client: AltegioClient,
  input: RemoveProductInput,
  confirmation?: ConfirmedCall
): Promise<VisitProductsResult> {
  const api = visitsApi(client);
  const plan = await planConfirmed(
    () => planRemoval(api, input),
    confirmation,
    () =>
      new FinanceInputError(
        `Nothing was changed: appointment ${input.appointment_id} changed after the confirmation was shown, so this call would no longer make the change approved. Read the visit again with visits_get, then repeat the call without confirmation_token to confirm against what it holds now.`
      )
  );
  const currency = await currencyOf(client, input.location_id);
  const { line } = plan;

  const { appointment: after, unexpected_changes: unexpected } =
    await api.reduceProductLine(
      input.location_id,
      input.appointment_id,
      {
        line_id: line.id,
        quantity: plan.quantity,
        amount: plan.amount,
        expected_version: plan.sale.version,
      },
      writeOptions(confirmation)
    );

  const now = after.product_lines.find((l) => l.id === line.id) ?? null;
  const applied =
    plan.quantity === 0
      ? now === null
      : now !== null && round3(now.quantity) === plan.quantity;
  const [stockAfter, visit] = await Promise.all([
    api
      .getProductForSale(input.location_id, line.product_id)
      .then((product) => stockIn(product, line.inventory_id))
      .catch(() => null),
    visitAfter(api, input.location_id, input.appointment_id),
  ]);

  const p = `product ${line.product_id}`;
  const appt = `appointment ${input.appointment_id}`;
  const head = applied
    ? plan.quantity === 0
      ? `Took visit item ${line.id} (${p} ×${line.quantity}) off ${appt}.`
      : `Lowered visit item ${line.id} of ${p} on ${appt} from ${line.quantity} to ${plan.quantity}.`
    : now === null
      ? `The save went through, but visit item ${line.id} of ${p} no longer reads back on ${appt}, instead of holding ×${plan.quantity}. Read the visit with visits_get before trying again.`
      : `The save went through, but visit item ${line.id} of ${p} still holds ×${now.quantity} on ${appt}, not the ×${plan.quantity} asked. Read the visit with visits_get before trying again; the user may lack the right to edit or delete product sales in appointments.`;
  let stockText: string;
  if (plan.stock_before !== null && stockAfter !== null) {
    const returned = round3(stockAfter - plan.stock_before);
    stockText = `Stock of ${p} in inventory ${line.inventory_id}: ${round3(plan.stock_before)} → ${round3(stockAfter)} (${returned} returned${applied && returned !== plan.removed ? `, not the ${plan.removed} expected — another stock movement may have happened meanwhile` : ''}).`;
  } else {
    stockText = `Stock of ${p} in inventory ${line.inventory_id} could not be read back${applied ? `; Altegio returns ${plan.removed} to it` : ''}.`;
  }
  const discount = after.client_discount_percent ?? 0;
  // The visit reports no negative amount due; overpaid is paid above the total.
  const overpaid = visit ? round2(visit.paid_amount - visit.total_amount) : 0;
  const text = [
    head,
    ...(unexpected.length > 0
      ? [
          `Warning — the save also changed the appointment: ${unexpected.join('; ')}. Check ${appt} in Altegio and correct it there.`,
        ]
      : []),
    `Before: ${lineText(line, currency)}.`,
    `Now: ${now ? lineText(now, currency) : 'taken off'}.`,
    stockText,
    visit
      ? `Visit: total amount ${money(visit.total_amount, currency)}, paid ${money(visit.paid_amount, currency)}, amount due ${money(visit.amount_due, currency)}.`
      : 'The visit could not be read back; read it with visits_get.',
    ...(overpaid > 0
      ? [
          `The visit is now overpaid by ${money(overpaid, currency)}; payments are not changed. Cancel a payment with visits_cancel_payment and record the right amount with visits_add_payment, or refund the difference in Altegio.`,
        ]
      : []),
    ...(discount > 0
      ? [
          `The client’s personal discount is ${discount}%. Where it follows what the client spends, a large sale can have raised it, and taking the sale off does not lower it: those levels only rise. If this sale raised it, a person resets it in the client card.`,
        ]
      : []),
    ...(currency ? [] : ['Currency: not reported for this location.']),
  ].join('\n');

  return {
    text: withUntrustedBlock(
      text,
      [{ label: `${p} title`, value: plan.product?.title ?? null }],
      { maxChars: FIELD_MAX_CHARS }
    ),
    structuredContent: {
      location_id: input.location_id,
      appointment_id: input.appointment_id,
      visit_id: after.visit_id,
      currency,
      removed_item: plan.quantity === 0,
      removed_quantity: plan.removed,
      item_before: lineStructured(line),
      item: now ? lineStructured(now) : null,
      stock: {
        inventory_id: line.inventory_id,
        before: plan.stock_before,
        after: stockAfter,
      },
      visit_amounts: visit
        ? {
            total_amount: visit.total_amount,
            paid_amount: visit.paid_amount,
            amount_due: visit.amount_due,
          }
        : null,
      product_items: after.product_lines.map(lineStructured),
      unexpected_changes: unexpected,
    },
    ...(!applied || unexpected.length > 0 ? { isError: true } : {}),
  };
}
