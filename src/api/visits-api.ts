/**
 * `VisitsApi` — the port behind the `visits_*` tools (ADR-001 D5): one
 * appointment's visit, the way the planned V3 Visit resource (`getVisit`,
 * `addVisitItem`, `createPayment`, `cancelPayment`) models it.
 *
 * A visit is what the client owes and has paid for an appointment: its items
 * (services, products, gift cards and memberships sold), the amount due, the
 * payments recorded on it and what can pay now. A product sold on a visit is a
 * product line of one appointment of the visit: the product, a quantity in its
 * sale unit, the inventory it is taken from, the team member credited with the
 * sale, the unit price, the line's discount and the line total. Loyalty
 * programs may take more off a line after it is saved, so the amount the
 * client pays is read back, never predicted.
 *
 * Method names and DTOs use the product glossary (visit, visit item, payment,
 * amount due, appointment, product, inventory, team member). The wire names —
 * `document`, `sale`, `good`, `record`, `attendance`, `staff_id`, `good_id`,
 * `storage_id`, `attendance_good_items`, `manual_cost`, `loyalty_certificate`,
 * `loyalty_abonement`, `prepay_hold`, `comer`, `activity` — stop inside the
 * adapters.
 *
 * Each method runs on the backend that serves it today
 * (`./visits-adapter.ts`): the visit and its payments on V1
 * (`./v1/visits-adapter.ts`), product lines on the V2 appointment save the web
 * app uses (`./v2/visit-products-adapter.ts`), which rewrites the whole
 * appointment, so it echoes what it read and refuses to write over a change.
 * A V3 adapter implements the whole port and replaces both without changing
 * the tools.
 *
 * Money read back is in major units of the location's currency, as the API
 * reports it. A payment's amount is a `Money` (`./money.ts`). Every write takes
 * `WriteOptions`: the idempotency key a V3 adapter sends as `Idempotency-Key`
 * (see `./write-options.ts`).
 */
import type { AppointmentAttendance } from './inventory-api.js';
import type { Money } from './money.js';
import type { WriteOptions } from './write-options.js';

export type { AppointmentAttendance };

// ========== the visit: items and payments ==========

/** What one visit item sells. */
export type VisitItemKind = 'service' | 'product' | 'other';

/** One visit item: a service or product line of the visit. */
export interface VisitItem {
  id: number;
  appointment_id: number | null;
  kind: VisitItemKind;
  service_id: number | null;
  product_id: number | null;
  title: string | null;
  quantity: number | null;
  /** Catalog price of one unit, before discounts. */
  unit_price: number | null;
  /** Line total before the client's discount. */
  amount_before_discount: number | null;
  client_discount_percent: number | null;
  /** What the client pays for the line: the line total after discounts. */
  amount: number | null;
}

/**
 * How a payment is made, or can be made.
 *
 * `account` — money into one of the accounts and cash registers (cash or
 * non-cash); `client_account` — from the client's balance; `loyalty_card` —
 * from the balance of a loyalty card; `loyalty_program` — a loyalty program
 * applied to the visit; `gift_card`; `membership` — the visit is covered by a
 * membership; `referral_program`; `advance_payment_hold` — an advance payment
 * held for this visit is applied; `other` — a kind this build does not know.
 */
export type PaymentMethod =
  | 'account'
  | 'client_account'
  | 'loyalty_card'
  | 'loyalty_program'
  | 'gift_card'
  | 'membership'
  | 'referral_program'
  | 'advance_payment_hold'
  | 'other';

/** One payment recorded on the visit. */
export interface VisitPayment {
  /**
   * Stable payment id: `t<number>` for money into an account or cash
   * register, `l<number>` for a payment from a client account or a loyalty
   * instrument.
   */
  id: string;
  method: PaymentMethod;
  amount: number;
  /** The visit item it pays, when the API attributes it to one. */
  visit_item_id: number | null;
  account_id: number | null;
  account_title: string | null;
  /** Payment method configured for the location, e.g. "Cash", "Card". */
  payment_method_name: string | null;
  client_account_id: number | null;
  loyalty_card_id: number | null;
  loyalty_program_id: number | null;
  gift_card_id: number | null;
  membership_id: number | null;
}

/** An advance payment held on a client account for this visit. */
export interface AdvancePaymentHold {
  id: number;
  client_account_id: number | null;
  amount: number | null;
  /** `active`, `completed`, … as the API reports it. */
  status: string | null;
}

