import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp } from '../http-server.js';
import { ConfigLoader } from '../config/schema.js';

describe('HTTP credential and browser boundary', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
    ConfigLoader.getInstance().reset();
    jest.restoreAllMocks();
  });
  async function probe(
    body: object,
    headers: Record<string, string> = {},
    path = '/mcp'
  ) {
    ConfigLoader.getInstance().reset();
    const dir = mkdtempSync(join(tmpdir(), 'altegio-policy-'));
    process.env.CREDENTIALS_DIR = dir;
    process.env.ALTEGIO_USER_TOKEN = 'synthetic-server-user';
    const runtime = createApp();
    const server = runtime.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      return await new Promise<{ status: number; text: string }>(
        (resolve, reject) => {
          const req = request(
            {
              hostname: '127.0.0.1',
              port: (server.address() as AddressInfo).port,
              path,
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                ...headers,
              },
            },
            (res) => {
              let text = '';
              res.setEncoding('utf8');
              res.on('data', (chunk) => {
                text += chunk;
              });
              res.on('end', () => resolve({ status: res.statusCode!, text }));
            }
          );
          req.on('error', reject);
          req.end(JSON.stringify(body));
        }
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await runtime.closeTransports();
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'probe', version: '1' },
      capabilities: {},
    },
  };
  const call = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'locations_list', arguments: {} },
  };
  it.each([initialize, call])(
    'rejects hostile Host and Origin before dispatch ($method)',
    async (body) => {
      expect((await probe(body, { host: 'hostile.test' })).status).toBe(403);
      expect(
        (await probe(body, { origin: 'https://hostile.test' })).status
      ).toBe(403);
    }
  );
  it('never borrows a synthetic server credential for anonymous local HTTP', async () => {
    const upstream = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"success":true,"data":[]}'));
    const result = await probe(call);
    expect(result.text).toMatch(/auth|sign|identity/i);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('rejects anonymous hosted requests before initialization', async () => {
    process.env.MCP_HTTP_MODE = 'hosted';
    expect((await probe(initialize)).status).toBe(401);
  });
  it('does not expose case-insensitive route aliases outside the policy guards', async () => {
    process.env.MCP_HTTP_MODE = 'hosted';
    expect(
      (
        await probe(
          initialize,
          { host: 'hostile.test', origin: 'https://hostile.test' },
          '/MCP'
        )
      ).status
    ).toBe(404);
  });
  it('accepts explicitly listed backend Hosts and client Origins with a direct token', async () => {
    process.env.MCP_HTTP_MODE = 'hosted';
    process.env.MCP_HTTP_ALLOWED_HOSTS = 'backend.internal';
    process.env.MCP_HTTP_ALLOWED_ORIGINS = 'https://client.example';
    expect(
      (
        await probe(initialize, {
          host: 'backend.internal:3000',
          origin: 'https://client.example',
          'x-altegio-user-token': 'synthetic-direct',
        })
      ).status
    ).toBe(200);
  });
  it('rejects an opaque Origin even in the configured allowlist', () => {
    process.env.MCP_HTTP_ALLOWED_ORIGINS = 'null';
    ConfigLoader.getInstance().reset();
    expect(() => createApp()).toThrow(/exact HTTP\(S\) origins/);
  });
  it('requires a deliberate opt-in before sharing the configured local credential', async () => {
    process.env.MCP_HTTP_ALLOW_SHARED_CREDENTIALS = 'true';
    const upstream = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"success":true,"data":[]}'));
    await probe(call);
    expect(upstream).toHaveBeenCalledTimes(1);
    const init = upstream.mock.calls[0]![1];
    expect(new Headers(init?.headers).get('authorization')).toContain(
      'User synthetic-server-user'
    );
  });
  it('never applies the local shared-credential opt-in to a hosted proxy request', async () => {
    process.env.MCP_HTTP_MODE = 'hosted';
    process.env.MCP_HTTP_ALLOW_SHARED_CREDENTIALS = 'true';
    const key = 'synthetic-proxy-signing-key-at-least-32-chars';
    process.env.MCP_PROXY_BACKEND_KEY = key;
    const seconds = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', key)
      .update(['mcp-proxy-auth/v1', seconds, 'POST', '/mcp'].join('\n'))
      .digest('hex');
    const upstream = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('{"success":true,"data":[]}'));
    const result = await probe(call, {
      'x-mcp-proxy-auth': `v1:${seconds}:${signature}`,
    });
    expect(result.text).toMatch(/auth|sign|identity/i);
    expect(upstream).not.toHaveBeenCalled();
  });
  it('rejects new work and reports unhealthy after draining starts', async () => {
    ConfigLoader.getInstance().reset();
    const runtime = createApp();
    const server = runtime.app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      runtime.beginDrain();
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect((await fetch(`${base}/health`)).status).toBe(503);
      expect(
        (
          await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(initialize),
          })
        ).status
      ).toBe(503);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
