import { describe, it, expect } from '@jest/globals';
import type { AddressInfo } from 'net';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createApp, FACET_ROUTES } from '../http-server.js';
import { loadConfig } from '../config/schema.js';
import {
  ALL_TOOLS_FACET,
  DEFAULT_FACET,
  FACET_NAMES,
  READONLY_VIEW,
} from '../tools/facets.js';
import { orderedToolEntries } from '../tools/registry.js';
import {
  getRequestIdentity,
  identityKey,
  type RequestIdentity,
} from '../request-context.js';

/**
 * Integration-style test on the Express app: two POST /mcp requests carrying
 * different `x-mcp-auth-email` headers must land in different identity scopes.
 * We inject a fake transport that records the identity active while the SDK
 * message is handled (i.e. inside the runWithIdentity wrapper).
 */
describe('HTTP server per-request identity', () => {
  type Captured = RequestIdentity | null | undefined;

  const fakeTransport = (
    sink: (id: Captured) => void
  ): StreamableHTTPServerTransport =>
    ({
      handleRequest: async (
        _req: unknown,
        res: { status: (n: number) => { json: (b: unknown) => void } }
      ) => {
        sink(getRequestIdentity());
        res.status(202).json({ ok: true });
      },
    }) as unknown as StreamableHTTPServerTransport;

  // A POST reusing an existing session (a tool call), carrying identity headers.
  const post = (
    port: number,
    sessionId: string,
    headers: Record<string, string>
  ) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'probe', arguments: {} },
      }),
    });

  it('binds each POST request to its own delegated identity', async () => {
    const captured: Captured[] = [];
    const { app, transports } = createApp();
    transports['sess-1'] = fakeTransport((id) => captured.push(id));

    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;

      await post(port, 'sess-1', {
        'x-mcp-auth-kind': 'user',
        'x-mcp-auth-email': 'a@example.com',
      });
      await post(port, 'sess-1', {
        'x-mcp-auth-kind': 'user',
        'x-mcp-auth-email': 'b@example.com',
      });

      expect(captured).toHaveLength(2);
      expect(captured[0]).toMatchObject({
        kind: 'user',
        email: 'a@example.com',
      });
      expect(captured[1]).toMatchObject({
        kind: 'user',
        email: 'b@example.com',
      });

      // Distinct identities resolve to distinct token scopes.
      expect(identityKey(captured[0] as RequestIdentity)).not.toBe(
        identityKey(captured[1] as RequestIdentity)
      );
    } finally {
      server.close();
    }
  });

  it('treats a request without identity headers as anonymous (null)', async () => {
    let seen: Captured;
    const { app, transports } = createApp();
    transports['sess-2'] = fakeTransport((id) => {
      seen = id;
    });

    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      await post(port, 'sess-2', {});
      expect(seen).toBeNull();
    } finally {
      server.close();
    }
  });

  it('returns 404 for an unknown session without touching identity', async () => {
    const { app } = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await post(port, 'missing', {
        'x-mcp-auth-kind': 'user',
        'x-mcp-auth-email': 'a@example.com',
      });
      expect(res.status).toBe(404);
    } finally {
      server.close();
    }
  });
});

/**
 * The facet routes (ADR-001 D3): one MCP endpoint per facet, each with its own
 * session registry, the identity wrapper intact on all of them, and a JSON-RPC
 * shaped 404 for a facet this build does not serve.
 */
