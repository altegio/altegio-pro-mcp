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

  it('uses X-Altegio-User-Token inside a real SDK tool handler', async () => {
    let upstreamAuthorization: string | null = null;
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://api.alteg.io/api/v1/companies')) {
        upstreamAuthorization = new Headers(init?.headers).get('authorization');
        return new Response(JSON.stringify({ success: true, data: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return nativeFetch(input, init);
    });

    const { app } = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/mcp`;
      const baseHeaders = {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'x-altegio-user-token': 'direct-user-token',
      };
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
            name: 'list_locations',
            arguments: { my: 1, count: 1 },
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
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
