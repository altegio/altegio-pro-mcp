/**
 * Opt-in live suite for the replay and lost-update guards, through the real
 * `tools/call` path of a host without elicitation (the confirmation-token
 * path): record a product receipt, repeat the confirmed call and see it
 * refused, then delete the document; set a consumable on a fresh waiting
 * appointment, change it after a confirmation was shown and see the confirmed
 * call refused, then delete the appointment.
 *
 * Skipped unless `ALTEGIO_E2E=1`. Credentials and fixture ids come from the
 * environment, never a file in this public repo:
 *
 * - `ALTEGIO_E2E_LOCATION_ID` — a disposable test location;
 * - `ALTEGIO_E2E_PRODUCT_ID` — a cheap plain product;
 * - `ALTEGIO_E2E_INVENTORY_ID` — an inventory to receive it into;
 * - `ALTEGIO_E2E_OPERATION_TEAM_MEMBER_ID` — a team member who may record
 *   inventory operations there;
 * - `ALTEGIO_E2E_CLIENT_ID` — a client with no reachable phone or email;
 * - `ALTEGIO_E2E_TEAM_MEMBER_ID`, `ALTEGIO_E2E_SERVICE_ID` — a team member who
 *   provides the service;
 * - `ALTEGIO_E2E_CONSUMABLES_INVENTORY_ID` — the consumables inventory.
 *
 * The appointment stays waiting, so its consumables never move stock, and it
 * is created by the suite: a consumables change detaches a Bill of Materials,
 * so never point this at an existing appointment.
 *
 *   ALTEGIO_E2E=1 CREDENTIALS_DIR=/tmp/altegio-mcp-live \
 *     ALTEGIO_API_TOKEN=… ALTEGIO_USER_TOKEN=… ALTEGIO_E2E_LOCATION_ID=… … \
 *     npx jest replay-guards-live
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AltegioClient } from '../providers/altegio-client.js';
import { httpFromClient } from '../api/altegio-http.js';
import { registerTools } from '../tools/registry.js';
import { CONFIRMATION_TOKEN_ARG } from '../tools/confirmation.js';
import { setConsumables } from '../capabilities/inventory/consumables.js';

const LIVE = process.env.ALTEGIO_E2E === '1';
const CREDENTIALS_DIR = process.env.CREDENTIALS_DIR ?? '/tmp/altegio-mcp-live';
const env = (name: string) => Number(process.env[name]);

const describeLive = LIVE ? describe : describe.skip;

function textOf(result: CallToolResult): string {
  const block = result.content[0];
  return block && block.type === 'text' ? block.text : '';
}

describeLive('replay and lost-update guards against the test location', () => {
  const location = env('ALTEGIO_E2E_LOCATION_ID');
  const product = env('ALTEGIO_E2E_PRODUCT_ID');
  const inventory = env('ALTEGIO_E2E_INVENTORY_ID');
  const operator = env('ALTEGIO_E2E_OPERATION_TEAM_MEMBER_ID');
  const clientId = env('ALTEGIO_E2E_CLIENT_ID');
  const teamMember = env('ALTEGIO_E2E_TEAM_MEMBER_ID');
  const service = env('ALTEGIO_E2E_SERVICE_ID');
  const consumablesInventory = env('ALTEGIO_E2E_CONSUMABLES_INVENTORY_ID');
  let altegio: AltegioClient;
  let host: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const partnerToken =
      process.env.ALTEGIO_API_TOKEN ??
      process.env.ALTEGIO_PARTNER_TOKEN ??
      process.env.ALTEGIO_LIVE_API_TOKEN;
    const userToken = process.env.ALTEGIO_USER_TOKEN;
    const ids = [
      location,
      product,
      inventory,
      operator,
      clientId,
      teamMember,
      service,
      consumablesInventory,
    ];
    if (!partnerToken || !userToken || ids.some((v) => !(v > 0))) {
      throw new Error(
        'The live suite needs ALTEGIO_API_TOKEN, ALTEGIO_USER_TOKEN and every ALTEGIO_E2E_* id named in the header.'
      );
    }
    altegio = new AltegioClient({ partnerToken, userToken }, CREDENTIALS_DIR);
    const server = new Server(
      { name: 'replay-guards-live', version: '0.0.0' },
      { capabilities: { tools: {} } }
    );
    registerTools(server, altegio);
    // No elicitation: every write goes through the confirmation token.
    host = new Client({ name: 'token-host', version: '0.0.0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([host.connect(a), server.connect(b)]);
    close = async () => {
      await host.close();
      await server.close();
    };
  });

  afterAll(async () => close?.());

  const call = async (name: string, args: Record<string, unknown>) =>
    (await host.callTool({ name, arguments: args })) as CallToolResult;

  /** Ask, take the token, and repeat with it: what a host without forms does. */
  async function confirmed(name: string, args: Record<string, unknown>) {
    const asked = await call(name, args);
    expect(asked.structuredContent).toMatchObject({
      status: 'confirmation_required',
    });
    const token = (asked.structuredContent as Record<string, string>)[
      CONFIRMATION_TOKEN_ARG
    ]!;
    return {
      asked,
      token,
      run: () => call(name, { ...args, [CONFIRMATION_TOKEN_ARG]: token }),
    };
  }

  it('refuses a repeated confirmed receipt, and the document is deleted', async () => {
    const receipt = {
      location_id: location,
      kind: 'receipt',
      team_member_id: operator,
      inventory_id: inventory,
      lines: [{ product_id: product, quantity: 1, unit_price: 1 }],
      comment: `replay-guards-live ${Date.now()}: deleted by the suite`,
    };
    const { asked, run } = await confirmed(
      'inventory_create_operation',
      receipt
    );
    expect(textOf(asked)).toContain('valid for these arguments until');

    const recorded = await run();
    expect(recorded.isError).toBeFalsy();
    const document = (
      recorded.structuredContent as { document: { id: number } }
    ).document.id;
    expect(document).toBeGreaterThan(0);

    // A repeat the guard misses is a second document; delete it too.
    const documents = [document];
    try {
      // The same token, the same arguments: the guard finds the document.
      const repeated = await run();
      const twice = (
        repeated.structuredContent as { document?: { id: number } } | undefined
      )?.document?.id;
      if (twice) documents.push(twice);
      expect(repeated.isError).toBe(true);
      expect(textOf(repeated)).toContain(
        `Nothing was recorded: document ${document}`
      );
      // And a fresh confirmation is refused before anyone is asked.
      const again = await call('inventory_create_operation', receipt);
      expect(again.isError).toBe(true);
      expect(textOf(again)).toContain(`document ${document}`);
    } finally {
      for (const id of documents) {
        const removal = await confirmed('inventory_delete_document', {
          location_id: location,
          document_id: id,
        });
        const deleted = await removal.run();
        expect(deleted.structuredContent).toMatchObject({ deleted: true });
      }
    }
  }, 120_000);

  it('refuses a confirmed consumables change once the list moved, and the appointment is deleted', async () => {
    const day = new Date(Date.now() - 4 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const created = await httpFromClient(altegio).request(
      `/locations/${location}/appointments`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          staff_id: teamMember,
          services: [{ id: service }],
          client: { id: clientId },
          datetime: `${day}T06:00:00`,
          seance_length: 3600,
          send_sms: 0,
          sms_remain_hours: 0,
          email_remain_hours: 0,
          attendance: 0,
          save_if_busy: true,
          comment: 'replay-guards-live: deleted by the suite',
        }),
      }
    );
    const appointment = ((await created.json()) as { data?: { id?: number } })
      .data?.id;
    expect(created.status).toBeLessThan(300);
    expect(appointment).toBeGreaterThan(0);

    const target = {
      location_id: location,
      appointment_id: appointment!,
      service_id: service,
    };
    const line = (quantity: number) => ({
      product_id: product,
      quantity,
      inventory_id: consumablesInventory,
    });
    const quantityNow = async () => {
      const read = await call('appointments_get_consumables', {
        location_id: location,
        appointment_id: appointment!,
      });
      const services = (
        read.structuredContent as {
          services: Array<{
            service_id: number;
            lines: Array<{ product_id: number; quantity: number }>;
          }>;
        }
      ).services;
      return services
        .find((s) => s.service_id === service)
        ?.lines.find((l) => l.product_id === product)?.quantity;
    };

    try {
      const first = await confirmed('appointments_set_consumables', {
        ...target,
        consumables: [line(2)],
      });
      expect((await first.run()).isError).toBeFalsy();
      expect(await quantityNow()).toBe(2);

      // The person is shown 2 → 3 under replace …
      const replace = await confirmed('appointments_set_consumables', {
        ...target,
        replace: true,
        consumables: [line(3)],
      });
      expect(textOf(replace.asked)).toContain('2 ml → 3 ml');
      // … someone else changes the line before the confirmed call runs …
      await setConsumables(altegio, {
        ...target,
        replace: false,
        consumables: [line(4)],
      });
      // … so the confirmed call no longer makes the change approved.
      const refused = await replace.run();
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain(
        'changed after the confirmation was shown'
      );
      expect(await quantityNow()).toBe(4);
    } finally {
      await altegio.deleteBooking(location, appointment!);
    }
  }, 120_000);
});
