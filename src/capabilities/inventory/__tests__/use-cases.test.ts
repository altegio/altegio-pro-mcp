/**
 * Inventory: the use cases over the V1 and V2 adapters, driven through a fake
 * transport so the wire contract is asserted exactly — which endpoint each
 * call reaches, the wire names it sends, and what comes back to the model.
 */
import { clearCurrencyCache } from '../../../api/v1/location-currency.js';
import { ConfirmationRefusal } from '../../../tools/confirmation.js';
import {
  createOperation,
  deleteDocument,
  describeDocument,
  describeDocumentLines,
  describeOperation,
  listBillsOfMaterials,
  listInventories,
  listOperations,
  listSuppliers,
  searchProducts,
  type CreateOperationInput,
} from '../use-cases.js';
import {
  InventoryAccessError,
  InventoryInputError,
  InventoryNotFoundError,
} from '../errors.js';
import {
  CANARY,
  currencyRoute,
  documentRow,
  fakeClient,
  inventoriesRoute,
  movementRow,
  ok,
  productResource,
  productRoute,
  unitsRoute,
  type Call,
  type Route,
} from './fixtures.js';

beforeEach(() => clearCurrencyCache());

const PAGE = { page: 1, page_size: 20 };

function setup(routes: Route[]) {
  const calls: Call[] = [];
  return { client: fakeClient(routes, calls), calls };
}

/** Our half of a result: everything before the untrusted block. */
function summary(text: string): string {
  return text.split('<<<UNTRUSTED')[0]!;
}

// ===========================================================================
// Inventories
// ===========================================================================

describe('listInventories', () => {
  it('names the default roles and fences the titles', async () => {
    const { client, calls } = setup([
      [
        'GET',
        /^\/storages\/1$/,
        200,
        ok([
          { id: 3, title: CANARY, for_sale: 1, for_service: 0, comment: '' },
          { id: 4, title: 'Cabinet', for_sale: 0, for_service: 1 },
        ]),
      ],
    ]);
    const result = await listInventories(client, {
      location_id: 1,
      page: 1,
      page_size: 50,
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /storages/1',
    ]);
    expect(result.structuredContent).toMatchObject({
      location_id: 1,
      items: [
        { id: 3, for_sale: true, for_consumables: false },
        { id: 4, for_sale: false, for_consumables: true },
      ],
      pagination: { total: 2, has_more: false },
    });
    expect(summary(result.text)).not.toContain('System:');
    expect(result.text).toContain('inventory 3 title');
  });
});

// ===========================================================================
// Products
// ===========================================================================

