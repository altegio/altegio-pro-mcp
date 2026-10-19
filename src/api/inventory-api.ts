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
 */

/** What an inventory operation does to stock. */
export type InventoryOperationKind =
  'sale' | 'consumption' | 'receipt' | 'write_off';

/**
 * The kind of one product line read back: an operation kind, a `transfer`
 * between inventories, or `other` for a kind this build does not know.
 */
export type InventoryMovementKind =
  InventoryOperationKind | 'transfer' | 'other';

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
  /** RFC 3339 with the offset the API reports. */
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
  unit_price: number;
  discount_percent: number;
  total: number;
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
  date_from?: string;
  date_to?: string;
  document_id?: number;
  page: number;
  page_size: number;
}

export interface InventoryApi {
  listInventories(locationId: number): Promise<Inventory[]>;
  listMovements(
    locationId: number,
    query: MovementQuery
  ): Promise<InventoryMovement[]>;
  getDocument(
    locationId: number,
    documentId: number
  ): Promise<InventoryDocument>;
  deleteDocument(locationId: number, documentId: number): Promise<void>;
  createOperation(
    locationId: number,
    operation: OperationWrite
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
    lines: readonly ConsumableWrite[]
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
