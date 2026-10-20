/**
 * `VisitProductsApi` — the port behind `visits_add_product` and
 * `visits_remove_product` (ADR-001 D5).
 *
 * A product sold on a visit is a product line of one appointment of the visit:
 * the product, a quantity in its sale unit, the inventory it is taken from,
 * the team member credited with the sale, the unit price, the line's discount
 * and the line total. Loyalty programs may take more off the line after it is
 * saved, so the amount the client pays is read back, never predicted.
 *
 * Method names and DTOs use the product glossary (visit, appointment,
 * product, inventory, team member, visit item); the wire names (`record`,
 * `attendance`, `staff_id`, `good_id`, `storage_id`, `attendance_good_items`,
 * `manual_cost`, `comer`, `activity`, `custom_field_values`) stop inside the
 * adapter.
 *
 * The adapter is chosen per method: today the V2 appointment save the web app
 * uses (`./v2/visit-products-adapter.ts`), which rewrites the whole
 * appointment, so it echoes what it read and refuses to write over a change.
 * The planned V3 `addVisitItem` appends one line and checks the visit's ETag;
 * an adapter over it replaces this one without changing the tools. Money is
 * in major units of the location's currency.
 *
 * Every write takes `WriteOptions`: the idempotency key a V3 adapter sends as
 * `Idempotency-Key` (see `./write-options.ts`).
 */
import type { AppointmentAttendance } from './inventory-api.js';
import type { WriteOptions } from './write-options.js';

export type { AppointmentAttendance };

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

export interface VisitProductsApi {
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