describe('HTTP server facet routes', () => {
  const jsonRpcBody = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  });

  const postTo = (port: number, path: string, sessionId: string) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
        'x-mcp-auth-kind': 'user',
        'x-mcp-auth-email': 'a@example.com',
      },
      body: jsonRpcBody,
    });

  it('serves a route for the default view, the read-only view and every facet', () => {
    expect(FACET_ROUTES.map((route) => route.path)).toEqual([
      '/mcp',
      `/mcp/${READONLY_VIEW}`,
      ...FACET_NAMES.map((facet) => `/mcp/${facet}`),
    ]);
    // The unfiltered view is stdio-only; it gets no HTTP route.
    expect(FACET_ROUTES.map((route) => route.facet)).not.toContain(
      ALL_TOOLS_FACET
    );
    const { transportsByFacet } = createApp();
    expect(Object.keys(transportsByFacet).sort()).toEqual(
      [DEFAULT_FACET, READONLY_VIEW, ...FACET_NAMES].sort()
    );
  });

  it('routes /mcp/readonly to its own handler, not the unknown-facet catch-all', () => {
    // The catch-all is registered after every known view; a path missing from
    // FACET_ROUTES would silently become a 404 instead of a served view.
    const { transportsByFacet } = createApp();
    expect(transportsByFacet[READONLY_VIEW]).toBeDefined();
    expect(transportsByFacet[READONLY_VIEW]).not.toBe(
      transportsByFacet[DEFAULT_FACET]
    );
  });

  it('keeps the identity wrapper on a facet route', async () => {
    let seen: RequestIdentity | null | undefined;
    const { app, transportsByFacet } = createApp();
    transportsByFacet.onboarding['sess-facet'] = {
      handleRequest: async (
        _req: unknown,
        res: { status: (n: number) => { json: (b: unknown) => void } }
      ) => {
        seen = getRequestIdentity();
        res.status(202).json({ ok: true });
      },
    } as unknown as StreamableHTTPServerTransport;

    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      await postTo(port, '/mcp/onboarding', 'sess-facet');
      expect(seen).toMatchObject({ kind: 'user', email: 'a@example.com' });
    } finally {
      server.close();
    }
  });

  it('keeps each facet session registry separate', async () => {
    const { app, transportsByFacet } = createApp();
    transportsByFacet.ops['sess-ops'] = {
      handleRequest: async (
        _req: unknown,
        res: { status: (n: number) => { json: (b: unknown) => void } }
      ) => {
        res.status(202).json({ ok: true });
      },
    } as unknown as StreamableHTTPServerTransport;

    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      expect((await postTo(port, '/mcp/ops', 'sess-ops')).status).toBe(202);
      // The same session id on another facet is not a session there.
      expect((await postTo(port, '/mcp/catalog', 'sess-ops')).status).toBe(404);
      expect((await postTo(port, '/mcp', 'sess-ops')).status).toBe(404);
    } finally {
      server.close();
    }
  });

  it('answers an unknown facet with a JSON-RPC error and 404', async () => {
    const { app } = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await postTo(port, '/mcp/nope', 'sess-none');
      expect(res.status).toBe(404);
      const body = (await res.json()) as {
        jsonrpc: string;
        error: { code: number; message: string };
        id: null;
      };
      expect(body.jsonrpc).toBe('2.0');
      expect(body.error.code).toBe(-32601);
      expect(body.error.message).toContain('Unknown facet: nope');
      expect(body.error.message).toContain('/mcp/ops');
      expect(body.error.message).toContain(`/mcp/${READONLY_VIEW}`);
      expect(body.id).toBeNull();
    } finally {
      server.close();
    }
  });

  it('answers an unknown facet on GET and DELETE too', async () => {
    const { app } = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      for (const method of ['GET', 'DELETE']) {
        const res = await fetch(`http://127.0.0.1:${port}/mcp/nope`, {
          method,
        });
        expect(res.status).toBe(404);
      }
    } finally {
      server.close();
    }
  });
});

/**
 * End-to-end over the real Express app and the real SDK transport: a facet path
 * must hand the session a server built for that facet, so `tools/list` on
 * `/mcp/ops` returns the ops view and `/mcp` returns everything.
 */
