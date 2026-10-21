/**
 * Changing an inventory document and paying a product receipt, against a
 * fake transport: the wire contract of each step, the version and repeat
 * guards, and the fencing of other people's text.
 */
import type { AltegioClient } from '../../../providers/altegio-client.js';
import { clearCurrencyCache } from '../../../api/v1/location-currency.js';
import { clearTimezoneCache } from '../../analytics/location-timezone.js';
import {
  describeDocumentPayment,
  describeDocumentUpdate,
  payDocument,
  updateDocument,
} from '../documents.js';
import {
  CANARY,
  currencyRoute,
  fakeClient as baseClient,
  ok,
  productRoute,
  unitsRoute,
  type Call,
  type Route,
} from './fixtures.js';

const summaryOf = (text: string) => text.split('<<<UNTRUSTED')[0]!;

/** The fake transport, with the location's time zone (Europe/Prague). */
function fakeClient(routes: Route[], calls: Call[]): AltegioClient {
  return Object.assign(baseClient(routes, calls), {
    getCompanies: async () => [{ id: 1, timezone_name: 'Europe/Prague' }],
  });
}

const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

beforeEach(() => {
  clearCurrencyCache();
  clearTimezoneCache();
});

/** Document 21: a product receipt into inventory 3. */
function documentRoute(overrides: Record<string, unknown> = {}): Route {
  return [
    'GET',
    /^\/storage_operations\/documents\/1\/21$/,
    200,
    ok({
      id: 21,
      type_id: 3,
      number: 7,
      storage_id: 3,
      storage: { id: 3, title: 'Retail shelf' },
      create_date: '2026-10-19 14:05:00',
      comment: 'invoice 7',
      ...overrides,
    }),
  ];
}

/** Line 31: 10 bottles of product 5 at 120 from Supplier 4043. */
function lineRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 31,
    document_id: 21,
    company_id: 1,
    good_id: 5,
    amount: 10,
    unit_id: 1,
    operation_unit_type: 1,
    cost_per_unit: 120,
    discount: 0,
    cost: 1200,
    supplier_id: 4043,
    master_id: 820311,
    client_id: 0,
    record_id: 0,
    comment: CANARY,
    deleted: false,
    ...overrides,
  };
}

function linesRoute(lines: unknown[]): Route {
  return [
    'GET',
    /^\/storage_operations\/documents\/goods_transactions\/21$/,
    200,
    ok(lines),
  ];
}

function paymentsRoute(payments: unknown[]): Route {
  return [
    'GET',
    /^\/storage_operations\/documents\/finance_transactions\/21$/,
    200,
    ok(payments),
  ];
}

const productsRoute: Route = [
  'GET',
  /\/v2\/locations\/1\/products$/,
  200,
  { data: [] },
];

const readRoutes = (lines: unknown[], payments: unknown[] = []): Route[] => [
  documentRoute(),
  linesRoute(lines),
  paymentsRoute(payments),
  productsRoute,
  unitsRoute,
  currencyRoute,
];

// ========== changing a document ==========

