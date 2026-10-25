/**
 * The HTTP door for Altegio OAuth access tokens: a token Altegio refuses is
 * answered with 401 and the protected-resource metadata, an Altegio outage
 * with 503, and a good token is admitted once per token. Local state that
 * never touches Altegio (stored reports, onboarding checkpoints) asks for a
 * fresh verdict before it is served.
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
import {
  assertOauthTokenLive,
  protectedResourceMetadataUrl,
} from '../auth/oauth-door.js';
import { oauthGrantsCache } from '../auth/oauth-access.js';
import {
  requestContextFromHeaders,
  runWithContext,
} from '../request-context.js';
import { DEFAULT_FACET, READONLY_VIEW } from '../tools/facets.js';
import { AuthenticationError } from '../utils/errors.js';

const GOOD = 'ag_at_door_good_token';
const BAD = 'ag_at_door_bad_token';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const listing = {
  object: 'list',
  data: [
    {
      type: 'location',
      id: 4564,
      main_chain_id: null,
      scopes: ['locations:read'],
    },
  ],
};

describe('protectedResourceMetadataUrl', () => {
  it('names the proxy document of the address the view is served on', () => {
    expect(
      protectedResourceMetadataUrl('https://mcp.alteg.io/pro', DEFAULT_FACET)
    ).toBe('https://mcp.alteg.io/.well-known/oauth-protected-resource/pro');
    expect(
      protectedResourceMetadataUrl('https://mcp.alteg.io/pro', READONLY_VIEW)
    ).toBe(
      'https://mcp.alteg.io/.well-known/oauth-protected-resource/pro/readonly'
    );
  });
});

describe('the OAuth door on the HTTP surface', () => {
  const nativeFetch = global.fetch;
  let credentialsDir: string;
  let httpServer: HttpServer;
  let base: string;
  let altegio: jest.Mock<(url: string) => Response | Error>;

  beforeAll(async () => {
    credentialsDir = mkdtempSync(join(tmpdir(), 'altegio-oauth-door-'));
    process.env.CREDENTIALS_DIR = credentialsDir;
    const { app } = createApp();
    httpServer = app.listen(0);
    await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    const { port } = httpServer.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => {
    oauthGrantsCache.clear();
    altegio = jest.fn<(url: string) => Response | Error>((url) => {
      if (url.includes('/oauth/accessible-resources')) {
        return url.includes('bad') ? json({}, 401) : json(listing);
      }
      if (url.endsWith('/user/data')) {
        return json({ success: true, data: { id: 42 } });
      }
      return json({ success: true, data: [] });
    });
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api.alteg.io/'))
        return nativeFetch(input, init);
      const token = new Headers(init?.headers).get('authorization') ?? '';
      const answer = altegio(token.includes(BAD) ? `${url}#bad` : url);
      if (answer instanceof Error) throw answer;
      return answer;
    });
  });

  afterEach(() => {
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

  const initialize = (path: string, token: string) =>
    nativeFetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'x-altegio-user-token': token,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'door-test', version: '1.0.0' },
        },
      }),
    });

  it('challenges a refused token with 401 and the protected-resource metadata', async () => {
    const res = await initialize('/mcp', BAD);

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      'error="invalid_token"'
    );
    expect(res.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://mcp.alteg.io/.well-known/oauth-protected-resource/pro"'
    );
    expect(await res.json()).toMatchObject({ error: 'invalid_token' });
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('points the read-only view at its own metadata document', async () => {
    const res = await initialize('/mcp/readonly', BAD);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://mcp.alteg.io/.well-known/oauth-protected-resource/pro/readonly"'
    );
  });

  it('answers 503 when Altegio cannot be asked', async () => {
    altegio.mockImplementation(() => new TypeError('fetch failed'));
    const res = await initialize('/mcp', GOOD);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
  });

  it('admits a good token once and remembers it for the next request', async () => {
    const first = await initialize('/mcp', GOOD);
    expect(first.status).toBe(200);
    const sessionId = first.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    expect(oauthGrantsCache.get(GOOD)?.userId).toBe(42);
    const asked = altegio.mock.calls.filter(([url]) =>
      url.includes('/oauth/accessible-resources')
    ).length;
    expect(asked).toBe(1);

    const second = await initialize('/mcp', GOOD);
    expect(second.status).toBe(200);
    expect(
      altegio.mock.calls.filter(([url]) =>
        url.includes('/oauth/accessible-resources')
      )
    ).toHaveLength(asked);
    await nativeFetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': sessionId! },
    });
    await nativeFetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': second.headers.get('mcp-session-id')! },
    });
  });

  it('leaves a legacy token to the existing lanes', async () => {
    const res = await initialize('/mcp', 'legacy-users-hash');
    expect(res.status).toBe(200);
    expect(
      altegio.mock.calls.filter(([url]) =>
        url.includes('/oauth/accessible-resources')
      )
    ).toHaveLength(0);
    await nativeFetch(`${base}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': res.headers.get('mcp-session-id')! },
    });
  });

  describe('assertOauthTokenLive', () => {
    it('does nothing without an OAuth token', async () => {
      await runWithContext(
        requestContextFromHeaders({ 'x-altegio-user-token': 'legacy' }),
        () => assertOauthTokenLive()
      );
      expect(altegio).not.toHaveBeenCalled();
    });

    it('asks Altegio again and refreshes the grants', async () => {
      oauthGrantsCache.set(GOOD, {
        userId: 1,
        resources: [],
        locationIds: new Set(),
        chainIds: new Set(),
        scopes: new Set(),
        fetchedAt: 0,
      });
      await runWithContext(
        requestContextFromHeaders({ 'x-altegio-user-token': GOOD }),
        () => assertOauthTokenLive()
      );
      expect(oauthGrantsCache.get(GOOD)?.locationIds.has(4564)).toBe(true);
    });

    it('turns a refusal into an authentication error and forgets the token', async () => {
      oauthGrantsCache.set(BAD, {
        userId: 1,
        resources: [],
        locationIds: new Set(),
        chainIds: new Set(),
        scopes: new Set(),
        fetchedAt: 0,
      });
      await expect(
        runWithContext(
          requestContextFromHeaders({ 'x-altegio-user-token': BAD }),
          () => assertOauthTokenLive()
        )
      ).rejects.toBeInstanceOf(AuthenticationError);
      expect(oauthGrantsCache.get(BAD)).toBeUndefined();
    });
  });
});
