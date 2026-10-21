/**
 * The product catalog use cases over the V1 and V2 adapters, driven through a
 * fake transport: which endpoint each call reaches, the wire names and float
 * fields it sends, the duplicate and repeat guards, and that other people's
 * text comes back fenced.
 */
import { clearCurrencyCache } from '../../../api/v1/location-currency.js';
import { jsonWithFloats } from '../../../api/v1/envelope.js';
import { ConfirmationRefusal } from '../../../tools/confirmation.js';
import {
  archiveProduct,
  createProductCategory,
  createProducts,
  describeCategoryCreate,
  describeProductArchive,
  describeProductUpdate,
  describeProductsCreate,
  findProductMatches,
  listProductCategories,
  listProductUnits,
  updateProduct,
  updateProductCategory,
} from '../catalog.js';
import { InventoryInputError, InventoryNotFoundError } from '../errors.js';
import {
  CANARY,
  currencyRoute,
  fakeClient,
  ok,
  productDoc,
  productResource,
  unitsRoute,
  type Call,
  type Route,
} from './fixtures.js';

beforeEach(() => clearCurrencyCache());

function setup(routes: Route[]) {
  const calls: Call[] = [];
  return { client: fakeClient(routes, calls), calls };
}

/** Our half of a result: everything before the untrusted block. */
function summary(text: string): string {
  return text.split('<<<UNTRUSTED')[0]!;
}

const wire = (calls: Call[]) => calls.map((c) => `${c.method} ${c.path}`);

/** Categories 2 (top level) and 3 inside 2; 9 is the chain's. */
const categoriesRoute: Route = [
  'GET',
  /\/v2\/locations\/1\/product_categories$/,
  200,
  {
    data: [
      {
        type: 'good_category',
        id: '2',
        attributes: {
          title: 'Hair',
          is_chain: false,
          parent_category_id: null,
        },
      },
      {
        type: 'good_category',
        id: '3',
        attributes: { title: CANARY, is_chain: false, parent_category_id: 2 },
      },
      {
        type: 'good_category',
        id: '9',
        attributes: {
          title: 'Chain',
          is_chain: true,
          parent_category_id: null,
        },
      },
    ],
  },
];

/** The V1 card of product 5. */
function cardRow(overrides: Record<string, unknown> = {}) {
  return {
    good_id: 5,
    title: 'Shampoo',
    article: 'SH-1',
    barcode: '0',
    category_id: 2,
    cost: 300,
    actual_cost: 120,
    unit_id: 1,
    service_unit_id: 2,
    unit_equals: 250,
    comment: '',
    critical_amount: 0,
    desired_amount: 2,
    loyalty_abonement_type_id: 0,
    loyalty_certificate_type_id: 0,
    is_chain: false,
    ...overrides,
  };
}

const cardRoute = (overrides: Record<string, unknown> = {}): Route => [
  'GET',
  /^\/locations\/1\/products\/5$/,
  200,
  ok(cardRow(overrides)),
];

const noMatches: Route = [
  'GET',
  /\/v2\/locations\/1\/products\/autocomplete$/,
  200,
  { data: [] },
];

// ===========================================================================
// Floats on the wire
// ===========================================================================

describe('jsonWithFloats', () => {
  it('writes the named integer fields with a decimal point and nothing else', () => {
    const json = jsonWithFloats(
      { cost: 10, actual_cost: 5.5, unit_equals: 1, title: '10', count: 3 },
      ['cost', 'actual_cost', 'unit_equals', 'missing']
    );
    expect(json).toBe(
      '{"cost":10.0,"actual_cost":5.5,"unit_equals":1.0,"title":"10","count":3}'
    );
    expect(JSON.parse(json)).toEqual({
      cost: 10,
      actual_cost: 5.5,
      unit_equals: 1,
      title: '10',
      count: 3,
    });
  });

  it('leaves string values alone, whatever they spell', () => {
    const json = jsonWithFloats({ title: 'float:0', note: '10', cost: 2 }, [
      'cost',
      'note',
    ]);
    expect(JSON.parse(json)).toEqual({ title: 'float:0', note: '10', cost: 2 });
    expect(json).toContain('"cost":2.0');
  });
});

