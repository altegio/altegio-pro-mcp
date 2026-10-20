/**
 * Appointment consumables: the visit-wide read filtered to one appointment,
 * and the read-modify-write of one service's list, asserted on the wire.
 */
import { clearCurrencyCache } from '../../../api/v1/location-currency.js';
import { ConfirmationRefusal } from '../../../tools/confirmation.js';
import {
  describeConsumablesChange,
  getConsumables,
  setConsumables,
  type SetConsumablesInput,
} from '../consumables.js';
import { InventoryInputError } from '../errors.js';
import { InventoryAdapter } from '../../../api/v1/inventory-adapter.js';
import type { ConfirmedCall } from '../../../tools/confirmation.js';
import {
  CANARY,
  currencyRoute,
  fakeClient,
  inventoriesRoute,
  ok,
  productRoute,
  unitsRoute,
  type Call,
  type Route,
} from './fixtures.js';

beforeEach(() => clearCurrencyCache());

function setup(routes: Route[]) {
  const calls: Call[] = [];
  return { client: fakeClient(routes, calls), calls };
}

function summary(text: string): string {
  return text.split('<<<UNTRUSTED')[0]!;
}

interface LineFixture {
  line: number;
  product: number;
  inventory?: number;
  amount: number;
  title?: string;
}