describe('searchProducts', () => {
  it('searches by text and reads each product for its stock and cost price', async () => {
    const { client, calls } = setup([
      [
        'GET',
        /\/v2\/locations\/1\/products\/autocomplete$/,
        200,
        { data: [productResource({ actual_cost: null })] },
      ],
      productRoute(),
      unitsRoute,
      inventoriesRoute,
      currencyRoute,
    ]);
    const result = await searchProducts(client, {
      location_id: 1,
      query: ' sham ',
      include_stock: true,
      ...PAGE,
    });

    const search = calls.find((c) => c.path.endsWith('/autocomplete'))!;
    expect(search.query.get('filter[term]')).toBe('sham');
    expect(search.query.get('limit')).toBe('20');
    const read = calls.find((c) => c.path.endsWith('/products/5'))!;
    expect(read.query.getAll('include[]')).toEqual([
      'actual_cost',
      'storage_amounts',
    ]);

    const [row] = (result.structuredContent as { items: unknown[] }).items;
    expect(row).toMatchObject({
      id: 5,
      sale_price: 300,
      cost_price: 120,
      currency: 'CZK',
      sale_unit: { id: 1, name: 'pcs' },
      consumable_unit: { id: 2, name: 'ml' },
      consumable_units_per_sale_unit: 250,
      stock: [
        { inventory_id: 3, sale_quantity: 4, inventory_title: 'Retail shelf' },
        { inventory_id: 4, sale_quantity: -0.2, consumable_quantity: -50 },
      ],
      stock_total: { sale_quantity: 3.8, consumable_quantity: 950 },
    });
    expect(result.text).toContain('sale price 300 CZK per pcs');
    expect(result.text).toContain('1 pcs = 250 ml');
    expect(result.text).toContain('stock 3.8 pcs in all');
    expect(summary(result.text)).not.toContain('Shampoo');
  });

  it('reads given ids from the list without per-product reads when stock is off', async () => {
    const { client, calls } = setup([
      [
        'GET',
        /\/v2\/locations\/1\/products$/,
        200,
        { data: [productResource()] },
      ],
      unitsRoute,
      currencyRoute,
    ]);
    const result = await searchProducts(client, {
      location_id: 1,
      product_ids: [5, 6],
      include_stock: false,
      page: 1,
      page_size: 1,
    });
    const list = calls.find((c) => c.path.endsWith('/products'))!;
    expect(list.query.getAll('filter[ids][]')).toEqual(['5', '6']);
    expect(list.query.getAll('include[]')).toEqual(['actual_cost']);
    expect(calls.some((c) => c.path.endsWith('/products/5'))).toBe(false);
    expect(calls.some((c) => c.path === '/storages/1')).toBe(false);
    // A full page may continue: no total is invented.
    expect(result.structuredContent).toMatchObject({
      items: [{ id: 5, stock: null, stock_total: null }],
      pagination: { total: null, has_more: true, next_page: 2 },
    });
  });

  it('refuses a one-character query and a query combined with ids', async () => {
    const { client } = setup([]);
    await expect(
      searchProducts(client, {
        location_id: 1,
        query: 'a',
        include_stock: true,
        ...PAGE,
      })
    ).rejects.toThrow(InventoryInputError);
    await expect(
      searchProducts(client, {
        location_id: 1,
        query: 'sham',
        product_ids: [5],
        include_stock: true,
        ...PAGE,
      })
    ).rejects.toThrow('either query or product_ids');
  });

  it('maps a refused search to an input error with the next step', async () => {
    const { client } = setup([
      [
        'GET',
        /\/products\/autocomplete$/,
        422,
        { errors: [{ detail: 'term is invalid' }] },
      ],
    ]);
    await expect(
      searchProducts(client, {
        location_id: 1,
        query: '🙂🙂',
        include_stock: false,
        ...PAGE,
      })
    ).rejects.toThrow(/at least two characters .* without emoji/);
  });
});

// ===========================================================================
// Inventory operations: reads
// ===========================================================================

describe('listOperations', () => {
  it('sends the date window and page, and renders lines by document', async () => {
    const { client, calls } = setup([
      [
        'GET',
        /^\/storages\/transactions\/1$/,
        200,
        ok([
          movementRow(),
          movementRow({
            id: 12,
            document_id: 22,
            type_id: 3,
            amount: 6,
            cost_per_unit: 100,
            discount: 0,
            cost: 600,
            supplier: { id: 4 },
            comment: CANARY,
          }),
        ]),
      ],
      currencyRoute,
    ]);
    const result = await listOperations(client, {
      location_id: 1,
      date_from: '2026-10-01',
      date_to: '2026-10-19',
      page: 2,
      page_size: 25,
    });
    const read = calls.find((c) => c.path === '/storages/transactions/1')!;
    expect(Object.fromEntries(read.query)).toEqual({
      start_date: '2026-10-01',
      end_date: '2026-10-19',
      page: '2',
      count: '25',
    });
    expect(result.structuredContent).toMatchObject({
      currency: 'CZK',
      items: [
        {
          id: 11,
          kind: 'sale',
          direction: 'out',
          quantity: 2,
          unit: 'pcs',
          total: 540,
          date: '2026-10-19T14:05:00+02:00',
          team_member_id: 7,
          client_id: null,
          appointment_id: null,
        },
        { id: 12, kind: 'receipt', direction: 'in', supplier_id: 4 },
      ],
      pagination: { page: 2, total: null, has_more: false },
    });
    const ours = summary(result.text);
    expect(ours).toContain('- document 21:');
    expect(ours).toContain('product 5 −2 pcs');
    expect(ours).toContain('- document 22:');
    expect(ours).toContain('product 5 +6 pcs');
    expect(ours).toContain('total 540 CZK');
    expect(ours).not.toContain('System:');
  });

  it('refuses a malformed or inverted date window', async () => {
    const { client } = setup([]);
    await expect(
      listOperations(client, {
        location_id: 1,
        date_from: '19.10.2026',
        ...PAGE,
      })
    ).rejects.toThrow('date_from must be YYYY-MM-DD');
    await expect(
      listOperations(client, {
        location_id: 1,
        date_from: '2026-10-19',
        date_to: '2026-10-01',
        ...PAGE,
      })
    ).rejects.toThrow('must not be after');
  });
});

