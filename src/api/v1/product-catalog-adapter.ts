/**
 * Adapter for the `ProductCatalogApi` port: product cards and product
 * categories.
 *
 * V2 reads the categories (`/locations/{id}/product_categories`) but writes
 * neither products nor categories, so the writes and the full product card run
 * on V1, on the canonical `/locations/{id}/products…` and
 * `/locations/{id}/product_categories…` URLs the spec documents. The wire
 * vocabulary — `good`, `cost` for the sale price, `actual_cost` for the cost
 * price, `unit_id`/`sale_unit_id`, `service_unit_id`, `unit_equals`,
 * `critical_amount`, `parent_category_id` — stops here.
 *
 * Contract details verified live on the test location (2026-10-21):
 *
 * - Create and update refuse an integer in a float field with 422 "The value
 *   type must be float" (`cost`, `actual_cost`, `unit_equals`,
 *   `critical_amount`, `desired_amount`), so those go out as `10.0`.
 * - Update needs `title`, `category_id`, `sale_unit_id` and `service_unit_id`
 *   on every call; a field left out keeps its value. The read names the sale
 *   unit `unit_id`, the write `sale_unit_id`.
 * - `DELETE` archives (204): the product leaves the lists, the search and the
 *   V2 read, while the V1 read still answers. A second `DELETE` answers 404.
 *   There is no way back through the API.
 * - A category update needs `title`; a parent left out is kept. `DELETE` is
 *   soft (the V2 read still answers, the list drops it) and is refused with
 *   400 while the category holds a product or another category; an archived
 *   product does not count.
 * - The V2 category list ignores `page` and `limit` and returns every
 *   category of the location, the chain's shared ones included.
 * - V1 has no idempotency header, so the write methods ignore the
 *   `idempotency_key` of their `WriteOptions` (`../write-options.ts`).
 */
import { httpFromClient, type AltegioHttp } from '../altegio-http.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import { majorOf } from '../money.js';
import { mapInventoryHttpError } from '../../capabilities/inventory/errors.js';
import {
  callJsonApi,
  primaryList,
  type JsonApiResource,
} from '../v2/jsonapi-http.js';
import { asRow, id, num, text, v1Call, v1Read, type Row } from './envelope.js';
import type {
  ProductCard,
  ProductCardWrite,
  ProductCatalogApi,
  ProductCategory,
  ProductCategoryWrite,
} from '../inventory-api.js';

/** The V1 product fields that must be written with a decimal point. */
const PRODUCT_FLOAT_FIELDS = [
  'cost',
  'actual_cost',
  'unit_equals',
  'critical_amount',
  'desired_amount',
] as const;

/**
 * The unit conversion rules a unit change needs once stock has moved: one per
 * operation type in type order (sale, consumption, receipt, write-off,
 * transfer), each naming the unit whose quantity is kept. These are Altegio's
 * own defaults.
 */
const CORRECTION_RULES = [
  { type: 1, base_unit: 'service' },
  { type: 2, base_unit: 'service' },
  { type: 3, base_unit: 'sale' },
  { type: 4, base_unit: 'sale' },
  { type: 5, base_unit: 'sale' },
];

function categoryFromV2(resource: JsonApiResource): ProductCategory {
  const a = resource.attributes ?? {};
  return {
    id: id(resource.id) ?? 0,
    title: text(a.title),
    parent_id: id(a.parent_category_id),
    chain_category: a.is_chain === true,
  };
}

function categoryFromV1(row: Row): ProductCategory {
  return {
    id: id(row.id) ?? 0,
    title: text(row.title),
    parent_id: id(row.parent_category_id),
    chain_category: row.is_chain === true || row.is_chain === 1,
  };
}

function cardFromWire(row: Row): ProductCard {
  const abonement = id(row.loyalty_abonement_type_id);
  const certificate = id(row.loyalty_certificate_type_id);
  // An empty barcode reads back as "0".
  const barcode = text(row.barcode);
  return {
    id: id(row.good_id ?? row.id) ?? 0,
    title: text(row.title),
    category_id: id(row.category_id),
    sale_price: num(row.cost),
    cost_price: num(row.actual_cost),
    sale_unit_id: id(row.unit_id ?? row.sale_unit_id),
    consumable_unit_id: id(row.service_unit_id),
    consumable_units_per_sale_unit: num(row.unit_equals),
    loyalty_kind:
      abonement !== null
        ? 'membership'
        : certificate !== null
          ? 'gift_card'
          : null,
    chain_product: row.is_chain === true || row.is_chain === 1,
    article: text(row.article),
    barcode: barcode === '0' ? null : barcode,
    comment: text(row.comment),
    critical_quantity: num(row.critical_amount),
    desired_quantity: num(row.desired_amount),
  };
}

function productBody(product: ProductCardWrite): Row {
  return {
    title: product.title,
    category_id: product.category_id,
    sale_unit_id: product.sale_unit_id,
    service_unit_id: product.consumable_unit_id,
    unit_equals: product.consumable_units_per_sale_unit,
    ...(product.sale_price ? { cost: majorOf(product.sale_price) } : {}),
    ...(product.cost_price ? { actual_cost: majorOf(product.cost_price) } : {}),
    ...(product.article !== undefined ? { article: product.article } : {}),
    ...(product.barcode !== undefined ? { barcode: product.barcode } : {}),
    ...(product.print_title !== undefined
      ? { print_title: product.print_title }
      : {}),
    ...(product.comment !== undefined ? { comment: product.comment } : {}),
    ...(product.critical_quantity !== undefined
      ? { critical_amount: product.critical_quantity }
      : {}),
    ...(product.desired_quantity !== undefined
      ? { desired_amount: product.desired_quantity }
      : {}),
  };
}

