/**
 * Shared pieces of the opt-in live suites (`*-live.test.ts`): the
 * `ALTEGIO_E2E=1` gate, the fixture ids and credentials from the environment
 * (never a file in this public repo), a real `tools/call` host without
 * elicitation, so every write goes through the confirmation token, and a
 * disposable appointment.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AltegioClient } from '../../providers/altegio-client.js';
import { httpFromClient } from '../../api/altegio-http.js';
import { registerTools } from '../../tools/registry.js';
import { CONFIRMATION_TOKEN_ARG } from '../../tools/confirmation.js';
import { ALL_TOOLS_FACET } from '../../tools/facets.js';

export const LIVE = process.env.ALTEGIO_E2E === '1';
export const describeLive = LIVE ? describe : describe.skip;

const CREDENTIALS_DIR = process.env.CREDENTIALS_DIR ?? '/tmp/altegio-mcp-live';

/**
 * The fixture ids a suite needs, each from `ALTEGIO_E2E_<NAME>`; throws
 * naming the missing ones, so a run without them fails instead of writing
 * somewhere else.
 */
export function liveIds<const K extends string>(
  names: readonly K[]
): Record<K, number> {
  const ids = {} as Record<K, number>;
  const missing: string[] = [];
  for (const name of names) {
    const value = Number(process.env[`ALTEGIO_E2E_${name}`]);
    if (Number.isInteger(value) && value > 0) ids[name] = value;
    else missing.push(`ALTEGIO_E2E_${name}`);
  }
  if (missing.length > 0) {
    throw new Error(`The live suite needs ${missing.join(', ')}.`);
  }
  return ids;
}

/** A client on the partner and user tokens the live suites share. */
export function liveClient(): AltegioClient {
  const partnerToken =
    process.env.ALTEGIO_API_TOKEN ??
    process.env.ALTEGIO_PARTNER_TOKEN ??
    process.env.ALTEGIO_LIVE_API_TOKEN;
  const userToken = process.env.ALTEGIO_USER_TOKEN;
  if (!partnerToken || !userToken) {
    throw new Error(
      'The live suite needs ALTEGIO_API_TOKEN (or a live-test alias) and ALTEGIO_USER_TOKEN.'
    );
  }
  return new AltegioClient({ partnerToken, userToken }, CREDENTIALS_DIR);
}

export function textOf(result: CallToolResult): string {
  const block = result.content[0];
  return block && block.type === 'text' ? block.text : '';
}

export interface LiveHost {
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  /** The structured result of a call that must succeed. */
  read<T>(name: string, args: Record<string, unknown>): Promise<T>;
  /** Ask, take the token, and repeat with it: what a host without forms does. */
  confirmed(
    name: string,
    args: Record<string, unknown>
  ): Promise<{ asked: CallToolResult; run: () => Promise<CallToolResult> }>;
  close(): Promise<void>;
}

/** Every tool, served over the SDK to a host that cannot show forms. */
export async function liveHost(
  client: AltegioClient,
  name: string
): Promise<LiveHost> {
  const server = new Server(
    { name, version: '0.0.0' },
    { capabilities: { tools: {} } }
  );
  registerTools(server, client, { facet: ALL_TOOLS_FACET });
  const host = new Client({ name: 'token-host', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([host.connect(a), server.connect(b)]);

  const call = async (tool: string, args: Record<string, unknown>) =>
    (await host.callTool({ name: tool, arguments: args })) as CallToolResult;
  return {
    call,
    async read<T>(tool: string, args: Record<string, unknown>) {
      const result = await call(tool, args);
      if (result.isError) {
        throw new Error(`${tool} failed: ${textOf(result).slice(0, 300)}`);
      }
      return result.structuredContent as T;
    },
    async confirmed(tool: string, args: Record<string, unknown>) {
      const asked = await call(tool, args);
      expect(asked.structuredContent).toMatchObject({
        status: 'confirmation_required',
      });
      const token = (asked.structuredContent as Record<string, string>)[
        CONFIRMATION_TOKEN_ARG
      ]!;
      return {
        asked,
        run: () => call(tool, { ...args, [CONFIRMATION_TOKEN_ARG]: token }),
      };
    },
    async close() {
      await host.close();
      await server.close();
    },
  };
}

/** `YYYY-MM-DD`, `daysFromNow` days from today (UTC). */
export function isoDay(daysFromNow: number): string {
  return new Date(Date.now() + daysFromNow * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * A one-hour appointment for the client that cannot be messaged, created on
 * the V1 route with every notification off. Waiting unless `attendance` says
 * otherwise (1 arrived); delete it with `client.deleteBooking`.
 */
export async function createAppointment(
  client: AltegioClient,
  fixture: {
    location: number;
    team_member: number;
    service: number;
    client: number;
  },
  options: {
    day: string;
    time: string;
    comment: string;
    attendance?: 0 | 1 | 2;
  }
): Promise<number> {
  const created = await httpFromClient(client).request(
    `/locations/${fixture.location}/appointments`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        staff_id: fixture.team_member,
        services: [{ id: fixture.service }],
        client: { id: fixture.client },
        datetime: `${options.day}T${options.time}:00`,
        seance_length: 3600,
        send_sms: 0,
        sms_remain_hours: 0,
        email_remain_hours: 0,
        attendance: options.attendance ?? 0,
        save_if_busy: true,
        comment: options.comment,
      }),
    }
  );
  const body = (await created.json()) as { data?: { id?: number } };
  expect(created.status).toBeLessThan(300);
  expect(body.data?.id).toBeGreaterThan(0);
  return body.data!.id!;
}

/** Whether the V1 read of an appointment reports it deleted. */
export async function isDeleted(
  client: AltegioClient,
  location: number,
  appointment: number
): Promise<boolean> {
  const response = await httpFromClient(client).request(
    `/record/${location}/${appointment}`,
    { method: 'GET' }
  );
  const body = (await response.json()) as { data?: { deleted?: boolean } };
  return response.status === 404 || body.data?.deleted === true;
}
