/**
 * Pieces every inventory use case shares: the ports, money and quantity
 * rendering, product resolution by id or by name, and the default inventory.
 *
 * Free text — product, inventory, Bill of Materials and Supplier titles,
 * document comments — is other people's text. It never goes into our own
 * summary lines; it is keyed back to them by id inside the untrusted block
 * (`withUntrustedBlock`). Unit labels ("ml", "pcs") are short and part of a
 * quantity, so they stay in our lines, cleaned and capped (`unitLabel`).
 */
import { roundMajor } from '../../api/money.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import { InventoryAdapter } from '../../api/v1/inventory-adapter.js';
import { ProductsAdapter } from '../../api/v2/products-adapter.js';
import { resolveLocationCurrency } from '../../api/v1/location-currency.js';
import type {
  Inventory,
  InventoryApi,
  Product,
  ProductsApi,
} from '../../api/inventory-api.js';
import { sanitizeUntrusted } from '../../tools/tool-result.js';
import { InventoryInputError } from './errors.js';

export interface InventoryResult {
  text: string;
  structuredContent: unknown;
  isError?: boolean;
}

export function inventoryApi(client: AltegioClient): InventoryApi {
  return InventoryAdapter.forClient(client);
}

export function productsApi(client: AltegioClient): ProductsApi {
  return ProductsAdapter.forClient(client);
}

/** Longest title kept inside an untrusted block. */
export const FIELD_MAX_CHARS = 200;

/** The ISO code of the location's currency, or null when it cannot be read. */
export async function locationCurrency(
  client: AltegioClient,
  locationId: number
): Promise<string | null> {
  try {
    return await resolveLocationCurrency(client, locationId);
  } catch {
    return null;
  }
}

/** Round money and quantities to the two decimals the API stores. */
export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** `30 CZK`, or `30 (currency not reported)`. */
export function money(value: number | null, currency: string | null): string {
  if (value === null) return 'not reported';
  return `${roundMajor(value)} ${currency ?? '(currency not reported)'}`;
}

/** A unit label as it may appear inside our own sentence. */
export function unitLabel(unit: string | null | undefined): string {
  return sanitizeUntrusted(unit ?? '', { maxChars: 16 }) ?? 'units';
}

/** `2.5 ml`. */
export function quantity(value: number | null, unit: string | null): string {
  return value === null
    ? 'quantity not reported'
    : `${round2(value)} ${unitLabel(unit)}`;
}

/** Run `fn` over `items`, at most `limit` at a time, keeping the order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

/** How a line names its product: by id, or by name, article number or barcode. */
export interface ProductRef {
  product_id?: number;
  product?: string;
}

/**
 * The one product a line means. By id it is read directly; by text it is
 * searched, and the text must name exactly one product — an exact title match
 * among the results, or a single result. Anything else is refused with the
 * candidates' ids, so the agent asks instead of guessing.
 */
export async function resolveProduct(
  products: ProductsApi,
  locationId: number,
  ref: ProductRef,
  where: string
): Promise<Product> {
  if ((ref.product_id === undefined) === (ref.product === undefined)) {
    throw new InventoryInputError(
      `${where} needs exactly one of product_id or product (a name, article number or barcode).`
    );
  }
  if (ref.product_id !== undefined) {
    return products.getProduct(locationId, ref.product_id, { stock: false });
  }
  const term = ref.product!.trim();
  if (term.length < 2) {
    throw new InventoryInputError(
      `${where}: product needs at least two characters; or pass product_id from products_search.`
    );
  }
  const found = await products.searchProducts(locationId, term, {
    page: 1,
    page_size: 10,
  });
  const exact = found.filter(
    (p) =>
      p.title !== null && p.title.trim().toLowerCase() === term.toLowerCase()
  );
  const match =
    exact.length === 1 ? exact[0] : found.length === 1 ? found[0] : undefined;
  if (match) {
    // The search result carries no cost price; the product read does.
    return products.getProduct(locationId, match.id, { stock: false });
  }
  if (found.length === 0) {
    throw new InventoryInputError(
      `${where}: no product matches the given product text. Search with products_search and pass product_id.`
    );
  }
  throw new InventoryInputError(
    `${where}: the product text matches ${found.length}${found.length === 10 ? '+' : ''} products (ids ${found.map((p) => p.id).join(', ')}). Ask which one is meant, then pass its product_id.`
  );
}

/** Which inventory a write goes to when the caller names none. */
export function defaultInventory(
  inventories: readonly Inventory[],
  purpose: 'sale' | 'consumables' | null,
  where: string
): Inventory {
  const candidates =
    purpose === 'sale'
      ? inventories.filter((i) => i.for_sale)
      : purpose === 'consumables'
        ? inventories.filter((i) => i.for_consumables)
        : [];
  if (candidates.length === 1) return candidates[0]!;
  const ids = (candidates.length > 0 ? candidates : inventories)
    .map((i) => i.id)
    .join(', ');
  throw new InventoryInputError(
    `${where} needs inventory_id: ${
      purpose === null
        ? 'this kind of operation has no default inventory'
        : `the location has ${candidates.length === 0 ? 'no' : candidates.length} inventories ${purpose === 'sale' ? 'for sale' : 'for consumables'}`
    }. Inventory ids: ${ids || 'none'} (names: inventory_list).`
  );
}

/** The inventory with this id, or a refusal naming the location's inventories. */
export function knownInventory(
  inventories: readonly Inventory[],
  inventoryId: number,
  locationId: number
): Inventory {
  const found = inventories.find((i) => i.id === inventoryId);
  if (found) return found;
  throw new InventoryInputError(
    `Inventory ${inventoryId} is not an inventory of location ${locationId}. Its inventories: ${inventories.map((i) => i.id).join(', ') || 'none'} (names: inventory_list).`
  );
}