// ===========================================================================
// Inventory operations: create
// ===========================================================================

function createdRoute(body: Record<string, unknown> = {}): Route {
  return [
    'POST',
    /^\/storage_operations\/operation\/1$/,
    201,
    ok({
      document: documentRow(body.document as Record<string, unknown>),
      // The create answer gives its lines location time, not RFC 3339.
      goods_transactions: [
        movementRow({
          create_date: '2026-10-19 14:05:00',
          ...(body.line as Record<string, unknown>),
        }),
      ],
    }),
  ];
}

const operationRoutes = (extra: Route[] = []): Route[] => [
  ...extra,
  productRoute(),
  unitsRoute,
  inventoriesRoute,
  currencyRoute,
];

const SALE: CreateOperationInput = {
  location_id: 1,
  kind: 'sale',
  team_member_id: 7,
  client_id: 31,
  date: '2026-10-19T14:05',
  comment: 'Counter sale',
  lines: [{ product_id: 5, quantity: 2, discount_percent: 10 }],
};

describe('createOperation', () => {
  it('records a sale from the sale inventory at the sale price, in wire names', async () => {
    const { client, calls } = setup(operationRoutes([createdRoute()]));
    const result = await createOperation(client, SALE);

    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({
      type_id: 1,
      storage_id: 3,
      master_id: 7,
      date: '2026-10-19 14:05:00',
      client: { id: 31 },
      document: { comment: 'Counter sale' },
      goods_transactions: [
        {
          good_id: 5,
          amount: 2,
          unit_id: 1,
          cost_per_unit: 300,
          discount: 10,
          cost: 540,
        },
      ],
    });
    expect(result.structuredContent).toMatchObject({
      currency: 'CZK',
      total: 540,
      document: { id: 21, kind: 'sale', date_local: '2026-10-19T14:05:00' },
    });
    expect(result.structuredContent).toMatchObject({
      lines: [{ id: 11, date: '2026-10-19T14:05:00', team_member_id: 7 }],
    });
    expect(result.text).toContain('No payment was recorded');
    expect(result.text).toContain('inventory_delete_document');
  });

  it('prices consumption per consumable unit from the cost price', async () => {
    const { client, calls } = setup(operationRoutes([createdRoute()]));
    await createOperation(client, {
      location_id: 1,
      kind: 'consumption',
      team_member_id: 7,
      lines: [{ product_id: 5, quantity: 50 }],
    });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({
      type_id: 2,
      storage_id: 4,
      goods_transactions: [
        { amount: 50, unit_id: 2, cost_per_unit: 0.48, discount: 0, cost: 24 },
      ],
    });
    expect(post.body).not.toHaveProperty('date');
    expect(post.body).not.toHaveProperty('client');
  });

  it('sends the Supplier on every line of a receipt at the given price', async () => {
    const { client, calls } = setup(operationRoutes([createdRoute()]));
    await createOperation(client, {
      location_id: 1,
      kind: 'receipt',
      team_member_id: 7,
      inventory_id: 3,
      supplier_id: 4,
      lines: [{ product_id: 5, quantity: 6, unit_price: 100 }],
    });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({
      type_id: 3,
      storage_id: 3,
      goods_transactions: [
        {
          amount: 6,
          unit_id: 1,
          cost_per_unit: 100,
          cost: 600,
          supplier_id: 4,
        },
      ],
    });
  });

  it.each([
    [
      'a receipt without an inventory',
      {
        kind: 'receipt',
        client_id: undefined,
        lines: [{ product_id: 5, quantity: 1 }],
      },
      'needs inventory_id',
    ],
    [
      'a Supplier on a sale',
      { supplier_id: 4 },
      'supplier_id belongs to a product receipt only',
    ],
    [
      'a client on a write-off',
      { kind: 'write_off', inventory_id: 3 },
      'client_id belongs to a product sale only',
    ],
    [
      'an inventory of another location',
      { inventory_id: 99 },
      'Inventory 99 is not an inventory of location 1',
    ],
    [
      'a date with an offset',
      { date: '2026-10-19T14:05:00+02:00' },
      'date must be the time at the location',
    ],
    [
      'the same product twice in one unit',
      {
        lines: [
          { product_id: 5, quantity: 1 },
          { product_id: 5, quantity: 2 },
        ],
      },
      'appears twice in the same unit',
    ],
  ])('refuses %s before writing', async (_, overrides, message) => {
    const { client, calls } = setup(operationRoutes([createdRoute()]));
    await expect(
      createOperation(client, {
        ...SALE,
        ...(overrides as Partial<CreateOperationInput>),
      })
    ).rejects.toThrow(message);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('refuses a membership product and asks for a price it cannot see', async () => {
    const membership = setup(
      operationRoutes([productRoute({ loyalty_abonement_type_id: 9 })])
    );
    await expect(createOperation(membership.client, SALE)).rejects.toThrow(
      'sells a membership'
    );

    const hidden = setup(
      operationRoutes([productRoute({ actual_cost: null })])
    );
    await expect(
      createOperation(hidden.client, {
        ...SALE,
        kind: 'write_off',
        client_id: undefined,
        inventory_id: 3,
      })
    ).rejects.toThrow('pass unit_price');
  });

  describe('a product named by text', () => {
    const searchRoute = (resources: unknown[]): Route => [
      'GET',
      /\/products\/autocomplete$/,
      200,
      { data: resources },
    ];

    it('takes the exact title match among several results', async () => {
      const { client, calls } = setup(
        operationRoutes([
          createdRoute(),
          searchRoute([
            productResource({ title: 'Shampoo mini' }, '6'),
            productResource({}, '5'),
          ]),
        ])
      );
      await createOperation(client, {
        ...SALE,
        lines: [{ product: 'shampoo', quantity: 1 }],
      });
      const search = calls.find((c) => c.path.endsWith('/autocomplete'))!;
      expect(search.query.get('filter[term]')).toBe('shampoo');
      const post = calls.find((c) => c.method === 'POST')!;
      expect(post.body).toMatchObject({ goods_transactions: [{ good_id: 5 }] });
    });

    it('refuses an ambiguous or unknown name with the candidates', async () => {
      const ambiguous = setup(
        operationRoutes([
          searchRoute([
            productResource({ title: 'Shampoo mini' }, '6'),
            productResource({ title: 'Shampoo max' }, '7'),
          ]),
        ])
      );
      await expect(
        createOperation(ambiguous.client, {
          ...SALE,
          lines: [{ product: 'shampoo', quantity: 1 }],
        })
      ).rejects.toThrow('matches 2 products (ids 6, 7)');

      const none = setup(operationRoutes([searchRoute([])]));
      await expect(
        createOperation(none.client, {
          ...SALE,
          lines: [{ product: 'conditioner', quantity: 1 }],
        })
      ).rejects.toThrow('no product matches');
    });
  });

  it('maps an API refusal to an input error naming what to check', async () => {
    const { client } = setup(
      operationRoutes([
        [
          'POST',
          /^\/storage_operations\/operation\/1$/,
          422,
          { success: false, meta: { message: 'Not enough stock' } },
        ],
      ])
    );
    const error = await createOperation(client, SALE).catch((e) => e);
    expect(error).toBeInstanceOf(InventoryInputError);
    expect(error.message).toContain('enough stock');
    expect(error.message).toContain('Not enough stock');
  });
});

describe('describeOperation', () => {
  it('lists every priced line and the document total, computed like the write', async () => {
    const { client, calls } = setup(operationRoutes());
    const detail = await describeOperation(client, {
      ...SALE,
      lines: [
        { product_id: 5, quantity: 2, discount_percent: 10 },
        { product_id: 5, quantity: 100, unit: 'consumable' },
      ],
    });
    expect(detail).toContain('It takes from inventory 3 Retail shelf:');
    expect(detail).toContain(
      '- product 5 Shampoo: 2 pcs × 300 CZK (sale price) − 10% = 540 CZK'
    );
    expect(detail).toContain(
      '- product 5 Shampoo: 100 ml × 1.2 CZK (sale price) = 120 CZK'
    );
    expect(detail).toContain('Document total 660 CZK.');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('turns an impossible plan into a refusal, so nobody is asked', async () => {
    const { client } = setup(operationRoutes());
    await expect(
      describeOperation(client, { ...SALE, supplier_id: 4 })
    ).rejects.toThrow(ConfirmationRefusal);
  });
});

// ===========================================================================
// Documents: delete
// ===========================================================================

describe('deleteDocument', () => {
  const documentRoutes = (extra: Route[] = []): Route[] => [
    ...extra,
    [
      'GET',
      /^\/storage_operations\/documents\/1\/21$/,
      200,
      ok(documentRow({ comment: CANARY })),
    ],
    ['DELETE', /^\/storage_operations\/documents\/1\/21$/, 200, ok(null)],
    ['GET', /^\/storages\/transactions\/1$/, 200, ok([movementRow()])],
    currencyRoute,
  ];

  it('reads the document and its lines, then deletes it', async () => {
    const { client, calls } = setup(documentRoutes());
    const result = await deleteDocument(client, {
      location_id: 1,
      document_id: 21,
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(
      'DELETE /storage_operations/documents/1/21'
    );
    const lines = calls.find((c) => c.path === '/storages/transactions/1')!;
    expect(lines.query.get('document_id')).toBe('21');
    expect(result.structuredContent).toMatchObject({
      deleted: true,
      document: { id: 21, number: 7, kind: 'sale' },
      lines: [{ id: 11, quantity: 2, currency: 'CZK' }],
    });
    const ours = summary(result.text);
    expect(ours).toContain('Deleted document 21 (number 7): product sale');
    expect(ours).toContain('was not deleted');
    expect(ours).not.toContain('System:');
  });

  it('labels the target and lists what comes back for the confirmation', async () => {
    const { client, calls } = setup(documentRoutes());
    expect(
      await describeDocument(client, { location_id: 1, document_id: 21 })
    ).toBe(
      'document 21 (number 7): product sale · inventory 3 · 2026-10-19T14:05:00 (location time) at location 1'
    );
    const detail = await describeDocumentLines(client, {
      location_id: 1,
      document_id: 21,
    });
    expect(detail).toContain(
      '- product 5 Shampoo: −2 pcs in inventory 3, total 540 CZK'
    );
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('refuses an unknown document before asking anyone', async () => {
    const { client } = setup([
      [
        'GET',
        /^\/storage_operations\/documents\/1\/99$/,
        404,
        { success: false, meta: { message: 'Not found' } },
      ],
    ]);
    const error = await describeDocumentLines(client, {
      location_id: 1,
      document_id: 99,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ConfirmationRefusal);
    expect(error.message).toContain('inventory_list_operations');
    await expect(
      deleteDocument(client, { location_id: 1, document_id: 99 })
    ).rejects.toThrow(InventoryNotFoundError);
  });
});

// ===========================================================================
// Suppliers and Partners
// ===========================================================================

describe('listSuppliers', () => {
  const suppliersRoute: Route = [
    'GET',
    /^\/references\/suppliers\/1$/,
    200,
    ok([
      { id: 4, title: 'Beauty Supply s.r.o.', type_id: 0 },
      { id: 5, title: 'Jana Nováková', type_id: 2 },
      { id: 6, title: 'Supply Point', type_id: 1 },
    ]),
  ];

  it('filters by part of the name and maps the counterparty type', async () => {
    const { client } = setup([suppliersRoute]);
    const result = await listSuppliers(client, {
      location_id: 1,
      query: 'SUPPLY',
      ...PAGE,
    });
    expect(result.structuredContent).toMatchObject({
      items: [
        { id: 4, type: 'legal_entity' },
        { id: 6, type: 'sole_proprietor' },
      ],
      pagination: { total: 2, has_more: false },
    });
    expect(summary(result.text)).not.toContain('Beauty');
  });

  it('names the Finances right on a 403', async () => {
    const { client } = setup([
      ['GET', /^\/references\/suppliers\/1$/, 403, { success: false }],
    ]);
    const error = await listSuppliers(client, {
      location_id: 1,
      ...PAGE,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(InventoryAccessError);
    expect(error.message).toContain('Finances access rights');
  });
});

// ===========================================================================
// Bills of Materials
// ===========================================================================

describe('listBillsOfMaterials', () => {
  const bill = {
    id: 8,
    title: 'Colouring',
    technological_card_items: [
      {
        good_id: 5,
        good: { id: 5, title: 'Shampoo', unit: 'ml' },
        storage_id: 4,
        amount: 30,
        price: 14.4,
      },
    ],
  };

  it('searches by title and pages', async () => {
    const { client, calls } = setup([
      ['GET', /^\/technological_cards\/1$/, 200, ok([bill])],
      currencyRoute,
    ]);
    const result = await listBillsOfMaterials(client, {
      location_id: 1,
      query: 'colour',
      ...PAGE,
    });
    const read = calls.find((c) => c.path === '/technological_cards/1')!;
    expect(Object.fromEntries(read.query)).toEqual({
      search: 'colour',
      page: '1',
      count: '20',
    });
    expect(result.structuredContent).toMatchObject({
      currency: 'CZK',
      items: [
        {
          id: 8,
          lines: [{ product_id: 5, inventory_id: 4, quantity: 30, cost: 14.4 }],
        },
      ],
    });
    expect(result.text).toContain(
      'product 5: 30 ml from inventory 4, cost 14.4 CZK'
    );
  });

  it('reads the one a team member applies to a service, or says there is none', async () => {
    const found = setup([
      [
        'GET',
        /^\/technological_cards\/default_for_staff_and_service\/1\/7\/3$/,
        200,
        ok(bill),
      ],
      currencyRoute,
    ]);
    const result = await listBillsOfMaterials(found.client, {
      location_id: 1,
      team_member_id: 7,
      service_id: 3,
      ...PAGE,
    });
    expect(result.structuredContent).toMatchObject({ items: [{ id: 8 }] });

    const none = setup([
      [
        'GET',
        /^\/technological_cards\/default_for_staff_and_service\/1\/7\/3$/,
        200,
        ok([]),
      ],
      currencyRoute,
    ]);
    const empty = await listBillsOfMaterials(none.client, {
      location_id: 1,
      team_member_id: 7,
      service_id: 3,
      ...PAGE,
    });
    expect(empty.text).toContain('has no Bill of Materials for service 3');
  });

  it('refuses a team member without a service', async () => {
    const { client } = setup([]);
    await expect(
      listBillsOfMaterials(client, {
        location_id: 1,
        team_member_id: 7,
        ...PAGE,
      })
    ).rejects.toThrow('together');
  });
});