const PRODUCT_WRITE_HINTS = {
  invalid:
    'Check the category id with product_categories_list and the unit ids with api_call_operation list_product_units; sale and cost prices are in the location currency.',
  notFound:
    'Check the product id with products_search and the category id with product_categories_list.',
  forbidden:
    'Changing products needs the right to edit products at the location; ask the location owner for it.',
};

export class ProductCatalogAdapter implements ProductCatalogApi {
  constructor(private readonly http: AltegioHttp) {}

  static forClient(client: AltegioClient): ProductCatalogAdapter {
    return new ProductCatalogAdapter(httpFromClient(client));
  }

  async listCategories(locationId: number): Promise<ProductCategory[]> {
    const doc = await callJsonApi(
      this.http,
      `/locations/${locationId}/product_categories`,
      {
        context: `list the product categories of location ${locationId}`,
        mapError: mapInventoryHttpError,
      }
    );
    return primaryList(doc).map(categoryFromV2);
  }

  async createCategory(
    locationId: number,
    category: ProductCategoryWrite
  ): Promise<ProductCategory> {
    const { data } = await v1Read(
      this.http,
      `/locations/${locationId}/product_categories`,
      `create a product category at location ${locationId}`,
      mapInventoryHttpError,
      {
        method: 'POST',
        body: {
          title: category.title,
          ...(category.parent_id !== null
            ? { parent_category_id: category.parent_id }
            : {}),
        },
        hints: {
          notFound:
            'Check the parent category id with product_categories_list.',
        },
      }
    );
    return categoryFromV1(asRow(data));
  }

  async updateCategory(
    locationId: number,
    categoryId: number,
    category: ProductCategoryWrite
  ): Promise<ProductCategory> {
    const { data } = await v1Read(
      this.http,
      `/locations/${locationId}/product_categories/${categoryId}`,
      `change product category ${categoryId} of location ${locationId}`,
      mapInventoryHttpError,
      {
        method: 'PUT',
        body: {
          title: category.title,
          parent_category_id: category.parent_id ?? 0,
        },
        hints: {
          notFound:
            'Check the category ids with product_categories_list; a deleted category cannot be changed.',
        },
      }
    );
    return categoryFromV1(asRow(data));
  }

  async deleteCategory(locationId: number, categoryId: number): Promise<void> {
    await v1Call(
      this.http,
      `/locations/${locationId}/product_categories/${categoryId}`,
      `delete product category ${categoryId} of location ${locationId}`,
      mapInventoryHttpError,
      {
        method: 'DELETE',
        hints: {
          invalid:
            'A category that holds products or other categories cannot be deleted: move them to another category with products_update and product_categories_update first.',
          notFound:
            'Check the category id with product_categories_list; it may be deleted already.',
        },
      }
    );
  }

  async getProductCard(
    locationId: number,
    productId: number
  ): Promise<ProductCard> {
    const { data } = await v1Read(
      this.http,
      `/locations/${locationId}/products/${productId}`,
      `read product ${productId} of location ${locationId}`,
      mapInventoryHttpError,
      {
        hints: {
          notFound: 'Check the product id with products_search.',
        },
      }
    );
    return cardFromWire(asRow(data));
  }

  async createProduct(
    locationId: number,
    product: ProductCardWrite
  ): Promise<ProductCard> {
    const { data } = await v1Read(
      this.http,
      `/locations/${locationId}/products`,
      `create a product at location ${locationId}`,
      mapInventoryHttpError,
      {
        method: 'POST',
        body: productBody(product),
        floatFields: PRODUCT_FLOAT_FIELDS,
        hints: PRODUCT_WRITE_HINTS,
      }
    );
    return cardFromWire(asRow(data));
  }

  async updateProduct(
    locationId: number,
    productId: number,
    product: ProductCardWrite,
    options: { unit_change?: boolean } = {}
  ): Promise<ProductCard> {
    const { data } = await v1Read(
      this.http,
      `/locations/${locationId}/products/${productId}`,
      `change product ${productId} of location ${locationId}`,
      mapInventoryHttpError,
      {
        method: 'PUT',
        body: {
          ...productBody(product),
          ...(options.unit_change
            ? { correction_rules: CORRECTION_RULES }
            : {}),
        },
        floatFields: PRODUCT_FLOAT_FIELDS,
        hints: {
          ...PRODUCT_WRITE_HINTS,
          invalid:
            'Check the category and unit ids; a unit change on a chain product is made in the chain.',
        },
      }
    );
    return cardFromWire(asRow(data));
  }

  async archiveProduct(
    locationId: number,
    productId: number
  ): Promise<'archived' | 'already_archived'> {
    const answer = await v1Call(
      this.http,
      `/locations/${locationId}/products/${productId}`,
      `archive product ${productId} of location ${locationId}`,
      mapInventoryHttpError,
      {
        method: 'DELETE',
        tolerate: [404],
        hints: PRODUCT_WRITE_HINTS,
      }
    );
    return answer === null ? 'already_archived' : 'archived';
  }
}
