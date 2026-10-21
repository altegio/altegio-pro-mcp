/**
 * `InventoryApi` and `ProductsApi` — the ports the inventory capability layer
 * talks to (ADR-001 D5).
 *
 * An inventory is a place a location keeps product stock in; a location has
 * several (one sells to clients, another holds the consumables services use).
 * An inventory operation is one stock movement recorded as a document — a
 * product sale, consumption, a product receipt from a supplier, a write-off —
 * and each of its lines moves one product. A Bill of Materials is a service's
 * consumption recipe; the consumables recorded on an appointment are what one
 * appointment's service actually used.
 *
 * Method names and DTOs use the product glossary (inventory, product,
 * consumable, supplier, team member, appointment, document); the wire names
 * (`storage`, `good`, `goods_transactions`, `technological_card`, `record`,
 * `master`, `company`, `type_id`, `for_service`) stop inside
 * `./v1/inventory-adapter.ts` and `./v2/products-adapter.ts`.
 *
 * Quantities are in the unit each field names: the product's sale unit
 * ("pcs") or its consumable unit ("ml"). Money is in major units of the
 * location's currency, as the API reports it.
 *
 * Every write takes `WriteOptions`: the idempotency key a V3 adapter sends as
 * `Idempotency-Key` (see `./write-options.ts`).
 */

import type { Money } from './money.js';
import type { WriteOptions } from './write-options.js';

/**
 * What an inventory operation recorded through the API does to stock. The
 * operation endpoint refuses consumption and transfers.
 */
export type InventoryOperationKind = 'sale' | 'receipt' | 'write_off';

/**
 * The kind of one product line read back: an operation kind, `consumption`,
 * a `transfer` between inventories, or `other` for a kind this build does not
 * know.
 */
export type InventoryMovementKind =
  InventoryOperationKind | 'consumption' | 'transfer' | 'other';

/** One inventory of a location. */
export interface Inventory {
  id: number;
  title: string | null;
  /** The location sells products to clients from it by default. */
  for_sale: boolean;
  /** Consumables of services are written off from it. */
  for_consumables: boolean;
  comment: string | null;
}

/** A unit of measure a product is counted in. */
export interface ProductUnit {
  id: number;
  title: string | null;
  short_title: string | null;
}

/** The product card fields an agent needs to find, price and count a product. */
export interface Product {
  id: number;
  title: string | null;
  category_id: number | null;
  /** Sale price per sale unit. */
  sale_price: number | null;
  /** Cost price per sale unit; null when not read or not visible to the user. */
  cost_price: number | null;
  sale_unit_id: number | null;
  consumable_unit_id: number | null;
  /** How many consumable units one sale unit holds (200 ml in one bottle). */
  consumable_units_per_sale_unit: number | null;
  /** Set when the product sells a membership or a gift card. */
  loyalty_kind: 'membership' | 'gift_card' | null;
  /** The product belongs to the chain's shared product catalog. */
  chain_product: boolean;
}

/** Stock of one product in one inventory. Can be negative. */
export interface ProductStock {
  inventory_id: number;
  /** In the product's sale unit. */
  sale_quantity: number | null;
  /** In the product's consumable unit. */
  consumable_quantity: number | null;
}

export interface ProductWithStock extends Product {
  /** Null when stock was not read. */
  stock: ProductStock[] | null;
}

/** One product line of an inventory operation, as recorded. */
export interface InventoryMovement {
  id: number;
  document_id: number | null;
  kind: InventoryMovementKind;
  /**
   * RFC 3339 in the location's offset; the location's wall time without an
   * offset when the location's time zone is unknown.
   */
  date: string | null;
  product_id: number | null;
  product_title: string | null;
  /** Absolute quantity in `unit`. */
  quantity: number | null;
  /** `out` lowers stock, `in` raises it. */
  direction: 'in' | 'out' | null;
  unit: string | null;
  unit_price: number | null;
  discount_percent: number | null;
  total: number | null;
  inventory_id: number | null;
  inventory_title: string | null;
  team_member_id: number | null;
  client_id: number | null;
  supplier_id: number | null;
  /** Set when the line belongs to an appointment (a visit sale, its consumables). */
  appointment_id: number | null;
  service_id: number | null;
  comment: string | null;
}

