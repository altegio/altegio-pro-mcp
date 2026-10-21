/**
 * The curated-tool dispatcher, end to end over the real HTTP surface.
 *
 * A dispatched call must be authorised, confirmed and validated exactly like a
 * direct one, or the dispatcher is a way around every gate the direct path
 * has. So everything here goes through `createApp()`, a real session on
 * `/mcp/compact` and the proxy headers, with only the Altegio API mocked:
 *
 *  1. the compact view lists the short list and the dispatcher;
 *  2. `tools_search` answers over the wire;
 *  3. `tools_call_read` runs a read and refuses a change without calling out;
 *  4. a read-only grant refuses a write through `tools_call_write`, by the
 *     scope of the tool it names;
 *  5. a destructive tool asks for its own confirmation through the
 *     dispatcher, and runs on the repeat with the token inside `arguments`;
 *  6. no other address serves the dispatcher, and the refusal names the one
 *     that does.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server as HttpServer } from 'node:http';
import { createApp } from '../http-server.js';

interface ToolCallPayload {
  result?: {
    isError?: boolean;
    content: Array<{ text: string }>;
    structuredContent?: Record<string, unknown>;
  };
  error?: { message: string };
}

describe('the curated-tool dispatcher, end to end', () => {
  const nativeFetch = global.fetch;
  let credentialsDir: string;
  let httpServer: HttpServer;
  let base: string;
  /** Upstream calls the mocked fetch saw, as `METHOD url`. */
  let upstreamCalls: string[];
  let openSessions: Array<{ url: string; sessionId: string }>;

  beforeAll(async () => {
    credentialsDir = mkdtempSync(join(tmpdir(), 'altegio-dispatch-e2e-'));
    process.env.CREDENTIALS_DIR = credentialsDir;
    const { app } = createApp();
    httpServer = app.listen(0);
    await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    const { port } = httpServer.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => {
    upstreamCalls = [];
    openSessions = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const target = String(input);
      if (target.startsWith('https://api.alteg.io/')) {
        upstreamCalls.push(`${init?.method ?? 'GET'} ${target}`);
        return new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return nativeFetch(input, init);
    });
  });

  afterEach(async () => {
    await Promise.all(
      openSessions.map(({ url, sessionId }) =>
        nativeFetch(url, {
          method: 'DELETE',
          headers: { 'mcp-session-id': sessionId },
        }).catch(() => undefined)
      )
    );
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve()))
    );
    rmSync(credentialsDir, { recursive: true, force: true });
    delete process.env.CREDENTIALS_DIR;
  });

  const parseSse = async <T>(res: Response): Promise<T> => {
    const body = await res.text();
    const line = body
      .split('\n')
      .find((candidate) => candidate.startsWith('data:'));
    return JSON.parse((line ?? '').slice('data:'.length).trim()) as T;
  };

  /** A session on one address, as the proxy forwards it; no elicitation. */
  const openSession = async (path: string, scope?: string) => {
    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-altegio-user-token': 'direct-user-token',
      'x-mcp-auth-kind': 'user',
      'x-mcp-auth-email': 'operator@example.com',
      ...(scope === undefined ? {} : { 'x-mcp-auth-scope': scope }),
    };
    const post = (body: unknown, sessionId?: string) =>
      nativeFetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
        },
        body: JSON.stringify(body),
      });

    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'dispatch-e2e', version: '1.0.0' },
      },
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id') as string;
    openSessions.push({ url, sessionId });
    const initialized = await parseSse<{
      result: { instructions?: string };
    }>(init);
    await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId
    );

    let nextId = 2;
    return {
      instructions: initialized.result.instructions ?? '',
      call: async (name: string, args: Record<string, unknown> = {}) =>
        parseSse<ToolCallPayload>(
          await post(
            {
              jsonrpc: '2.0',
              id: nextId++,
              method: 'tools/call',
              params: { name, arguments: args },
            },
            sessionId
          )
        ),
      list: async () =>
        parseSse<{ result: { tools: Array<{ name: string }> } }>(
          await post(
            { jsonrpc: '2.0', id: nextId++, method: 'tools/list' },
            sessionId
          )
        ),
    };
  };

  const FULL_GRANT = 'mcp:pro:read mcp:pro:write';
  const READ_GRANT = 'mcp:pro:read';
  const textOf = (payload: ToolCallPayload) =>
    payload.result?.content.map((block) => block.text).join('\n') ?? '';

  it('lists the short list and the dispatcher, and says how to reach the rest', async () => {
    const session = await openSession('/mcp/compact', FULL_GRANT);
    const names = (await session.list()).result.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'tools_search',
        'tools_call_read',
        'tools_call_write',
        'appointments_list',
        'locations_list',
      ])
    );
    expect(names).not.toContain('memberships_freeze');
    expect(names).not.toContain('financial_transactions_create');
    expect(session.instructions).toMatch(/^This address lists the most used/);
  });

  it('finds an unlisted tool with tools_search, with no upstream call', async () => {
    const session = await openSession('/mcp/compact', FULL_GRANT);
    const found = await session.call('tools_search', {
      query: 'freeze a membership',
    });
    expect(found.result?.isError).not.toBe(true);
    const matches = found.result?.structuredContent?.matches as Array<{
      name: string;
      call_with: string;
    }>;
    expect(matches[0]).toMatchObject({
      name: 'memberships_freeze',
      call_with: 'tools_call_write',
    });
    expect(textOf(found)).toContain('memberships_freeze');
    expect(upstreamCalls).toEqual([]);
  });

  it('runs a read through tools_call_read, and refuses a change there without calling out', async () => {
    const session = await openSession('/mcp/compact', FULL_GRANT);
    const read = await session.call('tools_call_read', {
      tool: 'positions_list',
      arguments: { location_id: 4564 },
    });
    expect(read.result?.isError).not.toBe(true);
    expect(upstreamCalls.length).toBeGreaterThan(0);

    upstreamCalls = [];
    const change = await session.call('tools_call_read', {
      tool: 'services_delete',
      arguments: { location_id: 4564, service_id: 7 },
    });
    expect(change.result?.isError).toBe(true);
    expect(textOf(change)).toContain('Run it with tools_call_write');
    expect(upstreamCalls).toEqual([]);
  });

  it('answers a dispatched call with the tool’s own validation', async () => {
    const session = await openSession('/mcp/compact', FULL_GRANT);
    const invalid = await session.call('tools_call_read', {
      tool: 'positions_list',
      arguments: { location_id: 'not a number' },
    });
    expect(invalid.result?.isError).toBe(true);
    expect(textOf(invalid)).toContain('location_id');
    expect(upstreamCalls).toEqual([]);
  });

  it('refuses a write through tools_call_write on a read-only grant, by the tool’s own scope', async () => {
    const session = await openSession('/mcp/compact', READ_GRANT);
    const denied = await session.call('tools_call_write', {
      tool: 'services_delete',
      arguments: { location_id: 4564, service_id: 7 },
    });
    expect(denied.result?.isError).toBe(true);
    expect(textOf(denied)).toContain('services_delete');
    expect(textOf(denied)).toContain('mcp:pro:read');
    // Refused before the confirmation resolves its target: nothing upstream.
    expect(upstreamCalls).toEqual([]);
  });

  it('asks for the tool’s own confirmation through the dispatcher, and runs on the repeat', async () => {
    const session = await openSession('/mcp/compact', FULL_GRANT);
    const args = { location_id: 4564, service_id: 7 };
    const asked = await session.call('tools_call_write', {
      tool: 'services_delete',
      arguments: args,
    });
    expect(asked.result?.structuredContent).toMatchObject({
      status: 'confirmation_required',
      changed: false,
      tool: 'services_delete',
    });
    expect(textOf(asked)).toContain(
      'call tools_call_write again with tool "services_delete" and the same arguments, adding confirmation_token'
    );
    expect(upstreamCalls.some((call) => call.startsWith('DELETE'))).toBe(false);

    const token = asked.result!.structuredContent!.confirmation_token as string;
    const done = await session.call('tools_call_write', {
      tool: 'services_delete',
      arguments: { ...args, confirmation_token: token },
    });
    expect(done.result?.isError).not.toBe(true);
    expect(
      upstreamCalls.filter((call) => call.startsWith('DELETE'))
    ).toHaveLength(1);

    // The same token does not fit another service.
    const other = await session.call('tools_call_write', {
      tool: 'services_delete',
      arguments: { ...args, service_id: 8, confirmation_token: token },
    });
    expect(other.result?.isError).toBe(true);
    expect(textOf(other)).toContain('not valid for these arguments');
  });

  it('runs a tool it does not list when named directly, past the same gates', async () => {
    const session = await openSession('/mcp/compact', READ_GRANT);
    const read = await session.call('positions_list', {
      location_id: 4564,
    });
    expect(read.result?.isError).not.toBe(true);
    const write = await session.call('memberships_freeze', {
      location_id: 4564,
      membership_id: 1,
    });
    expect(write.result?.isError).toBe(true);
    expect(textOf(write)).toContain('mcp:pro:read');
  });

  it('is served on /mcp/compact only; /mcp names the address that serves it', async () => {
    const session = await openSession('/mcp', FULL_GRANT);
    const names = (await session.list()).result.tools.map((tool) => tool.name);
    expect(names).not.toContain('tools_call_read');
    const refused = await session.call('tools_call_read', {
      tool: 'positions_list',
      arguments: { location_id: 4564 },
    });
    expect(refused.error?.message).toContain('/compact');
    expect(upstreamCalls).toEqual([]);
  });
});
