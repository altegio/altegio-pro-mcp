/**
 * `[Inventory]` tool pack — inventories, products with their stock, inventory
 * operations and their documents, Suppliers and Partners, Bills of Materials,
 * and the consumables recorded on an appointment.
 *
 * An inventory is a place a location keeps product stock in. An inventory
 * operation (product sale, consumption, product receipt, write-off) is
 * recorded as a document with one line per product. A Bill of Materials is a
 * service's consumption recipe; an appointment's consumables are what its
 * service actually used, and they move stock once the appointment is marked
 * arrived.
 *
 * Names, parameters and results use the product glossary; the wire vocabulary
 * (`storage`, `good`, `goods_transactions`, `technological_card`, `record`,
 * `master`, `type_id`) stops in `src/api/v1/inventory-adapter.ts` and
 * `src/api/v2/products-adapter.ts`.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { collectionSchema, pageArg, pageSizeArg } from '../pagination.js';
import * as inventory from '../../capabilities/inventory/use-cases.js';
import * as consumables from '../../capabilities/inventory/consumables.js';

// ========== shared input pieces ==========

const locationId = z
  .number()
  .int()
  .positive()
  .describe('Location id (locations_list).');

const inventoryId = z
  .number()
  .int()
  .positive()
  .describe('Inventory id (inventory_list).');

const appointmentId = z
  .number()
  .int()
  .positive()
  .describe('Appointment id (appointments_list).');

const productId = z
  .number()
  .int()
  .positive()
  .describe('Product id (products_search).');

const productText = z
  .string()
  .min(2)
  .max(100)
  .describe(
    'Or the product by name, article number or barcode; it must match exactly one product, otherwise the call is refused with the candidates.'
  );

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

// ========== output schemas ==========

const int = { type: ['integer', 'null'] as const };
const num = { type: ['number', 'null'] as const };
const str = { type: ['string', 'null'] as const };
const bool = { type: 'boolean' as const };
const integer = { type: 'integer' as const };

const inventorySchema = {
  type: 'object' as const,
  properties: {
    id: integer,
    title: str,
    for_sale: bool,
    for_consumables: bool,
    comment: str,
  },
  required: ['id', 'title', 'for_sale', 'for_consumables'],
};

const unitSchema = {
  type: 'object' as const,
  properties: { id: int, name: str },
  required: ['id', 'name'],
};

const stockSchema = {
  type: 'object' as const,
  properties: {
    inventory_id: integer,
    inventory_title: str,
    sale_quantity: num,
    consumable_quantity: num,
  },
  required: ['inventory_id', 'sale_quantity', 'consumable_quantity'],
};

const productSchema = {
  type: 'object' as const,
  properties: {
    id: integer,
    title: str,
    category_id: int,
    sale_price: num,
    cost_price: num,
    currency: str,
    sale_unit: unitSchema,
    consumable_unit: unitSchema,
    consumable_units_per_sale_unit: num,
    loyalty_kind: {
      type: ['string', 'null'] as const,
      enum: ['membership', 'gift_card', null],
    },
    chain_product: bool,
    stock: { type: ['array', 'null'] as const, items: stockSchema },
    stock_total: {
      type: ['object', 'null'] as const,
      properties: { sale_quantity: num, consumable_quantity: num },
    },
  },
  required: ['id', 'title', 'sale_price', 'cost_price', 'currency', 'stock'],
};

const movementSchema = {
  type: 'object' as const,
  properties: {
    id: integer,
    document_id: int,
    kind: {
      type: 'string' as const,
      enum: [
        'sale',
        'consumption',
        'receipt',
        'write_off',
        'transfer',
        'other',
      ],
    },
    date: str,
    product_id: int,
    product_title: str,
    quantity: num,
    direction: { type: ['string', 'null'] as const, enum: ['in', 'out', null] },
    unit: str,
    unit_price: num,
    discount_percent: num,
    total: num,
    currency: str,
    inventory_id: int,
    inventory_title: str,
    team_member_id: int,
    client_id: int,
    supplier_id: int,
    appointment_id: int,
    service_id: int,
    comment: str,
  },
  required: [
    'id',
    'document_id',
    'kind',
    'product_id',
    'quantity',
    'direction',
  ],
};

const supplierSchema = {
  type: 'object' as const,
  properties: {
    id: integer,
    title: str,
    type: {
      type: 'string' as const,
      enum: ['legal_entity', 'sole_proprietor', 'individual', 'unknown'],
    },
  },
  required: ['id', 'title', 'type'],
};

const consumableLineSchema = {
  type: 'object' as const,
  properties: {
    line_id: int,
    product_id: integer,
    product_title: str,
    inventory_id: integer,
    quantity: { type: 'number' as const },
    unit: str,
    cost: num,
  },
  required: ['product_id', 'inventory_id', 'quantity', 'unit', 'cost'],
};

const bomSchema = {
  type: 'object' as const,
  properties: {
    id: integer,
    title: str,
    lines: { type: 'array' as const, items: consumableLineSchema },
  },
  required: ['id', 'title', 'lines'],
};

const serviceConsumablesSchema = {
  type: 'object' as const,
  properties: {
    appointment_id: integer,
    service_id: integer,
    bill_of_materials: {
      type: ['object', 'null'] as const,
      properties: { id: integer, title: str },
    },
    lines: { type: 'array' as const, items: consumableLineSchema },
  },
  required: ['appointment_id', 'service_id', 'bill_of_materials', 'lines'],
};

const locationAndCurrency = { location_id: integer, currency: str };

// ========== inventories ==========

export const inventoryListTool = defineTool({
  name: 'inventory_list',
  category: 'Inventory',
  description:
    'The inventories of a location — the places it keeps product stock in — with the default one for product sales and the ones consumables of services are written off from. Start here for the inventory_id the inventory tools take.',
  annotations: { title: 'Inventory: list inventories', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    page: pageArg,
    page_size: pageSizeArg(100, 50),
  }),
  outputSchema: collectionSchema(inventorySchema, { location_id: integer }),
  handler: async ({ input, client }) =>
    inventory.listInventories(client, input),
});

// ========== products ==========

export const productsSearchTool = defineTool({
  name: 'products_search',
  category: 'Inventory',
  description:
    'Find products of a location by name, article number or barcode (query), by product_ids, or page through all of them: sale price and cost price in the location currency, sale and consumable units, and stock per inventory (include_stock, default true; it reads each product, so keep pages small). Stock can be negative. Paged: follow pagination.next_page.',
  annotations: { title: 'Inventory: search products and stock', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    query: z
      .string()
      .max(100)
      .optional()
      .describe(
        'At least two characters of a name, article number or barcode.'
      ),
    product_ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(50)
      .optional()
      .describe('Read these products instead of searching.'),
    include_stock: z
      .boolean()
      .default(true)
      .describe('Stock per inventory (default true).'),
    page: pageArg,
    page_size: pageSizeArg(50, 20),
  }),
  outputSchema: collectionSchema(productSchema, locationAndCurrency),
  handler: async ({ input, client }) => inventory.searchProducts(client, input),
});

// ========== inventory operations ==========

export const inventoryListOperationsTool = defineTool({
  name: 'inventory_list_operations',
  category: 'Inventory',
  description:
    'Inventory history of a location, newest first: one row per product line of an inventory operation — product sales (on a visit too), consumption and appointment consumables, product receipts, write-offs, transfers — with its document_id, product, quantity with unit and direction, inventory, prices and total in the location currency, and the client, Supplier and appointment ids where Altegio reports them. Filter by date_from/date_to or by document_id (every line of one operation); there is no filter by product or kind. Paged: follow pagination.next_page.',
  annotations: { title: 'Inventory: list inventory operations', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    date_from: z
      .string()
      .optional()
      .describe('First day at the location, YYYY-MM-DD.'),
    date_to: z
      .string()
      .optional()
      .describe('Last day at the location, YYYY-MM-DD.'),
    document_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Only the lines of this document.'),
    page: pageArg,
    page_size: pageSizeArg(100, 25),
  }),
  outputSchema: collectionSchema(movementSchema, locationAndCurrency),
  handler: async ({ input, client }) => inventory.listOperations(client, input),
});

const operationLine = z
  .object({
    product_id: productId.optional(),
    product: productText.optional(),
    quantity: z
      .number()
      .positive()
      .max(1_000_000)
      .describe('How much, in the unit below.'),
    unit: z
      .enum(['sale', 'consumable'])
      .optional()
      .describe(
        'sale: the product’s sale unit (pcs, bottle); consumable: its consumable unit (ml, g). Default: sale.'
      ),
    unit_price: z
      .number()
      .min(0)
      .max(100_000_000)
      .optional()
      .describe(
        'Price per unit in the location currency. Default: the sale price for a sale, the cost price otherwise; a receipt should give the cost price it was bought at.'
      ),
    discount_percent: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe('Discount on the line, 0–100. Default 0.'),
  })
  .strict();

const KIND_TEXT: Record<inventory.CreateOperationInput['kind'], string> = {
  sale: 'product sale',
  receipt: 'product receipt',
  write_off: 'write-off',
};

export const inventoryCreateOperationTool = defineTool({
  name: 'inventory_create_operation',
  category: 'Inventory',
  description:
    'Record an inventory operation as one document with one line per product: kind sale (sold over the counter), receipt (products arriving, optionally from a supplier_id) or write_off (damaged, expired, lost). Consumption outside an appointment and transfers between inventories are not available. Each line takes product_id or product (name, article number, barcode), a quantity in the sale or consumable unit, and optionally unit_price and discount_percent; a line total is quantity × price minus the discount. team_member_id is required. No payment is recorded. For an appointment’s consumables use appointments_set_consumables. Undo with inventory_delete_document. Asks for confirmation first. Refused when an identical operation (same kind, inventory, lines, prices, date and comment) was just recorded; to record a genuine second one, give it a different comment.',
  annotations: {
    title: 'Inventory: record an inventory operation',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    kind: z
      .enum(['sale', 'receipt', 'write_off'])
      .describe('sale, receipt or write_off.'),
    team_member_id: z
      .number()
      .int()
      .positive()
      .describe(
        'The team member who performs it (team_members_list); a dismissed one is refused.'
      ),
    lines: z
      .array(operationLine)
      .min(1)
      .max(50)
      .describe('One line per product.'),
    inventory_id: inventoryId
      .optional()
      .describe(
        'Inventory id (inventory_list). Default: the location’s only sale inventory for a sale; required otherwise.'
      ),
    client_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Sale only: the client who buys (clients_search).'),
    supplier_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Receipt only: the Supplier it comes from (suppliers_and_partners_list).'
      ),
    date: z
      .string()
      .optional()
      .describe(
        'When it happened, at the location: YYYY-MM-DDTHH:MM, no offset, not in the future. Default: now.'
      ),
    comment: z
      .string()
      .max(1000)
      .optional()
      .describe('Comment on the document; it is also set on every line.'),
  }),
  confirm: {
    action: 'Record inventory operation',
    target: (input) =>
      `${KIND_TEXT[input.kind] ?? 'inventory operation'} of ${input.lines?.length ?? 0} product line(s) at location ${input.location_id}`,
    consequence: (input) =>
      `A ${KIND_TEXT[input.kind] ?? 'inventory operation'} document is created and its lines ${input.kind === 'receipt' ? 'add the products to' : 'take the products from'} the inventory at once, at the prices and totals below. No payment is recorded. It stays until someone deletes the document with inventory_delete_document, which reverses the stock.`,
    detail: (input, client) => inventory.describeOperation(client, input),
  },
  handler: async ({ input, client, confirmation }) =>
    inventory.createOperation(client, input, undefined, confirmation),
});

export const inventoryDeleteDocumentTool = defineTool({
  name: 'inventory_delete_document',
  category: 'Inventory',
  description:
    'Delete the document of an inventory operation (document_id from inventory_list_operations) with all its product lines; the stock they moved is reversed. A payment recorded for it is not deleted. A product sale on a visit and an appointment’s consumables are not inventory operation documents and cannot be deleted here. Asks for confirmation first.',
  annotations: {
    title: 'Inventory: delete an inventory operation document',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    document_id: z
      .number()
      .int()
      .positive()
      .describe('Document id (inventory_list_operations).'),
  }),
  confirm: {
    action: 'Delete inventory operation document',
    target: (input) =>
      `document ${input.document_id} at location ${input.location_id}`,
    resolve: (input, client) => inventory.describeDocument(client, input),
    consequence:
      'The document and every product line on it are deleted, and the stock they moved comes back: sold, used or written-off products return to the inventory, received ones leave it. A payment recorded for the document stays. A deleted document cannot be restored from here.',
    detail: (input, client) => inventory.describeDocumentLines(client, input),
  },
  handler: async ({ input, client, confirmation }) =>
    inventory.deleteDocument(client, input, confirmation),
});

// ========== suppliers ==========

export const suppliersAndPartnersListTool = defineTool({
  name: 'suppliers_and_partners_list',
  category: 'Inventory',
  description:
    'The Suppliers and Partners of a location — the counterparties it pays or is paid by, such as those it receives products from — optionally filtered by part of the name: id, name and type (legal entity, sole proprietor, individual). Use the id as supplier_id in financial_transactions_create, financial_transactions_update and financial_transactions_list, or of a product receipt (inventory_create_operation). Needs the Finances access rights. Paged: follow pagination.next_page.',
  annotations: {
    title: 'Inventory: list Suppliers and Partners',
    ...READ_ONLY,
  },
  input: z.object({
    location_id: locationId,
    query: z.string().max(100).optional().describe('Part of the name.'),
    page: pageArg,
    page_size: pageSizeArg(100, 50),
  }),
  outputSchema: collectionSchema(supplierSchema, { location_id: integer }),
  handler: async ({ input, client }) => inventory.listSuppliers(client, input),
});

// ========== Bills of Materials ==========

export const inventoryListBillsOfMaterialsTool = defineTool({
  name: 'inventory_list_bills_of_materials',
  category: 'Inventory',
  description:
    'Bills of Materials of a location — each service’s consumption recipe: the consumables and quantities one service uses, from which inventory, at cost price. Search by part of the title, or pass team_member_id with service_id for the one Altegio applies when that team member provides that service. Paged: follow pagination.next_page.',
  annotations: { title: 'Inventory: list Bills of Materials', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    query: z.string().max(100).optional().describe('Part of the title.'),
    team_member_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('With service_id: the Bill of Materials for this team member.'),
    service_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('With team_member_id: for this service (services_list).'),
    page: pageArg,
    page_size: pageSizeArg(50, 20),
  }),
  outputSchema: collectionSchema(bomSchema, locationAndCurrency),
  handler: async ({ input, client }) =>
    inventory.listBillsOfMaterials(client, input),
});

// ========== appointment consumables ==========

export const appointmentsGetConsumablesTool = defineTool({
  name: 'appointments_get_consumables',
  category: 'Appointments',
  description:
    'The consumables recorded on an appointment, per service: product, quantity per one service in its consumable unit, inventory, cost at cost price, and the Bill of Materials they were filled from. Says whether they have moved stock yet — only once the appointment is marked arrived — and which other appointments of the visit share a service. Read it before appointments_set_consumables.',
  annotations: { title: 'Appointments: read consumables', ...READ_ONLY },
  input: z.object({ location_id: locationId, appointment_id: appointmentId }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: integer,
      appointment_id: integer,
      attendance: {
        type: 'string' as const,
        enum: ['waiting', 'confirmed', 'arrived', 'no_show', 'unknown'],
      },
      stock_moved: bool,
      currency: str,
      services: { type: 'array' as const, items: serviceConsumablesSchema },
      other_appointment_ids: { type: 'array' as const, items: integer },
      services_on_other_appointments: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            service_id: integer,
            appointment_ids: { type: 'array' as const, items: integer },
          },
          required: ['service_id', 'appointment_ids'],
        },
      },
    },
    required: [
      'location_id',
      'appointment_id',
      'attendance',
      'stock_moved',
      'currency',
      'services',
      'other_appointment_ids',
      'services_on_other_appointments',
    ],
  },
  handler: async ({ input, client }) =>
    consumables.getConsumables(client, input),
});

export const appointmentsSetConsumablesTool = defineTool({
  name: 'appointments_set_consumables',
  category: 'Appointments',
  description:
    'Change the consumables recorded on one service of an appointment. Each entry sets a product’s quantity per one service in its consumable unit (ml, g); 0 removes it; products not listed stay unless replace is true. Altegio stores the service’s whole list again (new line ids), computes cost at cost price and stops following the Bill of Materials for it. Stock moves only once the appointment is marked arrived. Refused when another appointment of the visit has the same service. Asks for confirmation first, showing before → after; refused if the consumables change after that.',
  annotations: {
    title: 'Appointments: change consumables',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    appointment_id: appointmentId,
    service_id: z
      .number()
      .int()
      .positive()
      .describe('A service of the appointment (appointments_get_consumables).'),
    consumables: z
      .array(
        z
          .object({
            product_id: productId.optional(),
            product: productText.optional(),
            quantity: z
              .number()
              .min(0)
              .max(1_000_000)
              .describe(
                'Per one service, in the consumable unit; 0 removes it.'
              ),
            inventory_id: inventoryId
              .optional()
              .describe(
                'Inventory to take it from. Default: the line’s current one, else the location’s only consumables inventory.'
              ),
          })
          .strict()
      )
      .min(1)
      .max(50)
      .describe('Products to set; others stay unless replace is true.'),
    replace: z
      .boolean()
      .default(false)
      .describe(
        'true: the list becomes exactly these consumables and every other line is removed. Default false.'
      ),
  }),
  confirm: {
    action: 'Change appointment consumables',
    target: (input) =>
      `service ${input.service_id} on appointment ${input.appointment_id} at location ${input.location_id}`,
    consequence: (input) =>
      `Altegio stores the whole consumables list of this service again: every line gets a new id, ${input.replace ? 'every line not listed is removed' : 'lines not mentioned are kept'}, and the service stops following its Bill of Materials on this appointment. Cost is recomputed at cost price.`,
    detail: (input, client) =>
      consumables.describeConsumablesChange(client, input),
  },
  handler: async ({ input, client, confirmation }) =>
    consumables.setConsumables(client, input, confirmation),
});
