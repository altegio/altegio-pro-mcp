/**
 * Sessionless POSTs over the real SDK transport: a host that calls tools from
 * a cached list without `initialize` (one session per call, or none). The
 * request runs on a server built for it alone, with the caller's own context,
 * and a destructive call takes the confirmation-token path because no client
 * capabilities were ever declared.
 */
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

const LOCATION = 4564;
const MEMBER = 123;

describe('sessionless tool calls, end to end', () => {
  const nativeFetch = global.fetch;
  let credentialsDir: string;

  beforeAll(() => {
    credentialsDir = mkdtempSync(join(tmpdir(), 'altegio-stateless-'));
    process.env.CREDENTIALS_DIR = credentialsDir;
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => {
    rmSync(credentialsDir, { recursive: true, force: true });
    delete process.env.CREDENTIALS_DIR;
  });

  const rpcResult = async (res: Response) => {
    const text = await res.text();
    const data = text
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length);
    return JSON.parse(data ?? text).result as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
  };

  it('confirms a destructive call by token, across two separate requests', async () => {
    const deletes: string[] = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api.alteg.io/')) {
        return nativeFetch(input, init);
      }
      if (init?.method === 'DELETE') {
        deletes.push(url);
        return Response.json({ success: true, data: null });
      }
      if (url.includes(`/locations/${LOCATION}/team_members`)) {
        return Response.json({
          success: true,
          data: [{ id: MEMBER, name: 'Ivan Petrov' }],
        });
      }
      return Response.json(
        { success: false, meta: { message: 'Not found' } },
        { status: 404 }
      );
    });
    const toolLog = jest.spyOn(createLogger('tool-calls'), 'info');

    const { app, transportsByFacet } = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const call = (args: Record<string, unknown>, id: number) =>
        nativeFetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'user-agent': 'openai-mcp/1.0.0 (test)',
            'x-altegio-user-token': 'direct-user-token',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'team_members_delete', arguments: args },
          }),
        });
      const args = { location_id: LOCATION, team_member_id: MEMBER };

      const first = await rpcResult(await call(args, 1));
      // Wherever the gate puts it (text or structured), the token is quoted.
      const token = /confirmation_token\\?"?[=:]\s*\\?"([^"\\]+)/.exec(
        JSON.stringify(first)
      )?.[1];
      expect(token).toBeTruthy();
      expect(deletes).toHaveLength(0);

      const second = await rpcResult(
        await call({ ...args, confirmation_token: token }, 2)
      );
      expect(second.isError).toBeFalsy();
      expect(deletes).toEqual([
        `https://api.alteg.io/api/v1/locations/${LOCATION}/team_members/${MEMBER}`,
      ]);

      const logged = toolLog.mock.calls.map(
        ([fields]) => fields as unknown as Record<string, unknown>
      );
      expect(logged[0]).toMatchObject({
        tool: 'team_members_delete',
        outcome: 'confirmation_required',
        error_class: 'confirmation_required',
        transport: 'stateless',
        client_name: 'openai-mcp',
        client_version: '1.0.0',
      });
      expect(logged[0]).not.toHaveProperty('session');
      expect(logged[1]).toMatchObject({
        tool: 'team_members_delete',
        outcome: 'success',
        transport: 'stateless',
      });
      expect(typeof logged[1]!.response_bytes).toBe('number');
      for (const transports of Object.values(transportsByFacet)) {
        expect(Object.keys(transports)).toHaveLength(0);
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });

  it('logs the class and upstream status of a failed call, never its arguments', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api.alteg.io/')) {
        return nativeFetch(input, init);
      }
      return Response.json(
        { success: false, meta: { message: 'Upstream exploded' } },
        { status: 502 }
      );
    });
    const toolLog = jest.spyOn(createLogger('tool-calls'), 'info');
    const { app } = createApp();
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const result = await rpcResult(
        await nativeFetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'x-altegio-user-token': 'direct-user-token',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'list_locations',
              arguments: { page_size: 1 },
            },
          }),
        })
      );
      expect(result.isError).toBe(true);
      const [fields] = toolLog.mock.calls.at(-1)!;
      expect(fields).toMatchObject({
        tool: 'locations_list',
        alias: 'list_locations',
        outcome: 'error',
        error_class: 'upstream_5xx',
        upstream_status: 502,
      });
      expect(JSON.stringify(fields)).not.toContain('page_size');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
});
