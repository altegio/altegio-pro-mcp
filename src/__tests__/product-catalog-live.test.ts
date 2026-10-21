/**
 * Opt-in live suite for the product catalog tools, through the real
 * `tools/call` path of a host without elicitation: a product category and two
 * products are created, matched, changed and archived again, and the category
 * deleted, so the location's product list reads as before. No stock moves.
 *
 * Skipped unless `ALTEGIO_E2E=1`. It needs only `ALTEGIO_E2E_LOCATION_ID`, a
 * disposable test location; credentials come from the environment, never a
 * file in this public repo.
 *
 *   ALTEGIO_E2E=1 CREDENTIALS_DIR=/tmp/altegio-mcp-live \
 *     ALTEGIO_API_TOKEN=… ALTEGIO_USER_TOKEN=… ALTEGIO_E2E_LOCATION_ID=… \
 *     npx jest --testPathPatterns='product-catalog-live\.test\.ts$'
 */
import type { AltegioClient } from '../providers/altegio-client.js';
import { httpFromClient } from '../api/altegio-http.js';
import {
  describeLive,
  liveClient,
  liveHost,
  liveIds,
  textOf,
  type LiveHost,
} from './helpers/live.js';

interface Card {
  id: number;
  title: string | null;
  category_id: number | null;
  sale_price: number | null;
  cost_price: number | null;
  consumable_units_per_sale_unit: number | null;
  barcode: string | null;
}

describeLive('product catalog tools against the test location', () => {
  let ids: Record<'LOCATION_ID', number>;
  let altegio: AltegioClient;
  let host: LiveHost;
  const stamp = Date.now();
  const made = { category: 0, products: [] as number[] };

  beforeAll(async () => {
    ids = liveIds(['LOCATION_ID']);
    altegio = liveClient();
    host = await liveHost(altegio, 'product-catalog-live');
  });

  // Whatever a failed run left behind goes, straight through the API.
  afterAll(async () => {
    const at = ids?.LOCATION_ID;
    const http = altegio && httpFromClient(altegio);
    for (const product of made.products) {
      await http
        .request(`/locations/${at}/products/${product}`, {
          method: 'DELETE',
        })
        .catch(() => undefined);
    }
    if (made.category) {
      await http
        .request(`/locations/${at}/product_categories/${made.category}`, {
          method: 'DELETE',
        })
        .catch(() => undefined);
    }
    await host?.close();
  });

  const at = () => ({ location_id: ids.LOCATION_ID });

  const confirmedRun = async (tool: string, args: Record<string, unknown>) => {
    const asked = await host.confirmed(tool, args);
    const result = await asked.run();
    if (result.isError) {
      throw new Error(`${tool} failed: ${textOf(result).slice(0, 400)}`);
    }
    return { result, asked };
  };

  const categoryIds = async () =>
    (
      await host.read<{ items: Array<{ id: number }> }>(
        'product_categories_list',
        { ...at(), query: `catalog-live ${stamp}`, page_size: 100 }
      )
    ).items.map((c) => c.id);

  it('creates, matches, changes and archives products in a category of their own', async () => {
    // --- a category ---
    const category = await confirmedRun('product_categories_create', {
      ...at(),
      title: `catalog-live ${stamp}`,
    });
    made.category = (
      category.result.structuredContent as { category: { id: number } }
    ).category.id;
    expect(await categoryIds()).toEqual([made.category]);

    // --- two products: one with whole-number prices in float fields ---
    const units = await host.read<{
      items: Array<{ id: number; short_title: string | null }>;
    }>('products_list_units', at());
    expect(units.items.some((u) => u.short_title === 'ml')).toBe(true);

    const products = [
      {
        title: `catalog-live shampoo ${stamp}`,
        category_id: made.category,
        sale_price: 300,
        cost_price: 120,
        sale_unit: 'pcs',
        consumable_unit: 'ml',
        consumable_units_per_sale_unit: 250,
        barcode: `CL${stamp}`,
      },
      { title: `catalog-live comb ${stamp}`, category_id: made.category },
    ];
    const create = await host.confirmed('products_create', {
      ...at(),
      products,
    });
    const createdResult = await create.run();
    expect(createdResult.isError).toBeFalsy();
    const created = (
      createdResult.structuredContent as {
        created: Array<Card & { line: number }>;
      }
    ).created;
    made.products = created.map((c) => c.id);
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      sale_price: 300,
      cost_price: 120,
      consumable_units_per_sale_unit: 250,
      barcode: `CL${stamp}`,
    });

    // The same confirmed call again creates nothing: both lines exist now.
    const repeat = await create.run();
    expect(repeat.isError).toBe(true);
    expect(textOf(repeat)).toMatch(/already exists/);

    // --- matching an invoice line by barcode, another by title ---
    const matched = await host.read<{
      items: Array<{
        exists: boolean;
        matches: Array<{ product_id: number; match: string }>;
      }>;
    }>('products_find_matches', {
      ...at(),
      lines: [
        { barcode: `cl${stamp}` },
        { title: `CATALOG-LIVE COMB ${stamp}` },
        { title: `catalog-live nothing ${stamp}` },
      ],
    });
    expect(matched.items[0]!.matches[0]).toEqual(
      expect.objectContaining({ product_id: created[0]!.id, match: 'barcode' })
    );
    expect(matched.items[1]!.matches[0]).toEqual(
      expect.objectContaining({ product_id: created[1]!.id, match: 'title' })
    );
    expect(matched.items[2]!.exists).toBe(false);

    // --- a price and a ratio change, read back ---
    await confirmedRun('products_update', {
      ...at(),
      product_id: created[0]!.id,
      sale_price: 320,
      consumable_units_per_sale_unit: 200,
    });
    const found = await host.read<{ items: Card[] }>('products_search', {
      ...at(),
      product_ids: [created[0]!.id],
      include_stock: false,
    });
    expect(found.items[0]).toMatchObject({
      sale_price: 320,
      cost_price: 120,
      consumable_units_per_sale_unit: 200,
    });

    // --- the category renamed; its products stay in it ---
    await confirmedRun('product_categories_update', {
      ...at(),
      category_id: made.category,
      title: `catalog-live ${stamp} renamed`,
    });
    expect(await categoryIds()).toEqual([made.category]);

    // A category holding products cannot be deleted.
    const early = await host.confirmed('product_categories_delete', {
      ...at(),
      category_id: made.category,
    });
    const refused = await early.run();
    expect(refused.isError).toBe(true);

    // --- archive both, then a repeat is a no-op ---
    for (const product of made.products) {
      const archived = await confirmedRun('products_archive', {
        ...at(),
        product_id: product,
      });
      expect(archived.result.structuredContent).toMatchObject({
        outcome: 'archived',
      });
      const again = await archived.asked.run();
      expect(again.structuredContent).toMatchObject({
        outcome: 'already_archived',
      });
    }
    const gone = await host.call('products_search', {
      ...at(),
      product_ids: made.products,
      include_stock: false,
    });
    expect(
      (gone.structuredContent as { items?: unknown[] } | undefined)?.items ?? []
    ).toEqual([]);

    // --- the empty category goes ---
    await confirmedRun('product_categories_delete', {
      ...at(),
      category_id: made.category,
    });
    expect(await categoryIds()).toEqual([]);
    made.category = 0;
    made.products = [];
  }, 240_000);
});
