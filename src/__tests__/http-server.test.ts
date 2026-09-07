import { describe, it, expect } from '@jest/globals';
import type { AddressInfo } from 'net';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createApp, FACET_ROUTES } from '../http-server.js';
import { DEFAULT_FACET, FACET_NAMES } from '../tools/facets.js';
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

  it('returns 400 for an unknown session without touching identity', async () => {
    const { app } = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const res = await post(port, 'missing', {
        'x-mcp-auth-kind': 'user',
        'x-mcp-auth-email': 'a@example.com',
      });
      expect(res.status).toBe(400);
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

  it('serves a route for the default view and for every facet', () => {
    expect(FACET_ROUTES.map((route) => route.path)).toEqual([
      '/mcp',
      ...FACET_NAMES.map((facet) => `/mcp/${facet}`),
    ]);
    const { transportsByFacet } = createApp();
    expect(Object.keys(transportsByFacet).sort()).toEqual(
      [DEFAULT_FACET, ...FACET_NAMES].sort()
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
      expect((await postTo(port, '/mcp/catalog', 'sess-ops')).status).toBe(400);
      expect((await postTo(port, '/mcp', 'sess-ops')).status).toBe(400);
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
      expect(body.error.message).toContain('ops');
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
