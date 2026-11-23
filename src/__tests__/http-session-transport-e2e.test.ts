/**
 * Two Streamable HTTP session defects found in production on 2026-11-23, over
 * the real app and transport with the upstream API mocked:
 *
 * 1. A confirmation prompt went to the standalone GET stream. A host that
 *    never opens one (many behind the proxy do not) got no prompt, and the
 *    write timed out. It now travels on the tool call's own response stream.
 * 2. Two concurrent POSTs reusing one JSON-RPC id on a session crossed their
 *    response streams: one got the other's result and the other stayed open
 *    until the proxy's 3600 s ceiling (Cursor sent every call with id 0). A
 *    reused id now waits for the earlier request.
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

type Message = Record<string, unknown> & {
  id?: string | number;
  method?: string;
  result?: Record<string, unknown>;
};

const nativeFetch = global.fetch;

describe('Streamable HTTP session transport, end to end', () => {
  let credentialsDir: string;
  let httpServer: HttpServer;
  let url: string;
  let upstream: string[];
  let sessions: string[];

  beforeAll(async () => {
    credentialsDir = mkdtempSync(join(tmpdir(), 'altegio-session-e2e-'));
    process.env.CREDENTIALS_DIR = credentialsDir;
    const { app } = createApp();
    httpServer = app.listen(0);
    await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
  });

  beforeEach(() => {
    upstream = [];
    sessions = [];
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const target = String(input);
      if (!target.startsWith('https://api.alteg.io/')) {
        return nativeFetch(input, init);
      }
      upstream.push(`${init?.method ?? 'GET'} ${target}`);
      const location = /\/locations\/(\d+)\/team_members/.exec(target)?.[1];
      // Slow enough for two calls to overlap.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return new Response(
        JSON.stringify({
          success: true,
          data: location
            ? [{ id: Number(location) * 10, name: `Member of ${location}` }]
            : [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
  });

  afterEach(async () => {
    await Promise.all(
      sessions.map((sessionId) =>
        nativeFetch(url, {
          method: 'DELETE',
          headers: { 'mcp-session-id': sessionId },
        }).catch(() => undefined)
      )
    );
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      httpServer.close((error) => (error ? reject(error) : resolve()))
    );
    rmSync(credentialsDir, { recursive: true, force: true });
    delete process.env.CREDENTIALS_DIR;
  });

  const post = (body: unknown, sessionId?: string) =>
    nativeFetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-11-25',
        'x-altegio-user-token': 'direct-user-token',
        'x-mcp-auth-kind': 'user',
        'x-mcp-auth-email': 'operator@example.com',
        ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      },
      body: JSON.stringify(body),
    });

  /** Every JSON-RPC message of an SSE response, in order, as they arrive. */
  async function* sseMessages(res: Response): AsyncGenerator<Message> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = event
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice('data:'.length).trim())
          .join('');
        if (data) yield JSON.parse(data) as Message;
      }
    }
  }

  /** A session that declares form elicitation and never opens a GET stream. */
  const openSession = async (): Promise<string> => {
    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: { elicitation: { form: {} } },
        clientInfo: { name: 'session-transport-e2e', version: '1.0.0' },
      },
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id')!;
    sessions.push(sessionId);
    await init.text();
    const initialized = await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId
    );
    await initialized.text();
    return sessionId;
  };

  it('sends the confirmation prompt on the tool call’s own stream', async () => {
    const sessionId = await openSession();
    const call = await post(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: {
          name: 'team_members_delete',
          arguments: { location_id: 4564, team_member_id: 123 },
        },
      },
      sessionId
    );
    expect(call.status).toBe(200);

    const seen: string[] = [];
    let result: Message | undefined;
    for await (const message of sseMessages(call)) {
      if (message.method === 'elicitation/create') {
        seen.push('prompt');
        // The person accepts, on a POST of its own.
        const answer = await post(
          { jsonrpc: '2.0', id: message.id, result: { action: 'accept' } },
          sessionId
        );
        expect(answer.status).toBe(202);
      } else if (message.id === 7) {
        result = message;
        break;
      }
    }

    expect(seen).toEqual(['prompt']);
    expect(result?.result?.isError).not.toBe(true);
    expect(JSON.stringify(result?.result)).toContain('Deleted team member');
    expect(upstream).toContainEqual(
      expect.stringMatching(/^DELETE https:\/\/api\.alteg\.io\/.*123/)
    );
  });

  it('answers concurrent calls that reuse one request id, each with its own result', async () => {
    const sessionId = await openSession();
    const call = (location: number) =>
      post(
        {
          jsonrpc: '2.0',
          id: 0,
          method: 'tools/call',
          params: {
            name: 'team_members_list',
            arguments: { location_id: location },
          },
        },
        sessionId
      );
    const resultOf = async (res: Response) => {
      for await (const message of sseMessages(res)) {
        if (message.id === 0) return JSON.stringify(message.result);
      }
      return undefined;
    };

    const [first, second] = await Promise.all([call(1), call(2)]);
    const [one, two] = await Promise.all([resultOf(first), resultOf(second)]);

    expect(one).toContain('Member of 1');
    expect(one).not.toContain('Member of 2');
    expect(two).toContain('Member of 2');
    expect(two).not.toContain('Member of 1');
  });
});
