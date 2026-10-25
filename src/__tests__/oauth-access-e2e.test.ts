/**
 * The Altegio OAuth lane end to end over the real HTTP surface: a host that
 * connected through Altegio's authorization server sends one `ag_at_` token
 * per request; the proxy passes it through as `x-altegio-user-token` and
 * nothing else about the caller. Everything below goes through `createApp()`
 * and a real MCP session.
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
import { oauthGrantsCache } from '../auth/oauth-access.js';

interface JsonRpcToolResult {
  result: { isError?: boolean; content: Array<{ text: string }> };
}

const TOKEN_A = 'ag_at_e2e_token_a';
const TOKEN_B = 'ag_at_e2e_token_b';

/** What Altegio says about each token: the same person, two tokens. */
const RESOURCES: Record<string, unknown[]> = {
  [TOKEN_A]: [
    {
      type: 'location',
      id: 4564,
      main_chain_id: 100,
      scopes: ['locations:read', 'locations:write', 'clients:read'],
    },
    {
      type: 'location',
      id: 720441,
      main_chain_id: null,
      scopes: ['locations:read'],
    },
    {
      type: 'chain',
      id: 100,
      main_chain_id: null,
      scopes: ['chain_loyalty:read'],
    },
  ],
  [TOKEN_B]: [
    {
      type: 'location',
      id: 4564,
      main_chain_id: 100,
      scopes: ['locations:read'],
    },
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('Altegio OAuth lane, end to end', () => {
  const nativeFetch = global.fetch;
  let credentialsDir: string;
  let httpServer: HttpServer;
  let url: string;
  let upstream: Array<{ url: string; authorization: string | null }>;
  let refused: Set<string>;
  let openSessions: string[];

  beforeAll(async () => {
    credentialsDir = mkdtempSync(join(tmpdir(), 'altegio-oauth-e2e-'));
    process.env.CREDENTIALS_DIR = credentialsDir;
    const { app } = createApp();
    httpServer = app.listen(0);
    await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    const { port } = httpServer.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/mcp`;
  });

  beforeEach(() => {
    upstream = [];
    refused = new Set();
    openSessions = [];
    oauthGrantsCache.clear();
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const target = String(input);
      if (!target.startsWith('https://api.alteg.io/')) {
        return nativeFetch(input, init);
      }
      const authorization = new Headers(init?.headers).get('authorization');
      const token = Object.keys(RESOURCES).find((t) =>
        authorization?.includes(t)
      );
      upstream.push({ url: target, authorization });
      if (!token || refused.has(token)) {
        return json(
          { success: false, meta: { message: 'Authorization required' } },
          401
        );
      }
      if (target.includes('/oauth/accessible-resources')) {
        return json({ object: 'list', data: RESOURCES[token] });
      }
      if (target.endsWith('/user/data')) {
        return json({ success: true, data: { id: 42, name: 'Owner' } });
      }
      if (target.includes('/locations?')) {
        return json({
          success: true,
          data: [
            { id: 4564, title: 'A' },
            { id: 720441, title: 'B' },
            { id: 999, title: 'Not granted' },
          ],
        });
      }
      if (target.includes('/chains')) {
        return json({ success: true, data: [] });
      }
      return json({ success: true, data: { id: 4564, title: 'A' } });
    });
  });

  afterEach(async () => {
    await Promise.all(
      openSessions.map((sessionId) =>
        nativeFetch(url, {
          method: 'DELETE',
          headers: { 'mcp-session-id': sessionId },
        }).catch(() => undefined)
      )
    );
    jest.restoreAllMocks();
    oauthGrantsCache.clear();
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

  const openSession = async (
    token: string,
    extra: Record<string, string> = {}
  ) => {
    const headers: Record<string, string> = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-altegio-user-token': token,
      ...extra,
    };
    const post = (
      body: unknown,
      sessionId?: string,
      override?: Record<string, string>
    ) =>
      nativeFetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          ...override,
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
        clientInfo: { name: 'oauth-e2e', version: '1.0.0' },
      },
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id') as string;
    openSessions.push(sessionId);
    await parseSse(init);
    await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId
    );
    let nextId = 2;
    return {
      sessionId,
      call: (
        name: string,
        args: Record<string, unknown> = {},
        override?: Record<string, string>
      ) =>
        post(
          {
            jsonrpc: '2.0',
            id: nextId++,
            method: 'tools/call',
            params: { name, arguments: args },
          },
          sessionId,
          override
        ),
    };
  };

  it('signs every API call with the partner token and the access token', async () => {
    const session = await openSession(TOKEN_A);
    const payload = await parseSse<JsonRpcToolResult>(
      await session.call('locations_list', {
        managed_only: true,
        page_size: 10,
      })
    );
    expect(payload.result.isError).not.toBe(true);
    const listing = upstream.find((u) => u.url.includes('/locations?'));
    expect(listing?.authorization).toBe(
      `Bearer test-partner-token, User ${TOKEN_A}`
    );
    expect(listing?.url).toContain(
      'https://api.alteg.io/api/v1/locations?my=1'
    );
    expect(payload.result.content[0]!.text).toContain('4564');
    expect(payload.result.content[0]!.text).not.toContain('999');
  });

  it('ignores the proxy scope header and refuses a write the grant lacks', async () => {
    const session = await openSession(TOKEN_A, {
      'x-mcp-auth-scope': 'mcp:pro:read mcp:pro:write',
    });
    const allowed = await parseSse<JsonRpcToolResult>(
      await session.call('locations_update', {
        location_id: 4564,
        title: 'Renamed',
      })
    );
    expect(allowed.result.isError).not.toBe(true);

    const before = upstream.length;
    const denied = await parseSse<JsonRpcToolResult>(
      await session.call('locations_update', {
        location_id: 720441,
        title: 'Renamed',
      })
    );
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0]!.text).toMatch(
      /location 720441.*locations:write/
    );
    expect(upstream).toHaveLength(before);
  });

  it('refuses a chain outside the consent before any request', async () => {
    const session = await openSession(TOKEN_A);
    const before = upstream.length;
    const denied = await parseSse<JsonRpcToolResult>(
      await session.call('memberships_list_types', {
        chain_id: 200,
        page: 1,
        page_size: 10,
      })
    );
    expect(denied.result.isError).toBe(true);
    expect(denied.result.content[0]!.text).toContain('chain 200');
    expect(upstream).toHaveLength(before);
  });

  it('resolves a rotated token again and keeps the same person', async () => {
    const session = await openSession(TOKEN_A);
    await parseSse(
      await session.call('locations_list', { managed_only: true, page_size: 1 })
    );
    const rotated = await parseSse<JsonRpcToolResult>(
      await session.call(
        'locations_list',
        { managed_only: true, page_size: 1 },
        {
          'x-altegio-user-token': TOKEN_B,
        }
      )
    );
    expect(rotated.result.isError).not.toBe(true);
    const resolutions = upstream.filter((u) =>
      u.url.includes('/oauth/accessible-resources')
    );
    expect(resolutions.map((u) => u.authorization)).toEqual([
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_B}`,
    ]);
    expect(oauthGrantsCache.get(TOKEN_A)?.userId).toBe(42);
    expect(oauthGrantsCache.get(TOKEN_B)?.userId).toBe(42);
  });

  it('challenges the next request at the door once Altegio refuses the token', async () => {
    const session = await openSession(TOKEN_A);
    refused.add(TOKEN_A);
    const failed = await parseSse<JsonRpcToolResult>(
      await session.call('locations_list', { managed_only: true, page_size: 1 })
    );
    expect(failed.result.isError).toBe(true);
    expect(failed.result.content[0]!.text).toMatch(/reconnect Altegio/);
    expect(oauthGrantsCache.get(TOKEN_A)).toBeUndefined();

    const challenged = await session.call('locations_list', {
      managed_only: true,
      page_size: 1,
    });
    expect(challenged.status).toBe(401);
    expect(challenged.headers.get('www-authenticate')).toContain(
      'resource_metadata='
    );
  });
});