/** One way the visit can be paid right now, with what it would accept. */
export interface PaymentOption {
  method: PaymentMethod;
  applicable: boolean;
  /** The most this method can pay now. */
  applicable_amount: number | null;
  /** false — the method must pay `applicable_amount` in one payment. */
  partial_allowed: boolean;
  account_id: number | null;
  account_title: string | null;
  /** For an account: cash (true) or non-cash settlement (false). */
  cash: boolean | null;
  client_account_id: number | null;
  loyalty_card_id: number | null;
  loyalty_card_number: string | null;
  loyalty_program_id: number | null;
  loyalty_program_title: string | null;
  gift_card_id: number | null;
  membership_id: number | null;
  /** Gift card or membership: its number must be sent with the payment. */
  number_required: boolean | null;
  /** Visits a membership can still cover. */
  applicable_visits: number | null;
  advance_payment_hold_id: number | null;
  /** Balance of the client account, loyalty card or gift card. */
  balance: number | null;
  /** The chain the instrument belongs to. */
  chain_id: number | null;
}

/** The visit an appointment belongs to: what it sells and how it is paid. */
export interface Visit {
  location_id: number;
  appointment_id: number;
  visit_id: number | null;
  client_id: number | null;
  items: VisitItem[];
  payments: VisitPayment[];
  advance_payment_holds: AdvancePaymentHold[];
  payment_options: PaymentOption[];
  /** Sum of the visit item amounts. */
  total_amount: number;
  /** Sum of the recorded payments. */
  paid_amount: number;
  /** What the client still has to pay. */
  amount_due: number;
}

/** A payment to record, by method; every id comes from `payment_options`. */
export type PaymentRequest =
  | { method: 'account'; account_id: number; amount: Money }
  | { method: 'client_account'; client_account_id: number; amount: Money }
  | { method: 'loyalty_card'; loyalty_card_id: number; amount: Money }
  | {
      method: 'loyalty_program';
      loyalty_card_id: number;
      loyalty_program_id: number;
    }
  | {
      method: 'gift_card';
      gift_card_id: number;
      amount: Money;
      number?: string;
    }
  | { method: 'membership'; membership_id: number; number?: string }
  | {
      method: 'advance_payment_hold';
      advance_payment_hold_id: number;
      amount: Money;
    };

// ========== product lines ==========

/** One product line of an appointment. */
export interface VisitProductLine {
  id: number;
  product_id: number;
  /** In the unit `unit_kind` names. */
  quantity: number;
  /** `sale` — sold in its sale unit; `consumable` — in its consumable unit. */
  unit_kind: 'sale' | 'consumable';
  unit_id: number;
  inventory_id: number;
  /** The team member credited with the sale. */
  team_member_id: number;
  /** Price of one unit before discounts. */
  unit_price: number;
  discount_percent: number;
  /** Line total after the line's discount, before loyalty programs. */
  amount: number;
  /** What the client pays for the line once loyalty programs apply. */
  amount_after_loyalty: number | null;
  /**
   * Set when the line issued a gift card or a membership; a save sends its
   * number and activation date back as read.
   */
  loyalty_kind: 'gift_card' | 'membership' | null;
  /** Product marking codes recorded on the line. */
  marks: string[];
}

/** One service line of the appointment, as the visit counts it. */
export interface VisitServiceLine {
  id: number;
  service_id: number;
  quantity: number;
  unit_price: number;
  discount_percent: number;
  /** After the line's discount, before loyalty programs. */
  amount: number;
  amount_after_loyalty: number | null;
}

/** What a product sale on an appointment depends on. */
export interface AppointmentSale {
  location_id: number;
  appointment_id: number;
  visit_id: number | null;
  client_id: number | null;
  team_member_id: number;
  attendance: AppointmentAttendance;
  /** The appointment is a client's place in a group event. */
  group_event: boolean;
  /** The visit's receipt is printed (or a fiscal receipt is being prepared). */
  receipt_printed: boolean;
  /** Wall-clock start at the location, `YYYY-MM-DDTHH:MM:SS`. */
  start_local: string;
  duration_seconds: number;
  /** The client's personal discount, which the web app applies to new lines. */
  client_discount_percent: number | null;
  /**
   * The appointment's custom field values could be read, so a save of an
   * arrived appointment sends them back. When false, a location that requires
   * custom fields on arrival refuses such a save.
   */
  custom_fields_readable: boolean;
  service_lines: VisitServiceLine[];
  product_lines: VisitProductLine[];
  /**
   * The other appointments of the visit: how many product lines each holds,
   * and how many of those carry a loyalty discount (their amount after loyalty
   * programs differs from their amount, or does not read back). A save of this
   * appointment makes Altegio re-save the other appointments' product lines
   * from their amounts after loyalty, which changes exactly those lines.
   */
  other_appointments: Array<{
    appointment_id: number;
    product_lines: number;
    loyalty_priced_lines: number;
  }>;
  /**
   * Why this appointment cannot be written back exactly (a visitor or a
   * combined service that does not read back, a start time that does not
   * read back) — null when it can. A sale is refused while it is set.
   */
  unsupported: string | null;
  /** Opaque version of everything a save writes back; any change changes it. */
  version: string;
}