describe('HTTP server facet wiring, end to end', () => {
  const MCP_HEADERS = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };

  /** The transport answers with SSE; take the first `data:` payload. */
  const parseSse = async <T>(res: Response): Promise<T> => {
    const body = await res.text();
    const line = body
      .split('\n')
      .find((candidate) => candidate.startsWith('data:'));
    return JSON.parse((line ?? '').slice('data:'.length).trim()) as T;
  };

  const rpc = (
    port: number,
    path: string,
    body: unknown,
    headers: Record<string, string> = {}
  ) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, ...headers },
      body: JSON.stringify(body),
    });

  /** Initialize a session on `path` and return its tool names. */
  const toolNamesOn = async (port: number, path: string): Promise<string[]> => {
    const init = await rpc(port, path, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'facet-test', version: '1.0.0' },
      },
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await parseSse(init);

    const session = {
      'mcp-session-id': sessionId as string,
      'mcp-protocol-version': '2025-11-25',
    };
    await rpc(
      port,
      path,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      session
    );

    const list = await rpc(
      port,
      path,
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      session
    );
    const payload = await parseSse<{
      result: { tools: Array<{ name: string }> };
    }>(list);
    return payload.result.tools.map((tool) => tool.name);
  };

  it('serves the ops view on /mcp/ops and the whole surface on /mcp', async () => {
    const { app } = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;

      const ops = await toolNamesOn(port, '/mcp/ops');
      expect([...ops].sort()).toEqual([
        'appointments_apply_attendance',
        'appointments_create',
        'appointments_create_tag',
        'appointments_delete',
        'appointments_list',
        'appointments_list_tags',
        'appointments_preview_attendance',
        'appointments_update',
        'clients_add_comment',
        'clients_delete',
        'clients_get_card',
        'clients_get_membership_purchases',
        'clients_get_segment_report',
        'clients_get_visit_history',
        'clients_list_comments',
        'clients_list_files',
        'clients_list_profiles',
        'clients_lookup',
        'clients_search',
        'clients_upload_file',
        'events_book_clients',
        'events_create',
        'events_create_duplication_strategy',
        'events_delete',
        'events_delete_duplication_strategy',
        'events_duplicate',
        'events_get',
        'events_list',
        'events_list_dates',
        'events_list_duplication_strategies',
        'events_list_services',
        'events_reschedule_appointment',
        'events_update',
        'events_update_appointment',
        'events_update_duplication_strategy',
        'locations_list',
        'memberships_freeze',
        'memberships_list_for_client',
        'memberships_unfreeze',
        'users_get_current',
      ]);

      const all = await toolNamesOn(port, '/mcp');
      expect(all.length).toBeGreaterThan(ops.length);
      for (const name of ops) {
        expect(all).toContain(name);
      }
      // The default view keeps the onboarding walkthrough (switch off).
      expect(all.filter((name) => name.startsWith('onboarding_'))).toHaveLength(
        12
      );
    } finally {
      server.close();
    }
  });

  it('serves no password login and no access management on any HTTP path', async () => {
    const { app } = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const withheld = ['auth_login', 'auth_logout'];

      for (const path of ['/mcp', ...FACET_NAMES.map((f) => `/mcp/${f}`)]) {
        const names = await toolNamesOn(port, path);
        for (const name of withheld) {
          expect(names).not.toContain(name);
        }
      }
      // Access management stays on the facet a deployment opts into, but not
      // on the default path a generic agent lands on.
      expect(await toolNamesOn(port, '/mcp')).not.toContain(
        'locations_remove_user'
      );
      expect(await toolNamesOn(port, '/mcp/catalog')).toContain(
        'locations_remove_user'
      );
    } finally {
      server.close();
    }
  });

  it('serves only read-only tools on /mcp/readonly, over the real transport', async () => {
    const { app } = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const names = await toolNamesOn(port, `/mcp/${READONLY_VIEW}`);
      const entries = orderedToolEntries();

      expect(names.length).toBeGreaterThan(0);
      for (const name of names) {
        const spec = entries.find((entry) => entry.spec.name === name)?.spec;
        expect(spec?.annotations?.readOnlyHint).toBe(true);
      }
      // The whole analytics pack is here, which /mcp holds back.
      expect(names).toContain('analytics_get_daily_series');
      expect(await toolNamesOn(port, '/mcp')).not.toContain(
        'analytics_get_daily_series'
      );
    } finally {
      server.close();
    }
  });

  it('refuses a writing tool on /mcp/readonly instead of only hiding it', async () => {
    const { app } = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const path = `/mcp/${READONLY_VIEW}`;

      const init = await rpc(port, path, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'readonly-test', version: '1.0.0' },
        },
      });
      const sessionId = init.headers.get('mcp-session-id') as string;
      const initPayload = await parseSse<{
        result: { instructions?: string };
      }>(init);
      // The view states its own posture at initialize (task 3).
      expect(initPayload.result.instructions).toContain('READ-ONLY ENDPOINT');

      const session = {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': '2025-11-25',
      };
      await rpc(
        port,
        path,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        session
      );

      const call = await rpc(
        port,
        path,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'team_members_delete',
            arguments: { location_id: 1, staff_id: 2 },
          },
        },
        session
      );
      const payload = await parseSse<{
        error?: { code: number; message: string };
      }>(call);

      expect(payload.error).toBeDefined();
      expect(payload.error?.message).toContain('team_members_delete');
      expect(payload.error?.message).toContain('/mcp');
      // A tool refusal is an in-band JSON-RPC error; it must not take the HTTP
      // session down with a transport-level status.
      expect(call.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('gives every connection to a path the same list (ADR-001 D7)', async () => {
    const { app } = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      for (const path of ['/mcp', '/mcp/catalog', `/mcp/${READONLY_VIEW}`]) {
        const [first, second] = await Promise.all([
          toolNamesOn(port, path),
          toolNamesOn(port, path),
        ]);
        expect(second).toEqual(first);
      }
    } finally {
      server.close();
    }
  });
});

