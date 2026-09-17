/**
 * The scope gate, end to end over the real HTTP surface.
 *
 * The unit tests pin the rules; this pins the wiring, which is the part that
 * can silently rot: the proxy's `x-mcp-auth-scope` header has to survive the
 * Express route, the Streamable HTTP transport and the SDK's deferred handler
 * scheduling and still be readable at the `tools/call` boundary. Everything
 * below therefore goes through `createApp()` and a real session — no stubbing
 * of the request context.
 *
 * Four things are asserted, in the order they matter:
 *
 *  1. A caller that declares no scopes is unaffected. That is every
 *     deployment today, and a regression here breaks all of them at once.
 *  2. A caller whose token lacks the scope is refused *in band* — HTTP 200,
 *     a JSON-RPC result with `isError`, an actionable message, no upstream
 *     call, and a session that is still usable afterwards.
 *  3. A caller that holds the scope gets through to the API.
 *  4. `tools/list` does not depend on the caller's scopes (ADR-001 D7).
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

interface JsonRpcToolResult {
  result: {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
}

interface JsonRpcToolList {
  result: { tools: Array<{ name: string }> };
}

describe('token scopes gate execution, end to end', () => {
  const nativeFetch = global.fetch;
  let credentialsDir: string;
  let httpServer: HttpServer;
  let url: string;
  /** Upstream calls the mocked fetch saw, so a refusal can be shown to be silent. */
  let upstreamCalls: string[];
  /** Sessions opened by a test, torn down after it so no transport leaks. */
  let openSessions: string[];

  beforeAll(async () => {
    credentialsDir = mkdtempSync(join(tmpdir(), 'altegio-scope-e2e-'));
    process.env.CREDENTIALS_DIR = credentialsDir;

    const { app } = createApp();
    httpServer = app.listen(0);
    await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    const { port } = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/mcp`;
  });

  beforeEach(() => {
    upstreamCalls = [];
    openSessions = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const target = String(input);
      if (target.startsWith('https://api.alteg.io/')) {
        upstreamCalls.push(target);
        return new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return nativeFetch(input, init);
    });
  });

  afterEach(async () => {
    // Every session holds a Streamable HTTP transport; end them explicitly so
    // the suite does not leave workers behind.
    await Promise.all(
      openSessions.map((sessionId) =>
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

  /**
   * Open a real MCP session whose requests carry the proxy identity headers,
   * with or without a granted scope list, and return a poster bound to it.
   */
  const openSession = async (scope?: string) => {
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      // A user token on the request keeps the tools authenticated without a
      // password login, which is not what this test is about.
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
        clientInfo: { name: 'scope-e2e', version: '1.0.0' },
      },
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id') as string;
    expect(sessionId).toBeTruthy();
    openSessions.push(sessionId);
    await parseSse(init);
    await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId
    );

    let nextId = 2;
    return {
      sessionId,
      call: (name: string, args: Record<string, unknown> = {}) =>
        post(
          {
            jsonrpc: '2.0',
            id: nextId++,
            method: 'tools/call',
            params: { name, arguments: args },
          },
          sessionId
        ),
      list: () =>
        post({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' }, sessionId),
    };
  };

  it('lets a caller that declares no scopes through unchanged', async () => {
    const session = await openSession();
    const payload = await parseSse<JsonRpcToolResult>(
      await session.call('list_locations', { my: 1, count: 1 })
    );

    expect(payload.result.isError).not.toBe(true);
    expect(upstreamCalls).toHaveLength(1);
  });

  it('refuses in band when the token lacks the scope, and keeps the session', async () => {
    const session = await openSession('appointments:read clients:read');

    const denied = await session.call('list_locations', { my: 1, count: 1 });
    // In band: a 200 carrying a JSON-RPC result, not an HTTP 403 and not a
    // protocol error — the session must survive a denial.
    expect(denied.status).toBe(200);
    const payload = await parseSse<JsonRpcToolResult>(denied);

    expect(payload.result.isError).toBe(true);
    const text = payload.result.content[0]!.text;
    expect(text).toContain('list_locations');
    expect(text).toContain('locations:read');
    expect(text).toContain('appointments:read, clients:read');
    expect(text).toContain('Do not retry');

    // Nothing reached Altegio: the gate runs before the handler.
    expect(upstreamCalls).toEqual([]);

    // The same session still works for a tool the token does cover.
    const allowed = await parseSse<JsonRpcToolResult>(
      await session.call('clients_lookup', {
        location_id: 4564,
        query: 'ivan',
      })
    );
    expect(allowed.result.isError).not.toBe(true);
    expect(upstreamCalls).toHaveLength(1);
  });

  it('lets the call through when the token carries the scope', async () => {
    const session = await openSession('locations:read team_members:read');
    const payload = await parseSse<JsonRpcToolResult>(
      await session.call('list_locations', { my: 1, count: 1 })
    );

    expect(payload.result.isError).not.toBe(true);
    expect(upstreamCalls).toHaveLength(1);
  });

  it('honours write ⊇ read across the wire', async () => {
    const session = await openSession('locations:write');
    const payload = await parseSse<JsonRpcToolResult>(
      await session.call('list_locations', { my: 1, count: 1 })
    );

    expect(payload.result.isError).not.toBe(true);
  });

  it('serves the same tools/list whatever the caller was granted', async () => {
    // ADR-001 D7: one path, one tool list. A tool the caller cannot execute is
    // still listed — and explains itself when called.
    const unscoped = await openSession();
    const narrow = await openSession('clients:read');
    const wide = await openSession(
      'locations:read locations:write clients:write team_members:manage_access'
    );

    const names = async (session: { list: () => Promise<Response> }) =>
      (await parseSse<JsonRpcToolList>(await session.list())).result.tools.map(
        (tool) => tool.name
      );

    const baseline = await names(unscoped);
    expect(baseline.length).toBeGreaterThan(0);
    expect(await names(narrow)).toEqual(baseline);
    expect(await names(wide)).toEqual(baseline);
    // Listed for the narrow caller, and refused only on execution.
    expect(baseline).toContain('list_locations');
  });
});