function block(
  appointment: number,
  service: number,
  lines: LineFixture[],
  bill: { id: number; title: string } | null = { id: 8, title: 'Colouring' }
): Record<string, unknown> {
  return {
    record_id: appointment,
    service_id: service,
    technological_cards: bill ? [bill] : [],
    consumables: lines.map((l) => ({
      goods_transaction_id: l.line,
      good_id: l.product,
      good: {
        id: l.product,
        title: l.title ?? `Product ${l.product}`,
        unit: 'ml',
      },
      storage_id: l.inventory ?? 4,
      amount: l.amount,
      price: round(l.amount * 0.48),
    })),
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Appointment 9 (service 3) and appointment 10 (service 6) of one visit. */
const VISIT = [
  block(9, 3, [
    { line: 61, product: 5, amount: 30, title: CANARY },
    { line: 62, product: 6, amount: 10 },
  ]),
  block(10, 6, [{ line: 63, product: 5, amount: 5 }], null),
];

function readRoute(blocks: unknown[] = VISIT): Route {
  return [
    'GET',
    /^\/technological_cards\/record_consumables\/1\/9$/,
    200,
    ok(blocks),
  ];
}

function appointmentRoute(attendance: number): Route {
  return [
    'GET',
    /^\/locations\/1\/appointments\/9$/,
    200,
    ok({ id: 9, company_id: 1, attendance, services: [{ id: 3 }] }),
  ];
}

/** The PUT answers with what it stored: new line ids, the visit's blocks. */
const putRoute: Route = [
  'PUT',
  /^\/technological_cards\/record_consumables\/consumables\/1\/9\/3$/,
  200,
  (call: Call) => {
    const sent = (call.body?.consumables ?? []) as Array<{
      good_id: number;
      storage_id: number;
      amount: number;
    }>;
    return ok([
      block(
        9,
        3,
        sent.map((l, i) => ({
          line: 100 + i,
          product: l.good_id,
          inventory: l.storage_id,
          amount: l.amount,
        })),
        null
      ),
      VISIT[1],
    ]);
  },
];

function routes(attendance = 1, extra: Route[] = []): Route[] {
  return [
    ...extra,
    putRoute,
    readRoute(),
    appointmentRoute(attendance),
    productRoute({}, '7'),
    unitsRoute,
    inventoriesRoute,
    currencyRoute,
  ];
}

const BASE: SetConsumablesInput = {
  location_id: 1,
  appointment_id: 9,
  service_id: 3,
  consumables: [],
  replace: false,
};

function sent(calls: Call[]) {
  return calls.find((c) => c.method === 'PUT')?.body?.consumables;
}

// ===========================================================================
// Read
// ===========================================================================

describe('getConsumables', () => {
  it('keeps the asked appointment and names the rest of the visit', async () => {
    const { client } = setup(routes(0));
    const result = await getConsumables(client, {
      location_id: 1,
      appointment_id: 9,
    });
    expect(result.structuredContent).toMatchObject({
      appointment_id: 9,
      attendance: 'waiting',
      stock_moved: false,
      currency: 'CZK',
      services: [
        {
          appointment_id: 9,
          service_id: 3,
          bill_of_materials: { id: 8 },
          lines: [
            {
              line_id: 61,
              product_id: 5,
              quantity: 30,
              unit: 'ml',
              cost: 14.4,
            },
            { line_id: 62, product_id: 6, quantity: 10 },
          ],
        },
      ],
      other_appointment_ids: [10],
      services_on_other_appointments: [],
    });
    const ours = summary(result.text);
    expect(ours).toContain(
      'line 61: product 5: 30 ml from inventory 4, cost 14.4 CZK'
    );
    expect(ours).toContain('taken from stock only once it is marked arrived');
    expect(ours).not.toContain('System:');
  });

  it('flags a service that another appointment of the visit also has', async () => {
    const { client } = setup([
      readRoute([...VISIT, block(11, 3, [], null)]),
      appointmentRoute(1),
      currencyRoute,
    ]);
    const result = await getConsumables(client, {
      location_id: 1,
      appointment_id: 9,
    });
    expect(result.structuredContent).toMatchObject({
      stock_moved: true,
      services_on_other_appointments: [
        { service_id: 3, appointment_ids: [11] },
      ],
    });
    expect(result.text).toContain('appointments_set_consumables refuses');
  });
});

// ===========================================================================
// Write
// ===========================================================================

describe('setConsumables', () => {
  it('changes one quantity and sends every other line back with its id', async () => {
    const { client, calls } = setup(routes());
    const result = await setConsumables(client, {
      ...BASE,
      consumables: [{ product_id: 6, quantity: 12.5 }],
    });
    expect(sent(calls)).toEqual([
      {
        goods_transaction_id: 61,
        record_id: 9,
        service_id: 3,
        good_id: 5,
        storage_id: 4,
        amount: 30,
      },
      {
        goods_transaction_id: 62,
        record_id: 9,
        service_id: 3,
        good_id: 6,
        storage_id: 4,
        amount: 12.5,
      },
    ]);
    // A product already on the list is not read again.
    expect(calls.some((c) => c.path.includes('/products/'))).toBe(false);
    expect(result.structuredContent).toMatchObject({
      changed: true,
      stock_moved: true,
      lines: [
        { line_id: 100, product_id: 5 },
        { line_id: 101, product_id: 6, quantity: 12.5 },
      ],
    });
    const ours = summary(result.text);
    expect(ours).toContain('- change product 6 (inventory 4): 10 ml → 12.5 ml');
    expect(ours).toContain('no longer follows Bill of Materials 8');
    expect(ours).toContain('taken from stock');
  });

  it('removes a line at quantity 0 and adds a new product from the consumables inventory', async () => {
    const { client, calls } = setup(routes());
    await setConsumables(client, {
      ...BASE,
      consumables: [
        { product_id: 5, quantity: 0 },
        { product_id: 7, quantity: 4 },
      ],
    });
    expect(sent(calls)).toEqual([
      expect.objectContaining({ goods_transaction_id: 62, good_id: 6 }),
      {
        goods_transaction_id: 0,
        record_id: 9,
        service_id: 3,
        good_id: 7,
        storage_id: 4,
        amount: 4,
      },
    ]);
  });

  it('under replace sends only the listed products, keeping a kept line id', async () => {
    const { client, calls } = setup(routes());
    await setConsumables(client, {
      ...BASE,
      replace: true,
      consumables: [{ product_id: 5, quantity: 30 }],
    });
    expect(sent(calls)).toEqual([
      expect.objectContaining({
        goods_transaction_id: 61,
        good_id: 5,
        amount: 30,
      }),
    ]);
  });

  it('writes nothing when the list already matches', async () => {
    const { client, calls } = setup(routes());
    const result = await setConsumables(client, {
      ...BASE,
      consumables: [{ product_id: 5, quantity: 30 }],
    });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(result.structuredContent).toMatchObject({ changed: false });
  });

  it.each([
    [
      'a service the appointment does not have',
      { service_id: 4 },
      'Service 4 is not on appointment 9; its services are 3',
    ],
    [
      'a product listed twice for one inventory',
      {
        consumables: [
          { product_id: 7, quantity: 1 },
          { product_id: 7, quantity: 2 },
        ],
      },
      'listed twice for inventory 4',
    ],
    [
      'an inventory of another location',
      { consumables: [{ product_id: 7, quantity: 1, inventory_id: 99 }] },
      'Inventory 99 is not an inventory of location 1',
    ],
  ])('refuses %s', async (_, overrides, message) => {
    const { client, calls } = setup(routes());
    await expect(
      setConsumables(client, { ...BASE, ...overrides })
    ).rejects.toThrow(message);
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('refuses when another appointment of the visit has the same service', async () => {
    const { client, calls } = setup([
      putRoute,
      readRoute([...VISIT, block(11, 3, [], null)]),
      appointmentRoute(1),
      currencyRoute,
    ]);
    await expect(
      setConsumables(client, {
        ...BASE,
        consumables: [{ product_id: 5, quantity: 1 }],
      })
    ).rejects.toThrow('also on appointment(s) 11 of the same visit');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('needs inventory_id for a product recorded from two inventories', async () => {
    const twice = [
      block(9, 3, [
        { line: 61, product: 5, amount: 30 },
        { line: 64, product: 5, amount: 5, inventory: 3 },
      ]),
    ];
    const { client } = setup([
      readRoute(twice),
      appointmentRoute(1),
      currencyRoute,
    ]);
    const error = await setConsumables(client, {
      ...BASE,
      consumables: [{ product_id: 5, quantity: 1 }],
    }).catch((e) => e);
    expect(error).toBeInstanceOf(InventoryInputError);
    expect(error.message).toContain('pass inventory_id');
  });
});

describe('describeConsumablesChange', () => {
  it('shows before → after with product names, the Bill of Materials detach and the stock note', async () => {
    const { client, calls } = setup(routes(2));
    const { text: detail } = await describeConsumablesChange(client, {
      ...BASE,
      consumables: [
        { product_id: 6, quantity: 0 },
        { product_id: 7, quantity: 4 },
      ],
    });
    expect(detail).toContain(
      '- remove product 6 Product 6 (inventory 4): 10 ml → none'
    );
    expect(detail).toContain('- add product 7 Shampoo (inventory 4): 4 ml');
    expect(detail).toContain(
      '1 other line(s) stay as they are; 2 line(s) in all'
    );
    expect(detail).toContain('no longer follow it');
    expect(detail).toContain('marked confirmed, so these consumables wait');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('refuses an empty change and an impossible one before anyone is asked', async () => {
    const same = setup(routes());
    await expect(
      describeConsumablesChange(same.client, {
        ...BASE,
        consumables: [{ product_id: 5, quantity: 30 }],
      })
    ).rejects.toThrow(ConfirmationRefusal);

    const wrong = setup(routes());
    await expect(
      describeConsumablesChange(wrong.client, { ...BASE, service_id: 4 })
    ).rejects.toThrow(ConfirmationRefusal);
  });
});

describe('setConsumables against the version the person was shown', () => {
  const KEY = '0f6b1c2d-3e4f-8a5b-9c6d-7e8f9a0b1c2d';
  const REPLACE: SetConsumablesInput = {
    ...BASE,
    replace: true,
    consumables: [{ product_id: 5, quantity: 30 }],
  };

  async function shown(input: SetConsumablesInput, attendance = 1) {
    const { client } = setup(routes(attendance));
    const { version } = await describeConsumablesChange(client, input);
    return { version, idempotency_key: KEY } satisfies ConfirmedCall;
  }

  it('writes when nothing moved since the confirmation, handing the port the key', async () => {
    const confirmation = await shown(REPLACE);
    const spy = jest.spyOn(
      InventoryAdapter.prototype,
      'setAppointmentServiceConsumables'
    );
    try {
      const { client, calls } = setup(routes());
      await setConsumables(client, REPLACE, confirmation);
      expect(calls.some((c) => c.method === 'PUT')).toBe(true);
      expect((spy.mock.calls[0] as unknown[])[4]).toEqual({
        idempotency_key: KEY,
      });
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a confirmed replace when a line was added after the confirmation', async () => {
    const confirmation = await shown(REPLACE);
    const later = [
      block(9, 3, [
        { line: 61, product: 5, amount: 30 },
        { line: 62, product: 6, amount: 10 },
        { line: 65, product: 8, amount: 2 },
      ]),
      VISIT[1],
    ];
    const { client, calls } = setup([
      putRoute,
      readRoute(later),
      appointmentRoute(1),
      currencyRoute,
    ]);
    const error = await setConsumables(client, REPLACE, confirmation).catch(
      (e) => e
    );
    expect(error).toBeInstanceOf(InventoryInputError);
    expect(error.message).toContain('changed after the confirmation was shown');
    expect(error.message).toContain('appointments_get_consumables');
    expect(error.message).toContain('without confirmation_token');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('refuses when the appointment was marked arrived since: stock would now move', async () => {
    const input = { ...BASE, consumables: [{ product_id: 6, quantity: 12 }] };
    const confirmation = await shown(input, 2);
    const { client, calls } = setup(routes(1));
    await expect(setConsumables(client, input, confirmation)).rejects.toThrow(
      'changed after the confirmation was shown'
    );
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('says no line remains instead of listing none', async () => {
    const { client } = setup(routes());
    const result = await setConsumables(client, {
      ...BASE,
      consumables: [
        { product_id: 5, quantity: 0 },
        { product_id: 6, quantity: 0 },
      ],
    });
    const ours = summary(result.text);
    expect(ours).toContain('No consumables remain on this service.');
    expect(ours).not.toContain('every line has a new line id');
  });
});