/** The document that records one inventory operation. */
export interface InventoryDocument {
  id: number;
  kind: InventoryMovementKind;
  number: number | null;
  inventory_id: number | null;
  inventory_title: string | null;
  /** Wall-clock time at the location, `YYYY-MM-DDTHH:MM:SS`. */
  date_local: string | null;
  comment: string | null;
}

/** One line of an operation to record, already priced and in a known unit. */
export interface OperationLineWrite {
  product_id: number;
  quantity: number;
  /** The unit the quantity is counted in: the product's sale or consumable unit. */
  unit_id: number;
  unit_price: Money;
  discount_percent: number;
  /** quantity × unit_price less the discount. */
  total: Money;
}

export interface OperationWrite {
  kind: InventoryOperationKind;
  inventory_id: number;
  team_member_id: number;
  client_id?: number;
  supplier_id?: number;
  /** Wall-clock time at the location, `YYYY-MM-DD HH:MM:SS`; omitted: now. */
  date_local?: string;
  comment?: string;
  lines: OperationLineWrite[];
}

export interface CreatedOperation {
  document: InventoryDocument;
  lines: InventoryMovement[];
}

export type SupplierType =
  'legal_entity' | 'sole_proprietor' | 'individual' | 'unknown';

/** One of the location's Suppliers and Partners. */
export interface Supplier {
  id: number;
  title: string | null;
  type: SupplierType;
}

/** One line of a Bill of Materials or of an appointment's consumables. */
export interface ConsumableLine {
  /** The recorded line's id; null for a Bill of Materials line. */
  line_id: number | null;
  product_id: number;
  product_title: string | null;
  inventory_id: number;
  /** Per one service, in the product's consumable unit. */
  quantity: number;
  /** The consumable unit's short title ("ml"). */
  unit: string | null;
  /** Line cost per one service, at cost price. */
  cost: number | null;
}

/** A service's consumption recipe. */
export interface BillOfMaterials {
  id: number;
  title: string | null;
  lines: ConsumableLine[];
}

/** The consumables recorded on one service of one appointment of a visit. */
export interface AppointmentServiceConsumables {
  appointment_id: number;
  service_id: number;
  /** The Bill of Materials the lines were filled from; null once edited by hand. */
  bill_of_materials: { id: number; title: string | null } | null;
  lines: ConsumableLine[];
}

/** One line to store for an appointment's service. */
export interface ConsumableWrite {
  /** The existing line it keeps, when there is one. */
  line_id?: number;
  product_id: number;
  inventory_id: number;
  /** Per one service, in the product's consumable unit. */
  quantity: number;
}

export type AppointmentAttendance =
  'waiting' | 'confirmed' | 'arrived' | 'no_show' | 'unknown';

/** What the consumables tools need to know about the appointment itself. */
export interface AppointmentState {
  id: number;
  location_id: number | null;
  attendance: AppointmentAttendance;
  service_ids: number[];
}

export interface MovementQuery {
  /** First location day, `YYYY-MM-DD`. */
  date_from?: string;
  /** Last location day, `YYYY-MM-DD`. */
  date_to?: string;
  document_id?: number;
  page: number;
  page_size: number;
}

/**
 * One page of product lines. It may hold fewer than `page_size` lines and
 * still be followed by more: the API pages by its own days, and lines outside
 * the location days asked for are left out.
 */
export interface MovementPage {
  lines: InventoryMovement[];
  /** The API has another page. */
  more: boolean;
}

