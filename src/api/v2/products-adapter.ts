/**
 * V2 adapter for the `ProductsApi` port.
 *
 * Products are read on V2 (`/locations/{id}/products…`, JSON:API), which
 * supersedes the V1 product list and search. The wire vocabulary — resource
 * type `good`, `cost` for the sale price, `actual_cost` for the cost price,
 * `good_storage_amount`, `storage_id` — stops here.
 *
 * Contract details verified on a live location (2026-10-19):
 *
 * - `include[]` must be sent with brackets; a repeated bare `include` keeps
 *   only the last value.
 * - The list carries no stock; one product read with
 *   `include[]=storage_amounts` returns its stock in every inventory, and
 *   `include[]=actual_cost` its cost price (null without the right to see it).
 *   Stock can be negative.
 * - No list reports a total; a page that comes back full may continue.
 * - The search term (`filter[term]`) needs two characters and matches the name,
 *   the article number or the barcode.
 */
import type { AltegioHttp } from '../altegio-http.js';
import { httpFromClient } from '../altegio-http.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import { mapInventoryHttpError } from '../../capabilities/inventory/errors.js';
import type {
  Product,
  ProductStock,
  ProductUnit,
  ProductWithStock,
  ProductsApi,
} from '../inventory-api.js';
import {
  callJsonApi,
  IncludedIndex,
  primaryList,
  primaryOne,
  relationshipRefs,
  type JsonApiResource,
} from './jsonapi-http.js';

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function id(value: unknown): number | null {
  const n = num(value);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function productFromWire(resource: JsonApiResource): Product {
  const a = resource.attributes ?? {};
  return {
    id: id(resource.id) ?? 0,
    title: text(a.title),
    category_id: id(a.category_id),
    sale_price: num(a.cost),
    cost_price: num(a.actual_cost),
    sale_unit_id: id(a.sale_unit_id),
    consumable_unit_id: id(a.consumable_unit_id),
    consumable_units_per_sale_unit: num(a.sale_unit_to_consumable_unit_ratio),
    loyalty_kind:
      id(a.loyalty_abonement_type_id) !== null
        ? 'membership'
        : id(a.loyalty_certificate_type_id) !== null
          ? 'gift_card'
          : null,
    chain_product: a.is_chain === true,
  };
}

function stockFromWire(resource: JsonApiResource): ProductStock | null {
  const a = resource.attributes ?? {};
  const inventoryId = id(a.storage_id);
  if (inventoryId === null) return null;
  return {
    inventory_id: inventoryId,
    sale_quantity: num(a.sale_amount),
    consumable_quantity: num(a.consumable_amount),
  };
}

export class ProductsAdapter implements ProductsApi {
  constructor(private readonly http: AltegioHttp) {}

  static forClient(client: AltegioClient): ProductsAdapter {
    return new ProductsAdapter(httpFromClient(client));
  }

  async listProducts(
    locationId: number,
    query: { product_ids?: readonly number[]; page: number; page_size: number }
  ): Promise<Product[]> {
    const doc = await callJsonApi(
      this.http,
      `/locations/${locationId}/products`,
      {
        context: `list the products of location ${locationId}`,
        query: {
          'filter[ids][]': query.product_ids?.length
            ? query.product_ids
            : undefined,
          page: query.page,
          limit: query.page_size,
          'include[]': ['actual_cost'],
        },
        mapError: mapInventoryHttpError,
      }
    );
    return primaryList(doc).map(productFromWire);
  }

  async searchProducts(
    locationId: number,
    term: string,
    query: { page: number; page_size: number }
  ): Promise<Product[]> {
    const doc = await callJsonApi(
      this.http,
      `/locations/${locationId}/products/autocomplete`,
      {
        context: `search the products of location ${locationId}`,
        query: {
          'filter[term]': term,
          page: query.page,
          limit: query.page_size,
        },
        mapError: (status, body, context) =>
          mapInventoryHttpError(status, body, context, {
            invalid:
              'Search by at least two characters of a product name, article number or barcode, without emoji.',
          }),
      }
    );
    return primaryList(doc).map(productFromWire);
  }

  async getProduct(
    locationId: number,
    productId: number,
    options: { stock: boolean }
  ): Promise<ProductWithStock> {
    const doc = await callJsonApi(
      this.http,
      `/locations/${locationId}/products/${productId}`,
      {
        context: `read product ${productId} of location ${locationId}`,
        query: {
          'include[]': options.stock
            ? ['actual_cost', 'storage_amounts']
            : ['actual_cost'],
        },
        mapError: (status, body, context) =>
          mapInventoryHttpError(status, body, context, {
            notFound:
              'Check the product id with products_search; a deleted product cannot be read.',
          }),
      }
    );
    const resource = primaryOne(doc);
    if (!resource) {
      throw mapInventoryHttpError(404, undefined, `read product ${productId}`);
    }
    const product = productFromWire(resource);
    if (!options.stock) return { ...product, stock: null };
    const included = new IncludedIndex(doc?.included ?? []);
    const stock = relationshipRefs(resource, 'storage_amounts')
      .map((ref) => included.get(ref.type, ref.id))
      .filter((r): r is JsonApiResource => r !== undefined)
      .map(stockFromWire)
      .filter((s): s is ProductStock => s !== null);
    return { ...product, stock };
  }

  async listUnits(locationId: number): Promise<ProductUnit[]> {
    const doc = await callJsonApi(this.http, `/locations/${locationId}/units`, {
      context: `list the product units of location ${locationId}`,
      mapError: mapInventoryHttpError,
    });
    return primaryList(doc).map((resource) => ({
      id: id(resource.id) ?? 0,
      title: text(resource.attributes?.title),
      short_title: text(resource.attributes?.short_title),
    }));
  }
}
