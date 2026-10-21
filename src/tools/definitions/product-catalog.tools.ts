/**
 * `[Inventory]` product catalog — product cards (create, change, archive),
 * product categories, the units a product is counted in, and the matching of
 * incoming lines (a supplier invoice) to existing products.
 *
 * Names, parameters and results use the product glossary; the wire vocabulary
 * (`good`, `goods_categories`, `cost`/`actual_cost`, `unit_equals`,
 * `service_unit_id`, `parent_category_id`) stops in
 * `src/api/v1/product-catalog-adapter.ts`.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { collectionSchema, pageArg, pageSizeArg } from '../pagination.js';
import * as catalog from '../../capabilities/inventory/catalog.js';

// ========== shared input pieces ==========

const locationId = z
  .number()
  .int()
  .positive()
  .describe('Location id (locations_list).');

const productId = z
  .number()
  .int()
  .positive()
  .describe('Product id (products_search).');

const categoryId = z
  .number()
  .int()
  .positive()
  .describe('Product category id (product_categories_list).');

const unitRef = z
  .union([z.number().int().positive(), z.string().min(1).max(40)])
  .describe(
    'Unit id or short title, such as pcs or ml; api_call_operation list_product_units lists them.'
  );

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

const productFields = {
  sale_price: z
    .number()
    .min(0)
    .max(100_000_000)
    .optional()
    .describe('What a client pays per sale unit, in the location currency.'),
  cost_price: z
    .number()
    .min(0)
    .max(100_000_000)
    .optional()
    .describe('What one sale unit costs the location, in its currency.'),
  sale_unit: unitRef
    .optional()
    .describe(
      'The unit it is sold in (pcs, bottle). New products: default pcs.'
    ),
  consumable_unit: unitRef
    .optional()
    .describe(
      'The unit services use it up in (ml, g). New products: default the sale unit.'
    ),
  consumable_units_per_sale_unit: z
    .number()
    .positive()
    .max(1_000_000)
    .optional()
    .describe(
      'How many consumable units one sale unit holds (250 for 250 ml in a bottle). Needed when the units differ.'
    ),
  article: z.string().max(100).optional().describe('Article number.'),
  barcode: z.string().max(100).optional().describe('Barcode.'),
  print_title: z
    .string()
    .max(255)
    .optional()
    .describe('Name printed on the receipt; Altegio never shows it back.'),
  comment: z.string().max(1000).optional().describe('Comment on the card.'),
  critical_quantity: z
    .number()
    .min(0)
    .max(1_000_000)
    .optional()
    .describe('Stock, in sale units, under which it counts as running out.'),
  desired_quantity: z
    .number()
    .min(0)
    .max(1_000_000)
    .optional()
    .describe('Stock, in sale units, the location wants to hold.'),
};

// ========== output schemas ==========

const int = { type: ['integer', 'null'] as const };
const str = { type: ['string', 'null'] as const };
const bool = { type: 'boolean' as const };
const integer = { type: 'integer' as const };

const categorySchema = {
  type: 'object' as const,
  properties: { id: integer, title: str, parent_id: int, chain_category: bool },
  required: ['id', 'title', 'parent_id', 'chain_category'],
};

// ========== product categories ==========

export const productCategoriesListTool = defineTool({
  name: 'product_categories_list',
  category: 'Inventory',
  description:
    'The product categories of a location, the chain’s shared ones included, with the category each is nested in; optionally only those whose title contains query. Use the id as category_id of products_create and products_update. Paged: follow pagination.next_page.',
  annotations: { title: 'Inventory: list product categories', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    query: z.string().max(100).optional().describe('Part of the title.'),
    page: pageArg,
    page_size: pageSizeArg(100, 50),
  }),
  outputSchema: collectionSchema(categorySchema, { location_id: integer }),
  handler: async ({ input, client }) =>
    catalog.listProductCategories(client, input),
});

export const productCategoriesCreateTool = defineTool({
  name: 'product_categories_create',
  category: 'Inventory',
  description:
    'Create a product category, at the top level or inside parent_id. Refused when a category with the same title already sits under the same parent. Asks for confirmation first.',
  annotations: {
    title: 'Inventory: create a product category',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    title: z.string().trim().min(1).max(255).describe('Category title.'),
    parent_id: categoryId
      .optional()
      .describe('The category to nest it in. Default: the top level.'),
  }),
  confirm: {
    action: 'Create product category',
    target: (input) => `a product category at location ${input.location_id}`,
    consequence:
      'A new product category is added to the location’s product list. Delete it with product_categories_delete while it holds no products.',
    detail: (input, client) => catalog.describeCategoryCreate(client, input),
  },
  handler: async ({ input, client, confirmation }) =>
    catalog.createProductCategory(client, input, confirmation),
});

export const productCategoriesUpdateTool = defineTool({
  name: 'product_categories_update',
  category: 'Inventory',
  description:
    'Rename a product category or move it under another parent_id (0: the top level). Fields left out stay. Asks for confirmation first, showing before → after; refused if the category changes after that.',
  annotations: {
    title: 'Inventory: change a product category',
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    category_id: categoryId,
    title: z.string().trim().min(1).max(255).optional().describe('New title.'),
    parent_id: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('New parent category id; 0 moves it to the top level.'),
  }),
  confirm: {
    action: 'Change product category',
    target: (input) =>
      `product category ${input.category_id} at location ${input.location_id}`,
    resolve: (input, client) => catalog.describeCategory(client, input),
    consequence:
      'The category is stored with the new title or parent; its products stay in it.',
    detail: (input, client) => catalog.describeCategoryUpdate(client, input),
  },
  handler: async ({ input, client, confirmation }) =>
    catalog.updateProductCategory(client, input, confirmation),
});

export const productCategoriesDeleteTool = defineTool({
  name: 'product_categories_delete',
  category: 'Inventory',
  description:
    'Delete an empty product category. Refused while it holds products or other categories: move them first (products_update, product_categories_update); archived products do not count. Asks for confirmation first.',
  annotations: {
    title: 'Inventory: delete a product category',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({ location_id: locationId, category_id: categoryId }),
  confirm: {
    action: 'Delete product category',
    target: (input) =>
      `product category ${input.category_id} at location ${input.location_id}`,
    resolve: (input, client) => catalog.describeCategory(client, input),
    consequence:
      'The category leaves the location’s product list for good; Altegio refuses it while products or categories are filed under it.',
  },
  handler: async ({ input, client, confirmation }) =>
    catalog.deleteProductCategory(client, input, confirmation),
});

// ========== creating ==========

const newProduct = z
  .object({
    title: z.string().trim().min(1).max(255).describe('Product name.'),
    category_id: categoryId,
    ...productFields,
  })
  .strict();

export const productsCreateTool = defineTool({
  name: 'products_create',
  category: 'Inventory',
  description:
    'Create one or more product cards (up to 25, such as the new lines of a supplier invoice): name, product category, sale and cost price in the location currency, sale and consumable units, article number, barcode. Each line is first checked against the existing products: a same barcode, article number or title refuses the call and names the product, or with skip_existing only skips that line, so a repeated call creates nothing twice; products_search finds similar names. Stock is not changed: record a product receipt with inventory_create_operation. Asks for confirmation first.',
  annotations: {
    title: 'Inventory: create products',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    products: z
      .array(newProduct)
      .min(1)
      .max(25)
      .describe('The products to create.'),
    skip_existing: z
      .boolean()
      .default(false)
      .describe(
        'true: create only the lines that do not exist yet. Default false: an existing line refuses the call.'
      ),
  }),
  confirm: {
    action: 'Create products',
    target: (input) =>
      `${input.products?.length ?? 0} product card(s) at location ${input.location_id}`,
    consequence:
      'New product cards are added to the location’s product list with the prices and units below; no stock moves. Archive one created by mistake with products_archive.',
    detail: (input, client) => catalog.describeProductsCreate(client, input),
  },
  handler: async ({ input, client, confirmation }) =>
    catalog.createProducts(client, input, confirmation),
});

export const productsUpdateTool = defineTool({
  name: 'products_update',
  category: 'Inventory',
  description:
    'Change a product card: name, product category, sale or cost price, units, article number, barcode, receipt name, comment, critical and desired stock. Fields left out stay. A unit change on a product whose stock has moved converts its past operations by Altegio’s rules. Membership and gift card products are refused. Asks for confirmation first, showing before → after; refused if the card changes after that.',
  annotations: {
    title: 'Inventory: change a product',
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    product_id: productId,
    title: z.string().trim().min(1).max(255).optional().describe('New name.'),
    category_id: categoryId.optional(),
    ...productFields,
  }),
  confirm: {
    action: 'Change product',
    target: (input) =>
      `product ${input.product_id} at location ${input.location_id}`,
    resolve: (input, client) => catalog.describeProduct(client, input),
    consequence:
      'The product card is stored with the changes below; every later sale, receipt and consumption uses them. Past documents keep their prices.',
    detail: (input, client) => catalog.describeProductUpdate(client, input),
  },
  handler: async ({ input, client, confirmation }) =>
    catalog.updateProduct(client, input, confirmation),
});

export const productsArchiveTool = defineTool({
  name: 'products_archive',
  category: 'Inventory',
  description:
    'Archive a product: it leaves products_search, sales and receipts, while its past inventory operations stay. The API offers no way back. Asks for confirmation first, naming the stock it still holds.',
  annotations: {
    title: 'Inventory: archive a product',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({ location_id: locationId, product_id: productId }),
  confirm: {
    action: 'Archive product',
    target: (input) =>
      `product ${input.product_id} at location ${input.location_id}`,
    resolve: (input, client) => catalog.describeProduct(client, input),
    consequence:
      'The product is archived: it can no longer be sold, received or used, and no API call brings it back. Its past inventory operations and documents stay.',
    detail: (input, client) => catalog.describeProductArchive(client, input),
  },
  handler: async ({ input, client, confirmation }) =>
    catalog.archiveProduct(client, input, confirmation),
});