export interface InventoryApi {
  listInventories(locationId: number): Promise<Inventory[]>;
  listMovements(
    locationId: number,
    query: MovementQuery
  ): Promise<MovementPage>;
  getDocument(
    locationId: number,
    documentId: number
  ): Promise<InventoryDocument>;
  deleteDocument(
    locationId: number,
    documentId: number,
    options?: WriteOptions
  ): Promise<void>;
  createOperation(
    locationId: number,
    operation: OperationWrite,
    options?: WriteOptions
  ): Promise<CreatedOperation>;
  listSuppliers(locationId: number): Promise<Supplier[]>;
  listBillsOfMaterials(
    locationId: number,
    query: { title?: string; page: number; page_size: number }
  ): Promise<BillOfMaterials[]>;
  getTeamMemberServiceBillOfMaterials(
    locationId: number,
    teamMemberId: number,
    serviceId: number
  ): Promise<BillOfMaterials | null>;
  getAppointment(
    locationId: number,
    appointmentId: number
  ): Promise<AppointmentState>;
  getAppointmentConsumables(
    locationId: number,
    appointmentId: number
  ): Promise<AppointmentServiceConsumables[]>;
  setAppointmentServiceConsumables(
    locationId: number,
    appointmentId: number,
    serviceId: number,
    lines: readonly ConsumableWrite[],
    options?: WriteOptions
  ): Promise<AppointmentServiceConsumables[]>;
}

export interface ProductsApi {
  /** One page of regular products (no membership or gift card products). */
  listProducts(
    locationId: number,
    query: { product_ids?: readonly number[]; page: number; page_size: number }
  ): Promise<Product[]>;
  /** Products whose name, article number or barcode match `term`. */
  searchProducts(
    locationId: number,
    term: string,
    query: { page: number; page_size: number }
  ): Promise<Product[]>;
  /** One product with its cost price and, when asked, its stock. */
  getProduct(
    locationId: number,
    productId: number,
    options: { stock: boolean }
  ): Promise<ProductWithStock>;
  listUnits(locationId: number): Promise<ProductUnit[]>;
}

// ========== the product catalog: product cards and categories ==========

/** A product category; every product is filed under one. */
export interface ProductCategory {
  id: number;
  title: string | null;
  /** The category it is nested in; null at the top level. */
  parent_id: number | null;
  /** The category belongs to the chain's shared product catalog. */
  chain_category: boolean;
}

export interface ProductCategoryWrite {
  title: string;
  /** Null: a top-level category. */
  parent_id: number | null;
}

/** A product card with every field the product form holds. */
export interface ProductCard extends Product {
  article: string | null;
  barcode: string | null;
  comment: string | null;
  /** Stock, in the sale unit, under which the product counts as running out. */
  critical_quantity: number | null;
  /** Stock, in the sale unit, the location wants to hold. */
  desired_quantity: number | null;
}

/** A product card to store; a create sends it whole, an update merged. */
export interface ProductCardWrite {
  title: string;
  category_id: number;
  sale_unit_id: number;
  consumable_unit_id: number;
  consumable_units_per_sale_unit: number;
  sale_price?: Money;
  cost_price?: Money;
  article?: string;
  barcode?: string;
  /** The name printed on the receipt; Altegio never reads it back. */
  print_title?: string;
  comment?: string;
  critical_quantity?: number;
  desired_quantity?: number;
}

export interface ProductCatalogApi {
  listCategories(locationId: number): Promise<ProductCategory[]>;
  createCategory(
    locationId: number,
    category: ProductCategoryWrite,
    options?: WriteOptions
  ): Promise<ProductCategory>;
  updateCategory(
    locationId: number,
    categoryId: number,
    category: ProductCategoryWrite,
    options?: WriteOptions
  ): Promise<ProductCategory>;
  deleteCategory(
    locationId: number,
    categoryId: number,
    options?: WriteOptions
  ): Promise<void>;
  /** The whole card; an archived product still reads here. */
  getProductCard(locationId: number, productId: number): Promise<ProductCard>;
  createProduct(
    locationId: number,
    product: ProductCardWrite,
    options?: WriteOptions
  ): Promise<ProductCard>;
  /**
   * Store the whole card. `unit_change` sends the unit conversion rules that a
   * unit change needs once the product's stock has moved.
   */
  updateProduct(
    locationId: number,
    productId: number,
    product: ProductCardWrite,
    options?: WriteOptions & { unit_change?: boolean }
  ): Promise<ProductCard>;
  /** `already_archived` when the product was archived before. */
  archiveProduct(
    locationId: number,
    productId: number,
    options?: WriteOptions
  ): Promise<'archived' | 'already_archived'>;
}
