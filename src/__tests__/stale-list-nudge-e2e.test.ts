/**
 * The stale-list nudge over the real SDK transport. A ChatGPT or Codex app
 * keeps the `tools/list` it fetched, so it calls tools by names this address
 * no longer lists and never sees `tools_search` (2026-11-03: 25 users on
 * `/pro`). Such a call runs, and ends with one note asking for a refresh — at
 * most twice per signed-in user, across stateless requests.
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
import { createApp } from '../http-server.js';
import { createLogger } from '../utils/logger.js';
import { staleListNudge } from '../tools/dispatch.js';
import {
  clearStaleListNudges,
  STALE_LIST_NUDGE_LIMIT,
} from '../tools/registry.js';

const STALE = 'older release of this server';

describe('stale-list nudge, end to end', () => {
  const nativeFetch = global.fetch;
  let credentialsDir: string;

  beforeAll(() => {
    credentialsDir = mkdtempSync(join(tmpdir(), 'altegio-stale-list-'));
    process.env.CREDENTIALS_DIR = credentialsDir;
  });
  beforeEach(() => {
    clearStaleListNudges();
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      if (!String(input).startsWith('https://api.alteg.io/')) {
        return nativeFetch(input, init);
      }
      return Response.json({ success: true, data: [] });
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => {
    rmSync(credentialsDir, { recursive: true, force: true });
    delete process.env.CREDENTIALS_DIR;
  });

  /** Run `fn` with a function that POSTs one stateless `tools/call`. */
  async function withServer(
    fn: (
      call: (
        name: string,
        args: Record<string, unknown>,
        options?: { token?: string; path?: string }
      ) => Promise<{ isError?: boolean; text: string }>
    ) => Promise<void>
  ): Promise<void> {
    const { app } = createApp();
    const server = app.listen(0);
    let id = 0;
    try {
      const { port } = server.address() as AddressInfo;
      await fn(async (name, args, options = {}) => {
        id += 1;
        const { token = 'user-token-a', path = '/mcp' } = options;
        const res = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'x-altegio-user-token': token,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        });
        const body = await res.text();
        const data = body
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice('data: '.length);
        const result = JSON.parse(data ?? body).result as {
          isError?: boolean;
          content: Array<{ type: string; text?: string }>;
        };
        return {
          isError: result.isError,
          text: result.content.map((block) => block.text ?? '').join('\n'),
        };
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }

  it('ends a direct call of a tool the compact listing does not list, twice per user', async () => {
    const toolLog = jest.spyOn(createLogger('tool-calls'), 'info');
    const args = { location_id: 4564 };
    await withServer(async (call) => {
      for (let i = 0; i < STALE_LIST_NUDGE_LIMIT.nudges; i += 1) {
        const nudged = await call('positions_list', args);
        expect(nudged.isError).toBeFalsy();
        expect(nudged.text.endsWith(staleListNudge('positions_list'))).toBe(
          true
        );
      }
      const quiet = await call('positions_list', args);
      expect(quiet.isError).toBeFalsy();
      expect(quiet.text).not.toContain(STALE);
      const other = await call('positions_list', args, {
        token: 'user-token-b',
      });
      expect(other.text).toContain(staleListNudge('positions_list'));
    });
    const flags = toolLog.mock.calls.map(
      ([fields]) =>
        (fields as unknown as Record<string, unknown>).stale_list_nudge
    );
    expect(flags).toEqual([true, true, undefined, true]);
  });

  it('adds nothing to a listed tool or to a call through the dispatcher', async () => {
    const toolLog = jest.spyOn(createLogger('tool-calls'), 'info');
    await withServer(async (call) => {
      const listed = await call('locations_list', {});
      expect(listed.text).not.toContain(STALE);
      const dispatched = await call('tools_call_read', {
        tool: 'positions_list',
        arguments: { location_id: 4564 },
      });
      expect(dispatched.isError).toBeFalsy();
      expect(dispatched.text).not.toContain(STALE);
    });
    for (const [fields] of toolLog.mock.calls) {
      expect(fields).not.toHaveProperty('stale_list_nudge');
    }
  });

  it('ends a call by a former name with it on the full list too', async () => {
    await withServer(async (call) => {
      const renamed = await call(
        'suppliers_list',
        { location_id: 4564 },
        { path: '/mcp/full' }
      );
      expect(renamed.text).toContain(staleListNudge('suppliers_list'));
      const current = await call(
        'positions_list',
        { location_id: 4564 },
        { path: '/mcp/full' }
      );
      expect(current.text).not.toContain(STALE);
    });
  });
});
