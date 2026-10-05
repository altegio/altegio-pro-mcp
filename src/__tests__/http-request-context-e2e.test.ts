import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../http-server.js';
import { createLogger } from '../utils/logger.js';
import { createHmac } from 'node:crypto';

describe('HTTP direct-token propagation, end to end', () => {
  const nativeFetch = global.fetch;
  let credentialsDir: string;

  beforeAll(() => {
    credentialsDir = mkdtempSync(join(tmpdir(), 'altegio-http-context-'));
    process.env.CREDENTIALS_DIR = credentialsDir;
    process.env.REQUIRE_DELEGATED_IDENTITY = 'true';
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    rmSync(credentialsDir, { recursive: true, force: true });
    delete process.env.CREDENTIALS_DIR;
    delete process.env.REQUIRE_DELEGATED_IDENTITY;
  });

  const parseSse = async <T>(res: Response): Promise<T> => {
    const body = await res.text();
    const line = body
      .split('\n')
      .find((candidate) => candidate.startsWith('data:'));
    return JSON.parse((line ?? '').slice('data:'.length).trim()) as T;
  };

  it.each([false, true])(
    'preserves token and trusted correlation through the real SDK (signed=%s)',
    async (signed) => {
      let upstreamAuthorization: string | null = null;
      jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith('https://api.alteg.io/api/v1/locations')) {
          upstreamAuthorization = new Headers(init?.headers).get(
            'authorization'
          );
          return new Response(JSON.stringify({ success: true, data: [] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return nativeFetch(input, init);
      });

      const key = '0123456789abcdef0123456789abcdef';
      const previousKey = process.env.MCP_PROXY_BACKEND_KEY;
      process.env.MCP_PROXY_BACKEND_KEY = key;
      const toolLog = jest.spyOn(createLogger('tool-calls'), 'info');
      const { app } = createApp();
      const server = app.listen(0);
      try {
        const { port } = server.address() as AddressInfo;
        const url = `http://127.0.0.1:${port}/mcp`;
        const baseHeaders: Record<string, string> = {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'x-altegio-user-token': 'direct-user-token',
          'x-request-id': 'caller-controlled-id',
        };
        if (signed) {
          const seconds = Math.floor(Date.now() / 1000);
          baseHeaders['x-mcp-auth-request-id'] = 'trusted-proxy-id';
          const canonical = [
            'mcp-proxy-auth/v1',
            String(seconds),
            'POST',
            '/mcp',
            'x-mcp-auth-request-id:trusted-proxy-id',
          ].join('\n');
          baseHeaders['x-mcp-proxy-auth'] =
            `v1:${seconds}:${createHmac('sha256', key).update(canonical).digest('hex')}`;
        }
        const post = (body: unknown, sessionId?: string) =>
          nativeFetch(url, {
            method: 'POST',
            headers: {
              ...baseHeaders,
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
            clientInfo: { name: 'token-context-test', version: '1.0.0' },
          },
        });
        expect(init.status).toBe(200);
        const sessionId = init.headers.get('mcp-session-id');
        expect(sessionId).toBeTruthy();
        await parseSse(init);

        await post(
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          sessionId as string
        );
        const call = await post(
          {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'locations_list',
              arguments: { managed_only: true, page_size: 1 },
            },
          },
          sessionId as string
        );
        const payload = await parseSse<{
          result: { isError?: boolean; content: Array<{ text: string }> };
        }>(call);

        expect(payload.result.isError).not.toBe(true);
        expect(upstreamAuthorization).toBe(
          'Bearer test-partner-token, User direct-user-token'
        );
        const correlation = call.headers.get('x-request-id');
        expect(correlation).toBeTruthy();
        expect(correlation).not.toBe('caller-controlled-id');
        if (signed) expect(correlation).toBe('trusted-proxy-id');
        expect(toolLog).toHaveBeenCalledWith(
          expect.objectContaining({
            tool: 'locations_list',
            outcome: 'success',
            request_id: correlation,
          }),
          'Tool completed'
        );
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
        if (previousKey === undefined) delete process.env.MCP_PROXY_BACKEND_KEY;
        else process.env.MCP_PROXY_BACKEND_KEY = previousKey;
      }
    }
  );
});