describe('updateDocument', () => {
  const twoLines = [
    lineRow(),
    lineRow({
      id: 32,
      good_id: 6,
      amount: 2,
      cost_per_unit: 150,
      cost: 300,
      comment: '',
    }),
  ];
  const writeRoutes: Route[] = [
    ['PUT', /^\/storage_operations\/documents\/1\/21$/, 200, ok({ id: 21 })],
    [
      'PUT',
      /^\/storage_operations\/goods_transactions\/1\/31$/,
      200,
      ok(lineRow({ amount: 12, cost: 1440 })),
    ],
    [
      'DELETE',
      /^\/storage_operations\/goods_transactions\/1\/32$/,
      202,
      undefined,
    ],
  ];

  it('stores the header, replaces a changed line whole and removes another, in that order', async () => {
    const calls: Call[] = [];
    const client = fakeClient([...writeRoutes, ...readRoutes(twoLines)], calls);
    const result = await updateDocument(client, {
      location_id: 1,
      document_id: 21,
      date: '2026-10-20T09:30',
      comment: 'invoice 7, corrected',
      lines: [
        { line_id: 31, quantity: 12 },
        { line_id: 32, remove: true },
      ],
    });
    expect(writes(calls).map((c) => [c.method, c.path, c.body])).toEqual([
      [
        'PUT',
        '/storage_operations/documents/1/21',
        {
          type_id: 3,
          storage_id: 3,
          create_date: '2026-10-20 09:30:00',
          comment: 'invoice 7, corrected',
        },
      ],
      [
        'PUT',
        '/storage_operations/goods_transactions/1/31',
        // A full replace: the Supplier, team member and comment go back as
        // they were, or Altegio clears them.
        {
          document_id: 21,
          product_id: 5,
          amount: 12,
          unit_id: 1,
          cost_per_unit: 120,
          discount: 0,
          cost: 1440,
          supplier_id: 4043,
          team_member_id: 820311,
          client_id: 0,
          comment: CANARY,
        },
      ],
      ['DELETE', '/storage_operations/goods_transactions/1/32', undefined],
    ]);
    expect(result.isError).toBeUndefined();
    expect(result.text).toContain('Changed document 21 at location 1');
    expect(summaryOf(result.text)).not.toContain('ignore previous');
  });

  it('shows every change before → after and the new total, fencing the comments', async () => {
    const client = fakeClient(readRoutes(twoLines), []);
    const detail = await describeDocumentUpdate(client, {
      location_id: 1,
      document_id: 21,
      comment: CANARY,
      lines: [
        { line_id: 31, quantity: 12 },
        { line_id: 32, remove: true },
      ],
    });
    expect(detail.text).toContain('- comment: changed');
    expect(detail.text).toContain('- line 31 (product 5): 10 × 120');
    expect(detail.text).toContain('→ 12 × 120');
    expect(detail.text).toContain(
      '- line 32 (product 6, 2 × 150 CZK): removed'
    );
    expect(detail.text).toContain('Document total: 1500 CZK → 1440 CZK.');
    expect(summaryOf(detail.text)).not.toContain('ignore previous');
    expect(detail.version).toEqual(expect.any(String));
  });

  it('refuses a change confirmed on another version of the lines', async () => {
    const calls: Call[] = [];
    const client = fakeClient(readRoutes(twoLines), calls);
    await expect(
      updateDocument(
        client,
        {
          location_id: 1,
          document_id: 21,
          lines: [{ line_id: 31, quantity: 12 }],
        },
        { version: 'old', idempotency_key: 'k' }
      )
    ).rejects.toThrow(/changed after the confirmation/);
    expect(writes(calls)).toEqual([]);
  });

  it.each([
    [
      'a line of an appointment',
      [lineRow({ record_id: 675876521 }), lineRow({ id: 32 })],
      { lines: [{ line_id: 31, quantity: 1 }] },
      /belongs to appointment 675876521/,
    ],
    [
      'removing every line',
      [lineRow()],
      { lines: [{ line_id: 31, remove: true }] },
      /remove every line.*inventory_delete_document/,
    ],
    [
      'a line of another document',
      [lineRow()],
      { lines: [{ line_id: 99, quantity: 1 }] },
      /line 99 is not a line of document 21/,
    ],
    [
      'an entry that changes nothing',
      [lineRow()],
      { lines: [{ line_id: 31 }] },
      /changes nothing/,
    ],
  ])('refuses %s without writing', async (_what, lines, change, message) => {
    const calls: Call[] = [];
    const client = fakeClient(readRoutes(lines), calls);
    await expect(
      updateDocument(client, { location_id: 1, document_id: 21, ...change })
    ).rejects.toThrow(message);
    expect(writes(calls)).toEqual([]);
  });

  it('refuses a consumption document', async () => {
    const calls: Call[] = [];
    const client = fakeClient(
      [documentRoute({ type_id: 2 }), ...readRoutes([lineRow()])],
      calls
    );
    await expect(
      updateDocument(client, {
        location_id: 1,
        document_id: 21,
        comment: 'x',
      })
    ).rejects.toThrow(/only product sale, product receipt and write-off/);
    expect(writes(calls)).toEqual([]);
  });

  it('reports a partial change as an error, naming what was done', async () => {
    const calls: Call[] = [];
    const client = fakeClient(
      [
        writeRoutes[0]!,
        [
          'PUT',
          /^\/storage_operations\/goods_transactions\/1\/31$/,
          422,
          { success: false, meta: { message: 'Not enough stock' } },
        ],
        ...readRoutes(twoLines),
      ],
      calls
    );
    const result = await updateDocument(client, {
      location_id: 1,
      document_id: 21,
      comment: 'invoice 7, corrected',
      lines: [{ line_id: 31, quantity: 12 }],
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(
      /changed in part: done header; not done line 31/
    );
  });
});

// ========== paying a product receipt ==========

describe('payDocument', () => {
  const NOW = Date.parse('2026-10-21T10:00:00Z');
  const expenseItems: Route = [
    'GET',
    /^\/references\/expenses\/1$/,
    200,
    ok([
      { id: 2, title: 'Product purchase', type: 1 },
      { id: 5, title: 'Services', type: 7 },
    ]),
  ];
  const created: Route = [
    'POST',
    /^\/finance_transactions\/1$/,
    201,
    (call: Call) => ok({ id: 589600001, ...call.body }),
  ];
  const payment = (overrides: Record<string, unknown> = {}) => ({
    id: 589500001,
    amount: -200,
    account_id: 1330531,
    expense_id: 2,
    document_id: 21,
    date: '2026-10-01 10:00:00',
    comment: CANARY,
    ...overrides,
  });

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  });
  afterEach(() => jest.useRealTimers());

  it('pays the amount due to the Supplier of the lines, linked to the document', async () => {
    const calls: Call[] = [];
    const client = fakeClient(
      [created, expenseItems, ...readRoutes([lineRow()], [payment()])],
      calls
    );
    const detail = await describeDocumentPayment(client, {
      location_id: 1,
      document_id: 21,
      account_id: 1330531,
    });
    expect(detail.text).toContain(
      'Document 21 totals 1200 CZK; paid so far 200 CZK; amount due 1000 CZK.'
    );
    const result = await payDocument(client, {
      location_id: 1,
      document_id: 21,
      account_id: 1330531,
      date: '2026-10-21T12:00',
    });
    expect(writes(calls).map((c) => [c.path, c.body])).toEqual([
      [
        '/finance_transactions/1',
        {
          expense_id: 2,
          account_id: 1330531,
          amount: 1000,
          // 12:00 in Prague is 14:00 server time (+04:00).
          date: '2026-10-21 14:00:00',
          comment: '',
          client_id: 0,
          team_member_id: 0,
          supplier_id: 4043,
          document_id: 21,
        },
      ],
    ]);
    expect(result.text).toContain('Amount due now 0 CZK.');
    expect(result.text).toContain('financial_transactions_delete');
  });

  it.each([
    [
      'a receipt paid in full',
      [payment({ amount: -1200 })],
      {},
      /paid in full/,
    ],
    [
      'more than the amount due',
      [payment()],
      { amount: 1500 },
      /more than the amount due/,
    ],
    [
      'the same payment a moment ago',
      [payment({ amount: -500, date: '2026-10-21 13:58:00' })],
      { amount: 500 },
      /looks like a repeat/,
    ],
    [
      'an income payment item',
      [payment()],
      { payment_item_id: 5 },
      /not an expense item/,
    ],
  ])('refuses %s without writing', async (_what, payments, input, message) => {
    const calls: Call[] = [];
    const client = fakeClient(
      [created, expenseItems, ...readRoutes([lineRow()], payments)],
      calls
    );
    await expect(
      payDocument(client, {
        location_id: 1,
        document_id: 21,
        account_id: 1330531,
        ...input,
      })
    ).rejects.toThrow(message);
    expect(writes(calls)).toEqual([]);
  });

  it('refuses a document that is not a product receipt', async () => {
    const calls: Call[] = [];
    const client = fakeClient(
      [
        documentRoute({ type_id: 4 }),
        created,
        expenseItems,
        ...readRoutes([lineRow()]),
      ],
      calls
    );
    await expect(
      payDocument(client, { location_id: 1, document_id: 21, account_id: 1 })
    ).rejects.toThrow(/write-off; only a product receipt is paid/);
    expect(writes(calls)).toEqual([]);
  });

  it('refuses a payment confirmed before another payment was recorded', async () => {
    const calls: Call[] = [];
    const client = fakeClient(
      [created, expenseItems, ...readRoutes([lineRow()], [payment()])],
      calls
    );
    await expect(
      payDocument(
        client,
        { location_id: 1, document_id: 21, account_id: 1330531 },
        { version: 'old', idempotency_key: 'k' }
      )
    ).rejects.toThrow(/changed after the confirmation/);
    expect(writes(calls)).toEqual([]);
  });

  it('fences the comments of the payments it reads', async () => {
    const client = fakeClient(
      [created, expenseItems, ...readRoutes([lineRow()], [payment()])],
      []
    );
    const result = await payDocument(client, {
      location_id: 1,
      document_id: 21,
      account_id: 1330531,
      comment: CANARY,
    });
    expect(summaryOf(result.text)).not.toContain('ignore previous');
  });
});

// The product title lookup is best effort: a failed V2 read leaves the titles
// out rather than failing the change.
it('changes a document when the product titles cannot be read', async () => {
  const calls: Call[] = [];
  const client = fakeClient(
    [
      ['PUT', /^\/storage_operations\/documents\/1\/21$/, 200, ok({ id: 21 })],
      ['GET', /\/v2\/locations\/1\/products$/, 500, {}],
      productRoute(),
      ...readRoutes([lineRow()]),
    ],
    calls
  );
  const result = await updateDocument(client, {
    location_id: 1,
    document_id: 21,
    comment: 'x',
  });
  expect(result.isError).toBeUndefined();
});
