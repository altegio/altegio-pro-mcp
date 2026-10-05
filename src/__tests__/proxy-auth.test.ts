import { describe, expect, it } from '@jest/globals';
import { createHmac } from 'node:crypto';
import { parseProxyKeys, verifyProxyRequest } from '../utils/proxy-auth.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createApp } from '../http-server.js';
import type { AddressInfo } from 'node:net';
const key = '0123456789abcdef0123456789abcdef';
function signature(
  headers: Record<string, string>,
  path = '/mcp?x=1',
  now = 1700000000000
) {
  const ts = Math.floor(now / 1000);
  const text = [
    'mcp-proxy-auth/v1',
    String(ts),
    'POST',
    path,
    ...Object.keys(headers)
      .filter((k) => k.startsWith('x-mcp-auth-'))
      .sort()
      .map((k) => `${k}:${headers[k]}`),
  ].join('\n');
  return `v1:${ts}:${createHmac('sha256', key).update(text).digest('hex')}`;
}
describe('platform signature compatibility', () => {
  it('checks all identity fields, path/query, skew and key rotation', () => {
    const headers = {
      'x-mcp-auth-kind': 'user',
      'x-mcp-auth-kind-extra': 'sorted-after-kind',
      'x-mcp-auth-sub': 'opaque',
      'x-mcp-auth-scope': 'mcp:pro:read',
      'x-mcp-auth-request-id': 'req-1',
    };
    const signed = { ...headers, 'x-mcp-proxy-auth': signature(headers) };
    const options = {
      keys: ['another-key-0123456789abcdef0123456789', key],
      method: 'post',
      path: '/mcp?x=1',
      headers: signed,
      nowMs: 1700000000000,
    };
    expect(verifyProxyRequest(options)).toEqual({ ok: true });
    expect(verifyProxyRequest({ ...options, path: '/mcp' }).ok).toBe(false);
    expect(verifyProxyRequest({ ...options, nowMs: 1700000400000 })).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(
      verifyProxyRequest({
        ...options,
        headers: { ...signed, 'x-mcp-auth-sub': 'forged' },
      }).ok
    ).toBe(false);
    expect(parseProxyKeys('short,' + key)).toEqual([key]);
  });
  it('rejects forged delegation before the body parser while preserving direct-token HTTP', async () => {
    const previous = process.env.MCP_PROXY_BACKEND_KEY;
    process.env.MCP_PROXY_BACKEND_KEY = key;
    const { app, transports } = createApp();
    transports['direct-session'] = {
      handleRequest: async (
        _req: unknown,
        res: { status: (status: number) => { json: (body: unknown) => void } }
      ) => {
        res.status(202).json({ ok: true });
      },
    } as unknown as StreamableHTTPServerTransport;
    const server = app.listen(0);
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
      const forged = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mcp-auth-sub': 'forged',
        },
        body: 'invalid json',
      });
      expect(forged.status).toBe(401);
      const direct = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-altegio-user-token': 'direct-token',
          'mcp-session-id': 'direct-session',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        }),
      });
      expect(direct.status).toBe(202);
      await direct.text();
    } finally {
      server.close();
      if (previous === undefined) delete process.env.MCP_PROXY_BACKEND_KEY;
      else process.env.MCP_PROXY_BACKEND_KEY = previous;
    }
  });
});
