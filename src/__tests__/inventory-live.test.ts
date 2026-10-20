/**
 * Opt-in live suite for the inventory tools, through the real `tools/call`
 * path of a host without elicitation: a product receipt, a write-off and a
 * sale, each deleted again and the stock back where it was; and the
 * consumables of a fresh waiting appointment set, changed and cleared, so the
 * appointment reads back as it was before it is deleted. The replay guard of
 * a receipt is in `replay-guards-live.test.ts`.
 *
 * Skipped unless `ALTEGIO_E2E=1`. Credentials and fixture ids come from the
 * environment, never a file in this public repo:
 *
 * - `ALTEGIO_E2E_LOCATION_ID` — a disposable test location;
 * - `ALTEGIO_E2E_PRODUCT_ID` — a cheap plain product;
 * - `ALTEGIO_E2E_INVENTORY_ID` — a sale inventory that holds it; the
 *   write-off and the sale take one unit, so the location must allow negative
 *   stock or the inventory must hold one;
 * - `ALTEGIO_E2E_OPERATION_TEAM_MEMBER_ID` — a team member who may record
 *   inventory operations there;
 * - `ALTEGIO_E2E_CLIENT_ID` — a client with no reachable phone or email;
 * - `ALTEGIO_E2E_TEAM_MEMBER_ID`, `ALTEGIO_E2E_SERVICE_ID` — a team member who
 *   provides a service with no Bill of Materials;
 * - `ALTEGIO_E2E_CONSUMABLES_INVENTORY_ID` — the consumables inventory.
 *
 * The appointment stays waiting, so its consumables never move stock, and it
 * is created by the suite: a consumables change detaches a Bill of Materials,
 * so never point this at an existing appointment.
 *
 *   ALTEGIO_E2E=1 CREDENTIALS_DIR=/tmp/altegio-mcp-live \
 *     ALTEGIO_API_TOKEN=… ALTEGIO_USER_TOKEN=… ALTEGIO_E2E_LOCATION_ID=… … \
 *     npx jest inventory-live
 */
import type { AltegioClient } from '../providers/altegio-client.js';
import {
  createAppointment,
  describeLive,
  isDeleted,
  isoDay,
  liveClient,
  liveHost,
  liveIds,
  textOf,
  type LiveHost,
} from './helpers/live.js';

type Kind = 'receipt' | 'write_off' | 'sale';

interface Movement {
  document_id: number | null;
  kind: string;
  date: string | null;
  product_id: number | null;
  quantity: number | null;
  direction: 'in' | 'out' | null;
  inventory_id: number | null;
}
interface Recorded {
  document: { id: number; kind: string };
  lines: Movement[];
}
interface Consumables {
  attendance: string;
  stock_moved: boolean;
  services: Array<{
    service_id: number;
    bill_of_materials: { id: number } | null;
    lines: Array<{
      line_id: number | null;
      product_id: number;
      inventory_id: number;
      quantity: number;
    }>;
  }>;
}