/** Stock of a product in one inventory, with what decides the default one. */
export interface ProductStockForSale {
  inventory_id: number;
  /** The inventory sells products to clients. */
  for_sale: boolean;
  /** The location's ordering of its inventories; higher comes first. */
  sort_weight: number | null;
  /** In the product's sale unit; can be negative. */
  sale_quantity: number | null;
}

/** A product as a sale needs it. */
export interface ProductForSale {
  id: number;
  title: string | null;
  /** Sale price per sale unit. */
  sale_price: number | null;
  sale_unit_id: number | null;
  /** Set when the product sells a membership or a gift card. */
  loyalty_kind: 'membership' | 'gift_card' | null;
  /** Only inventories that already hold a stock record of the product. */
  stock: ProductStockForSale[];
}

/** The product line to save: a new one, or a new quantity for an existing one. */
export interface ProductLineWrite {
  /** The existing line whose quantity is raised; null adds a line. */
  line_id: number | null;
  product_id: number;
  /** In the sale unit. */
  quantity: number;
  unit_id: number;
  inventory_id: number;
  team_member_id: number;
  unit_price: number;
  discount_percent: number;
  /** quantity × unit_price less the discount, rounded to 2 decimals. */
  amount: number;
  marks: string[];
}

export interface AddProductLineRequest {
  line: ProductLineWrite;
  /** Mark the appointment arrived with the sale. */
  mark_arrived: boolean;
  /** `version` of the read the sale was planned on. */
  expected_version: string;
}

export interface ProductLineSaveResult {
  /** The appointment read back after the save. */
  appointment: AppointmentSale;
  /**
   * What the save changed besides the product line and the status it was
   * asked to set, named in the glossary ("start time", "services"). Empty
   * when nothing else changed.
   */
  unexpected_changes: string[];
}

/** A product line to drop, or to keep with a lower quantity. */
export interface ReduceProductLineRequest {
  line_id: number;
  /** The quantity the line keeps, in its unit; 0 drops the line. */
  quantity: number;
  /** quantity × unit_price less the line's discount; 0 when dropped. */
  amount: number;
  /** `version` of the read the change was planned on. */
  expected_version: string;
}

// ========== the port ==========

/** The visit and its payments: the part V1 serves today. */
export type VisitPaymentsApi = Pick<
  VisitsApi,
  'getVisit' | 'addPayment' | 'cancelPayment'
>;

/** Product lines of the visit's appointments: the part V2 serves today. */
export type VisitProductLinesApi = Omit<VisitsApi, keyof VisitPaymentsApi>;

export interface VisitsApi {
  /** The visit an appointment belongs to. */
  getVisit(locationId: number, appointmentId: number): Promise<Visit>;
  /** Record a payment and return the visit after it. */
  addPayment(
    locationId: number,
    appointmentId: number,
    payment: PaymentRequest,
    options?: WriteOptions
  ): Promise<Visit>;
  /** Cancel one recorded payment and return the visit after it. */
  cancelPayment(
    locationId: number,
    appointmentId: number,
    paymentId: string,
    options?: WriteOptions
  ): Promise<Visit>;

  getAppointmentSale(
    locationId: number,
    appointmentId: number
  ): Promise<AppointmentSale>;
  getProductForSale(
    locationId: number,
    productId: number
  ): Promise<ProductForSale>;
  /**
   * Save the line. Refuses without writing when the appointment no longer
   * matches `expected_version`.
   */
  addProductLine(
    locationId: number,
    appointmentId: number,
    request: AddProductLineRequest,
    options?: WriteOptions
  ): Promise<ProductLineSaveResult>;
  /**
   * Drop the line or lower its quantity; the product returns to the line's
   * inventory. Refuses without writing when the appointment no longer matches
   * `expected_version`.
   */
  reduceProductLine(
    locationId: number,
    appointmentId: number,
    request: ReduceProductLineRequest,
    options?: WriteOptions
  ): Promise<ProductLineSaveResult>;
}