/**
 * Streamable HTTP session status codes, over the real transport. Sessions live
 * in process memory, so every restart forgets them all: a client still holding
 * one must get 404, which the transport defines as "start a new session with
 * `initialize`". 400 is only for a request that carries no session at all.
 */
describe('HTTP server session status codes', () => {
  const MCP_HEADERS = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
  };
  const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'session-test', version: '1.0.0' },
    },
  };
  const TOOLS_LIST = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {},
  };
  const SESSION_NOT_FOUND = {
    jsonrpc: '2.0',
    error: { code: -32001, message: 'Session not found' },
    id: null,
  };

  const send = (
    port: number,
    method: 'POST' | 'GET' | 'DELETE',
    sessionId: string | null,
    body?: unknown
  ) =>
    fetch(`http://127.0.0.1:${port}/mcp`, {
      method,
      headers: {
        ...MCP_HEADERS,
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const withApp = async (
    run: (port: number, app: ReturnType<typeof createApp>) => Promise<void>
  ) => {
    const created = createApp();
    const server = created.app.listen(0);
    try {
      await run((server.address() as AddressInfo).port, created);
    } finally {
      server.close();
    }
  };

  it('answers 404 for a session this process does not hold, on every method', async () => {
    await withApp(async (port) => {
      const stale = '6f1c2a4e-0000-4000-8000-000000000000';

      const post = await send(port, 'POST', stale, TOOLS_LIST);
      expect(post.status).toBe(404);
      expect(await post.json()).toEqual(SESSION_NOT_FOUND);

      // Even `initialize` carrying a dead session is refused: the client must
      // drop the old ID, as the transport requires, before starting over.
      expect((await send(port, 'POST', stale, INITIALIZE)).status).toBe(404);

      const get = await send(port, 'GET', stale);
      expect(get.status).toBe(404);
      expect(await get.json()).toEqual(SESSION_NOT_FOUND);

      const del = await send(port, 'DELETE', stale);
      expect(del.status).toBe(404);
      expect(await del.json()).toEqual(SESSION_NOT_FOUND);

      // A prototype key is not a session either.
      expect((await send(port, 'POST', 'constructor', TOOLS_LIST)).status).toBe(
        404
      );
    });
  });

  it('answers 400 only when the session ID is missing', async () => {
    await withApp(async (port) => {
      for (const method of ['POST', 'GET', 'DELETE'] as const) {
        const res = await send(
          port,
          method,
          null,
          method === 'POST' ? TOOLS_LIST : undefined
        );
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: Missing session ID' },
          id: null,
        });
      }
    });
  });

  it('answers 404 once a session is terminated, and a fresh initialize recovers', async () => {
    await withApp(async (port, { transports }) => {
      const init = await send(port, 'POST', null, INITIALIZE);
      expect(init.status).toBe(200);
      const sessionId = init.headers.get('mcp-session-id') as string;
      await init.text();
      expect(Object.keys(transports)).toContain(sessionId);

      expect((await send(port, 'DELETE', sessionId)).status).toBe(200);
      expect(Object.keys(transports)).not.toContain(sessionId);

      // Same as after a restart: the ID is gone, so the answer is 404 ...
      const stale = await send(port, 'POST', sessionId, TOOLS_LIST);
      expect(stale.status).toBe(404);
      expect(await stale.json()).toEqual(SESSION_NOT_FOUND);

      // ... and the client's next step, a new initialize, gets a new session.
      const again = await send(port, 'POST', null, INITIALIZE);
      expect(again.status).toBe(200);
      const next = again.headers.get('mcp-session-id');
      await again.text();
      expect(next).toBeTruthy();
      expect(next).not.toBe(sessionId);
    });
  });
});