describeLive('inventory tools against the test location', () => {
  let ids: Record<
    | 'LOCATION_ID'
    | 'PRODUCT_ID'
    | 'INVENTORY_ID'
    | 'OPERATION_TEAM_MEMBER_ID'
    | 'CLIENT_ID'
    | 'TEAM_MEMBER_ID'
    | 'SERVICE_ID'
    | 'CONSUMABLES_INVENTORY_ID',
    number
  >;
  let altegio: AltegioClient;
  let host: LiveHost;
  /** What each kind's create result and the listing said, for the checks below. */
  const reported: Partial<
    Record<Kind, { created: Movement; listed: Movement; at: number }>
  > = {};

  beforeAll(async () => {
    ids = liveIds([
      'LOCATION_ID',
      'PRODUCT_ID',
      'INVENTORY_ID',
      'OPERATION_TEAM_MEMBER_ID',
      'CLIENT_ID',
      'TEAM_MEMBER_ID',
      'SERVICE_ID',
      'CONSUMABLES_INVENTORY_ID',
    ]);
    altegio = liveClient();
    host = await liveHost(altegio, 'inventory-live');
  });

  afterAll(async () => host?.close());

  const at = () => ({ location_id: ids.LOCATION_ID });

  /** The product's stock in an inventory, in the sale or consumable unit. */
  const stockIn = async (
    inventory: number,
    unit: 'sale_quantity' | 'consumable_quantity'
  ) => {
    const found = await host.read<{
      items: Array<{
        stock: Array<{
          inventory_id: number;
          sale_quantity: number | null;
          consumable_quantity: number | null;
        }> | null;
      }>;
    }>('products_search', { ...at(), product_ids: [ids.PRODUCT_ID] });
    const row = found.items[0]?.stock?.find(
      (s) => s.inventory_id === inventory
    );
    return row?.[unit] ?? 0;
  };

  const linesOf = async (document: number) =>
    (
      await host.read<{ items: Movement[] }>('inventory_list_operations', {
        ...at(),
        document_id: document,
      })
    ).items;

  const deleteDocument = async (document: number) => {
    const removal = await host.confirmed('inventory_delete_document', {
      ...at(),
      document_id: document,
    });
    const deleted = await removal.run();
    expect(deleted.structuredContent).toMatchObject({ deleted: true });
  };

  const operation = (kind: Kind, extra: Record<string, unknown> = {}) => ({
    ...at(),
    kind,
    team_member_id: ids.OPERATION_TEAM_MEMBER_ID,
    inventory_id: ids.INVENTORY_ID,
    lines: [{ product_id: ids.PRODUCT_ID, quantity: 1, unit_price: 1 }],
    comment: `inventory-live ${kind} ${Date.now()}: deleted by the suite`,
    ...extra,
  });

  it.each<[Kind, number]>([
    ['receipt', 1],
    ['write_off', -1],
    ['sale', -1],
  ])(
    'records a %s, and deleting its document puts the stock back',
    async (kind, change) => {
      const before = await stockIn(ids.INVENTORY_ID, 'sale_quantity');
      const create = await host.confirmed(
        'inventory_create_operation',
        operation(kind)
      );
      const recordedAt = Date.now();
      const created = await create.run();
      expect(created.isError).toBeFalsy();
      const result = created.structuredContent as unknown as Recorded;
      const document = result.document.id;
      expect(result.document.kind).toBe(kind);

      try {
        expect(await stockIn(ids.INVENTORY_ID, 'sale_quantity')).toBeCloseTo(
          before + change,
          6
        );
        const lines = await linesOf(document);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({
          kind,
          product_id: ids.PRODUCT_ID,
          inventory_id: ids.INVENTORY_ID,
          quantity: 1,
          direction: change > 0 ? 'in' : 'out',
        });
        reported[kind] = {
          created: result.lines[0]!,
          listed: lines[0]!,
          at: recordedAt,
        };
      } finally {
        await deleteDocument(document);
      }
      expect(await stockIn(ids.INVENTORY_ID, 'sale_quantity')).toBeCloseTo(
        before,
        6
      );
      expect(await linesOf(document)).toEqual([]);
    },
    120_000
  );

  // Known defect: the create answer carries unsigned line amounts, and the
  // result reads every line as moving stock in. Passing here means the defect
  // is gone — make it a plain `it`.
  it.failing('names the direction the stock moved in the create result', () => {
    expect(reported.write_off).toBeDefined();
    expect(reported.sale).toBeDefined();
    for (const kind of ['receipt', 'write_off', 'sale'] as const) {
      expect(reported[kind]!.created.direction).toBe(
        reported[kind]!.listed.direction
      );
    }
  });

  // Known defect: the listing labels the location's wall time with the
  // server's offset, so the instant is off by the difference. Passing here
  // means the defect is gone — make it a plain `it`.
  it.failing('lists a line at the instant it was recorded', () => {
    const receipt = reported.receipt!;
    const listedAt = Date.parse(receipt.listed.date!);
    expect(Math.abs(listedAt - receipt.at)).toBeLessThan(5 * 60_000);
  });

  // Known defect: the repeat guard reads the location's day, but the listing
  // files a line under another day near midnight, so a repeat dated just
  // after (east of UTC) or just before (west of it) midnight is recorded
  // twice. Passing here means the defect is gone — make it a plain `it`.
  it.failing(
    'refuses a repeated confirmed receipt dated near midnight',
    async () => {
      const recorded: number[] = [];
      try {
        for (const time of ['00:30', '23:30']) {
          const create = await host.confirmed(
            'inventory_create_operation',
            operation('receipt', { date: `${isoDay(-2)}T${time}` })
          );
          const first = await create.run();
          expect(first.isError).toBeFalsy();
          recorded.push(
            (first.structuredContent as unknown as Recorded).document.id
          );
          const repeated = await create.run();
          if (!repeated.isError) {
            recorded.push(
              (repeated.structuredContent as unknown as Recorded).document.id
            );
          }
          expect(textOf(repeated)).toContain(
            `Nothing was recorded: document ${recorded[recorded.length - 1]}`
          );
        }
      } finally {
        for (const document of recorded) await deleteDocument(document);
      }
    },
    120_000
  );

  it('sets, changes and clears a consumable, and the appointment reads back as it was', async () => {
    const appointment = await createAppointment(
      altegio,
      {
        location: ids.LOCATION_ID,
        team_member: ids.TEAM_MEMBER_ID,
        service: ids.SERVICE_ID,
        client: ids.CLIENT_ID,
      },
      {
        day: isoDay(-6),
        time: '06:00',
        comment: 'inventory-live: deleted by the suite',
      }
    );
    const read = () =>
      host.read<Consumables>('appointments_get_consumables', {
        ...at(),
        appointment_id: appointment,
      });
    const serviceOf = (c: Consumables) =>
      c.services.find((s) => s.service_id === ids.SERVICE_ID);
    const quantityOf = async () =>
      serviceOf(await read())?.lines.find(
        (l) => l.product_id === ids.PRODUCT_ID
      )?.quantity;
    const set = async (quantity: number, replace = false) => {
      const change = await host.confirmed('appointments_set_consumables', {
        ...at(),
        appointment_id: appointment,
        service_id: ids.SERVICE_ID,
        replace,
        consumables: [
          {
            product_id: ids.PRODUCT_ID,
            quantity,
            inventory_id: ids.CONSUMABLES_INVENTORY_ID,
          },
        ],
      });
      const done = await change.run();
      expect(done.isError).toBeFalsy();
      return { asked: textOf(change.asked), done };
    };

    try {
      const start = await read();
      expect(start.attendance).toBe('waiting');
      // A Bill of Materials would be detached for good by the first change.
      expect(serviceOf(start)?.bill_of_materials ?? null).toBeNull();
      const stockBefore = await stockIn(
        ids.CONSUMABLES_INVENTORY_ID,
        'consumable_quantity'
      );

      await set(2);
      expect(await quantityOf()).toBe(2);
      const first = serviceOf(await read())!.lines[0]!.line_id;

      const raised = await set(3, true);
      expect(raised.asked).toContain('2 ml → 3 ml');
      expect(await quantityOf()).toBe(3);
      expect(serviceOf(await read())!.lines[0]!.line_id).not.toBe(first);

      await set(0);
      const end = await read();
      expect(end.stock_moved).toBe(false);
      expect(serviceOf(end)?.lines ?? []).toEqual(
        serviceOf(start)?.lines ?? []
      );
      expect(
        await stockIn(ids.CONSUMABLES_INVENTORY_ID, 'consumable_quantity')
      ).toBeCloseTo(stockBefore, 6);
    } finally {
      await altegio.deleteBooking(ids.LOCATION_ID, appointment);
    }
    expect(await isDeleted(altegio, ids.LOCATION_ID, appointment)).toBe(true);
  }, 120_000);
});