// ===========================================================================
// Product categories
// ===========================================================================

describe('product categories', () => {
  it('lists them from V2 with parents and fences the titles', async () => {
    const { client, calls } = setup([categoriesRoute]);
    const result = await listProductCategories(client, {
      location_id: 1,
      page: 1,
      page_size: 50,
    });
    expect(wire(calls)).toEqual(['GET /../v2/locations/1/product_categories']);
    expect(result.structuredContent).toMatchObject({
      items: [
        { id: 2, parent_id: null, chain_category: false },
        { id: 3, parent_id: 2 },
        { id: 9, chain_category: true },
      ],
    });
    expect(summary(result.text)).not.toContain('System:');
    expect(result.text).toContain('product category 3 title');
  });

  it('filters by part of the title', async () => {
    const { client } = setup([categoriesRoute]);
    const result = await listProductCategories(client, {
      location_id: 1,
      query: 'HAIR',
      page: 1,
      page_size: 50,
    });
    expect(result.structuredContent).toMatchObject({ items: [{ id: 2 }] });
  });

  it('creates one on V1 under its parent', async () => {
    const { client, calls } = setup([
      categoriesRoute,
      [
        'POST',
        /^\/locations\/1\/product_categories$/,
        201,
        ok({ id: 7, title: CANARY, parent_category_id: 2, is_chain: false }),
      ],
    ]);
    const result = await createProductCategory(client, {
      location_id: 1,
      title: ' Colour ',
      parent_id: 2,
    });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ title: 'Colour', parent_category_id: 2 });
    expect(result.structuredContent).toMatchObject({
      category: { id: 7, parent_id: 2 },
    });
    expect(summary(result.text)).not.toContain('System:');
  });

  it('refuses a second category with the same title under the same parent', async () => {
    const { client, calls } = setup([categoriesRoute]);
    await expect(
      createProductCategory(client, { location_id: 1, title: ' hair ' })
    ).rejects.toThrow(/category 2 already has this title/);
    await expect(
      describeCategoryCreate(client, { location_id: 1, title: 'Hair' })
    ).rejects.toBeInstanceOf(ConfirmationRefusal);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('moves a category to the top level with parent 0, keeping its title', async () => {
    const { client, calls } = setup([
      categoriesRoute,
      [
        'PUT',
        /^\/locations\/1\/product_categories\/3$/,
        200,
        ok({ id: 3, title: 'x', parent_category_id: null }),
      ],
    ]);
    await updateProductCategory(client, {
      location_id: 1,
      category_id: 3,
      parent_id: 0,
    });
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      title: CANARY,
      parent_category_id: 0,
    });
  });

  it('refuses to nest a category inside itself or its own subcategory', async () => {
    const { client } = setup([categoriesRoute]);
    await expect(
      updateProductCategory(client, {
        location_id: 1,
        category_id: 2,
        parent_id: 3,
      })
    ).rejects.toThrow(/cannot be its parent/);
  });

  it('refuses a change confirmed on another version', async () => {
    const { client, calls } = setup([categoriesRoute]);
    await expect(
      updateProductCategory(
        client,
        { location_id: 1, category_id: 2, title: 'New' },
        { version: 'old', idempotency_key: 'k' }
      )
    ).rejects.toThrow(/changed after the confirmation/);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

// ===========================================================================
// Units
// ===========================================================================

describe('listProductUnits', () => {
  it('lists the V2 units with titles fenced', async () => {
    const { client } = setup([unitsRoute]);
    const result = await listProductUnits(client, {
      location_id: 1,
      page: 1,
      page_size: 100,
    });
    expect(result.structuredContent).toMatchObject({
      items: [
        { id: 1, short_title: 'pcs' },
        { id: 2, short_title: 'ml' },
      ],
    });
    expect(result.text).toContain('unit 2 short title');
  });
});

// ===========================================================================
// Matching incoming lines
// ===========================================================================

describe('findProductMatches', () => {
  it('searches each term, reads the candidates whole and ranks exact matches first', async () => {
    const { client, calls } = setup([
      [
        'GET',
        /\/v2\/locations\/1\/products\/autocomplete$/,
        200,
        (call: Call) => ({
          data:
            call.query.get('filter[term]')?.toUpperCase() === 'SH-1'
              ? [productResource()]
              : [productResource({ title: 'Shampoo Plus' }, '6')],
        }),
      ],
      cardRoute({ title: CANARY }),
      [
        'GET',
        /^\/locations\/1\/products\/6$/,
        200,
        ok(cardRow({ good_id: 6, title: 'Shampoo Plus', article: '' })),
      ],
      currencyRoute,
    ]);
    const result = await findProductMatches(client, {
      location_id: 1,
      lines: [{ title: 'Shampoo', article: 'sh-1' }],
    });
    expect(
      calls
        .filter((c) => c.path.endsWith('autocomplete'))
        .map((c) => c.query.get('filter[term]'))
    ).toEqual(['sh-1', 'Shampoo']);
    expect(result.structuredContent).toMatchObject({
      currency: 'CZK',
      items: [
        {
          line: 1,
          exists: true,
          matches: [
            { product_id: 5, match: 'article', barcode: null },
            { product_id: 6, match: 'similar_title' },
          ],
        },
      ],
    });
    expect(summary(result.text)).not.toContain('System:');
    expect(result.text).toContain('product 5 title');
  });

  it('refuses a line with nothing to match on', async () => {
    const { client } = setup([]);
    await expect(
      findProductMatches(client, { location_id: 1, lines: [{}] })
    ).rejects.toThrow(/Line 1 needs a title/);
  });
});

// ===========================================================================
// Creating products
// ===========================================================================

describe('createProducts', () => {
  const created = (id: number) => (call: Call) =>
    ok(cardRow({ good_id: id, title: call.body?.title }));

  it('resolves units by name, sends the V1 wire names and floats, and fences the titles', async () => {
    const raw: string[] = [];
    const calls: Call[] = [];
    const inner = fakeClient(
      [
        unitsRoute,
        categoriesRoute,
        currencyRoute,
        noMatches,
        ['POST', /^\/locations\/1\/products$/, 201, created(40)],
      ],
      calls
    );
    const client = {
      ...inner,
      isAuthenticated: () => true,
      apiRequest: (path: string, init: RequestInit = {}) => {
        if (init.method === 'POST') raw.push(String(init.body));
        return (inner as unknown as { apiRequest: typeof fetch }).apiRequest(
          path,
          init
        );
      },
    } as unknown as typeof inner;
    const result = await createProducts(client, {
      location_id: 1,
      skip_existing: false,
      products: [
        {
          title: CANARY,
          category_id: 3,
          sale_price: 300,
          cost_price: 120,
          sale_unit: 'PCS',
          consumable_unit: 'ml',
          consumable_units_per_sale_unit: 250,
          barcode: '859',
        },
      ],
    });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      title: CANARY,
      category_id: 3,
      sale_unit_id: 1,
      service_unit_id: 2,
      unit_equals: 250,
      cost: 300,
      actual_cost: 120,
      barcode: '859',
    });
    expect(raw[0]).toContain('"cost":300.0');
    expect(raw[0]).toContain('"unit_equals":250.0');
    expect(result.structuredContent).toMatchObject({
      created: [{ line: 1, id: 40 }],
      skipped: [],
      failed: [],
    });
    expect(summary(result.text)).not.toContain('System:');
    expect(result.text).toContain('product 40 title');
  });

  it('defaults to pieces and a consumable unit equal to the sale unit', async () => {
    const { client, calls } = setup([
      unitsRoute,
      categoriesRoute,
      currencyRoute,
      noMatches,
      ['POST', /^\/locations\/1\/products$/, 201, created(41)],
    ]);
    await createProducts(client, {
      location_id: 1,
      skip_existing: false,
      products: [{ title: 'Comb', category_id: 2 }],
    });
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      sale_unit_id: 1,
      service_unit_id: 1,
      unit_equals: 1,
    });
  });

  it('needs the ratio when the units differ', async () => {
    const { client } = setup([unitsRoute, categoriesRoute, currencyRoute]);
    await expect(
      createProducts(client, {
        location_id: 1,
        skip_existing: false,
        products: [{ title: 'Oil', category_id: 2, consumable_unit: 'ml' }],
      })
    ).rejects.toThrow(/consumable_units_per_sale_unit/);
  });

  it('refuses an unknown category before anything is written', async () => {
    const { client, calls } = setup([
      unitsRoute,
      categoriesRoute,
      currencyRoute,
    ]);
    await expect(
      createProducts(client, {
        location_id: 1,
        skip_existing: false,
        products: [{ title: 'Oil', category_id: 77 }],
      })
    ).rejects.toThrow(/category 77 was not found/);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses two lines with the same barcode', async () => {
    const { client } = setup([]);
    await expect(
      createProducts(client, {
        location_id: 1,
        skip_existing: false,
        products: [
          { title: 'A', category_id: 2, barcode: '1' },
          { title: 'B', category_id: 2, barcode: ' 1 ' },
        ],
      })
    ).rejects.toThrow(/lines 1 and 2 have the same barcode/);
  });

  const existingShampoo: Route[] = [
    [
      'GET',
      /\/v2\/locations\/1\/products\/autocomplete$/,
      200,
      (call: Call) => ({
        data:
          call.query.get('filter[term]')?.toLowerCase() === 'shampoo'
            ? [productResource()]
            : [],
      }),
    ],
    cardRoute(),
  ];

  it('refuses the call when a line already exists — a repeat finds what it made', async () => {
    const { client, calls } = setup([
      unitsRoute,
      categoriesRoute,
      currencyRoute,
      ...existingShampoo,
    ]);
    const input = {
      location_id: 1,
      skip_existing: false,
      products: [
        { title: 'shampoo', category_id: 2 },
        { title: 'Comb', category_id: 2 },
      ],
    };
    await expect(createProducts(client, input)).rejects.toThrow(
      /line 1 already exists as product 5 \(same title\)/
    );
    await expect(describeProductsCreate(client, input)).rejects.toBeInstanceOf(
      ConfirmationRefusal
    );
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('skips existing lines with skip_existing and creates the rest', async () => {
    const { client, calls } = setup([
      unitsRoute,
      categoriesRoute,
      currencyRoute,
      ...existingShampoo,
      ['POST', /^\/locations\/1\/products$/, 201, created(42)],
    ]);
    const result = await createProducts(client, {
      location_id: 1,
      skip_existing: true,
      products: [
        { title: 'Shampoo', category_id: 2 },
        { title: 'Comb', category_id: 2 },
      ],
    });
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      created: [{ line: 2, id: 42 }],
      skipped: [{ line: 1, product_id: 5, match: 'title' }],
    });
  });

  it('reports a line Altegio refuses and keeps the ones created', async () => {
    let n = 0;
    const { client } = setup([
      unitsRoute,
      categoriesRoute,
      currencyRoute,
      noMatches,
      [
        'POST',
        /^\/locations\/1\/products$/,
        201,
        (call: Call) =>
          ++n === 2
            ? { success: false, meta: { message: 'bad' } }
            : ok(cardRow({ good_id: 50, title: call.body?.title })),
      ],
    ]);
    const result = await createProducts(client, {
      location_id: 1,
      skip_existing: false,
      products: [
        { title: 'A', category_id: 2 },
        { title: 'B', category_id: 2 },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      created: [{ line: 1, id: 50 }],
      failed: [{ line: 2 }],
    });
  });

  it('refuses a price with more decimals than the currency takes', async () => {
    const { client } = setup([
      unitsRoute,
      categoriesRoute,
      currencyRoute,
      noMatches,
    ]);
    await expect(
      createProducts(client, {
        location_id: 1,
        skip_existing: false,
        products: [{ title: 'A', category_id: 2, sale_price: 1.234 }],
      })
    ).rejects.toThrow(/sale_price 1.234 has 3 decimals/);
  });
});