describe('HTTP session capacity across views', () => {
  it('rejects excess initializes and reclaims a DELETEd session across views', async () => {
    const config = loadConfig();
    const previousLimit = config.env.MCP_HTTP_MAX_SESSIONS;
    config.env.MCP_HTTP_MAX_SESSIONS = 1;
    const { app, transportsByFacet } = createApp();
    config.env.MCP_HTTP_MAX_SESSIONS = previousLimit;
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const initialize = (path: string) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'capacity-test', version: '1' },
          },
        }),
      });
    try {
      const first = await initialize('/mcp');
      await first.text();
      const sid = first.headers.get('mcp-session-id')!;
      const blocked = await initialize('/mcp/readonly');
      expect(blocked.status).toBe(503);
      expect(blocked.headers.get('retry-after')).toBe('60');
      await blocked.text();
      expect(Object.keys(transportsByFacet[READONLY_VIEW])).toHaveLength(0);
      const deleted = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'DELETE',
        headers: { ...headers, 'mcp-session-id': sid },
      });
      await deleted.text();
      expect(deleted.status).toBe(200);
      const replacement = await initialize('/mcp/readonly');
      await replacement.text();
      expect(replacement.status).toBe(200);
      expect(Object.keys(transportsByFacet[READONLY_VIEW])).toHaveLength(1);
    } finally {
      for (const transports of Object.values(transportsByFacet)) {
        for (const transport of Object.values(transports))
          await transport.close();
      }
      server.close();
    }
  });
});

describe('HTTP abandoned session expiry', () => {
  it('closes the real transport, returns 404, and accepts a fresh session', async () => {
    const { app, transports } = createApp({
      maxSessions: 1,
      idleTimeoutMs: 100,
    });
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    const initialize = () =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'idle-test', version: '1' },
          },
        }),
      });
    try {
      const first = await initialize();
      await first.text();
      const sid = first.headers.get('mcp-session-id')!;
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(Object.keys(transports)).toHaveLength(0);
      const stale = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': sid },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      });
      expect(stale.status).toBe(404);
      await stale.text();
      const replacement = await initialize();
      await replacement.text();
      expect(replacement.status).toBe(200);
    } finally {
      for (const transport of Object.values(transports))
        await transport.close();
      server.close();
    }
  });
});
