import { describe, it, expect } from '@jest/globals';
import type { AddressInfo } from 'net';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createApp } from '../http-server.js';
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

  const fakeTransport = (sink: (id: Captured) => void): StreamableHTTPServerTransport =>
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
  const post = (port: number, sessionId: string, headers: Record<string, string>) =>
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
      expect(captured[0]).toMatchObject({ kind: 'user', email: 'a@example.com' });
      expect(captured[1]).toMatchObject({ kind: 'user', email: 'b@example.com' });

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