// ===========================================================================
// Changing and archiving products
// ===========================================================================

describe('updateProduct', () => {
  const v2Product: Route = [
    'GET',
    /\/v2\/locations\/1\/products\/5$/,
    200,
    productDoc(),
  ];
  const putRoute: Route = [
    'PUT',
    /^\/locations\/1\/products\/5$/,
    200,
    (call: Call) => ok(cardRow({ ...call.body })),
  ];

  it('sends the whole card back with only the changed field new', async () => {
    const { client, calls } = setup([
      v2Product,
      cardRoute(),
      unitsRoute,
      currencyRoute,
      putRoute,
    ]);
    await updateProduct(client, {
      location_id: 1,
      product_id: 5,
      sale_price: 320,
    });
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({
      title: 'Shampoo',
      category_id: 2,
      sale_unit_id: 1,
      service_unit_id: 2,
      unit_equals: 250,
      cost: 320,
    });
  });

  it('adds the unit conversion rules on a unit change', async () => {
    const { client, calls } = setup([
      v2Product,
      cardRoute(),
      unitsRoute,
      currencyRoute,
      putRoute,
    ]);
    const detail = await describeProductUpdate(client, {
      location_id: 1,
      product_id: 5,
      consumable_units_per_sale_unit: 200,
    });
    expect(detail.text).toContain('A unit change converts');
    await updateProduct(client, {
      location_id: 1,
      product_id: 5,
      consumable_units_per_sale_unit: 200,
    });
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({ unit_equals: 200 });
    expect((put.body!.correction_rules as unknown[]).length).toBe(5);
  });

  it('refuses a membership product', async () => {
    const { client } = setup([
      v2Product,
      cardRoute({ loyalty_abonement_type_id: 8 }),
      unitsRoute,
      currencyRoute,
    ]);
    await expect(
      updateProduct(client, { location_id: 1, product_id: 5, title: 'X' })
    ).rejects.toThrow(/sells a membership/);
  });

  it('refuses an archived product: the V2 read does not find it', async () => {
    const { client } = setup([
      [
        'GET',
        /\/v2\/locations\/1\/products\/5$/,
        404,
        { errors: [{ detail: 'Not found' }] },
      ],
    ]);
    await expect(
      updateProduct(client, { location_id: 1, product_id: 5, title: 'X' })
    ).rejects.toBeInstanceOf(InventoryNotFoundError);
  });

  it('refuses a call without a change', async () => {
    const { client } = setup([]);
    await expect(
      updateProduct(client, { location_id: 1, product_id: 5 })
    ).rejects.toBeInstanceOf(InventoryInputError);
  });
});

describe('archiveProduct', () => {
  it('archives a live product', async () => {
    const { client, calls } = setup([
      cardRoute(),
      ['DELETE', /^\/locations\/1\/products\/5$/, 204, undefined],
    ]);
    const result = await archiveProduct(client, {
      location_id: 1,
      product_id: 5,
    });
    expect(wire(calls)).toEqual([
      'GET /locations/1/products/5',
      'DELETE /locations/1/products/5',
    ]);
    expect(result.structuredContent).toMatchObject({ outcome: 'archived' });
  });

  it('answers a repeat with the product already archived', async () => {
    const { client } = setup([
      cardRoute(),
      [
        'DELETE',
        /^\/locations\/1\/products\/5$/,
        404,
        { success: false, meta: { message: 'Not found' } },
      ],
    ]);
    const result = await archiveProduct(client, {
      location_id: 1,
      product_id: 5,
    });
    expect(result.structuredContent).toMatchObject({
      outcome: 'already_archived',
    });
  });

  it('names the stock the product still holds in the confirmation', async () => {
    const { client } = setup([
      ['GET', /\/v2\/locations\/1\/products\/5$/, 200, productDoc()],
    ]);
    const detail = await describeProductArchive(client, {
      location_id: 1,
      product_id: 5,
    });
    expect(detail).toContain('inventory 3: 4');
  });

  it('refuses to ask about a product that is archived already', async () => {
    const { client } = setup([
      ['GET', /\/v2\/locations\/1\/products\/5$/, 404, { errors: [] }],
    ]);
    await expect(
      describeProductArchive(client, { location_id: 1, product_id: 5 })
    ).rejects.toBeInstanceOf(ConfirmationRefusal);
  });
});
