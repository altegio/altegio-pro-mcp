import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { Client as OldClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as OldTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, startHTTPServer } from '../http-server.js';
import { ConfigLoader } from '../config/schema.js';

const key = 'synthetic-sdk-v2-backend-key-at-least-32-characters';
const savedEnv = { ...process.env };
let dir: string;
let runtime: ReturnType<typeof createApp>;
let listener: Server;
let upstream: Server;
let base: string;
let mutations: string[];
let upstreamStarted: number;
let upstreamCancelled: number;
let upstreamRequests: number;

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  expect(predicate()).toBe(true);
}

function signedFetch(
  token = 'synthetic-a',
  company = 101,
  scope = 'mcp:pro:write'
): typeof fetch {
  return async (input, init) => {
    const req = new Request(input, init);
    const headers: Record<string, string> = {
      'x-mcp-auth-kind': 'user',
      'x-mcp-auth-sub': token,
      'x-mcp-auth-scope': scope,
      'x-altegio-user-token': token,
      'x-altegio-company-id': String(company),
    };
    for (const [name, value] of Object.entries(headers))
      req.headers.set(name, value);
    const url = new URL(req.url);
    const ts = Math.floor(Date.now() / 1000);
    const identity = Object.entries(headers)
      .filter(([name]) => name.startsWith('x-mcp-auth-'))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([name, value]) => `${name}:${value}`);
    const mac = createHmac('sha256', key)
      .update(
        [
          'mcp-proxy-auth/v1',
          ts,
          req.method,
          url.pathname + url.search,
          ...identity,
        ].join('\n')
      )
      .digest('hex');
    req.headers.set('x-mcp-proxy-auth', `v1:${ts}:${mac}`);
    return fetch(req);
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'altegio-sdk-v2-'));
  mutations = [];
  upstreamStarted = 0;
  upstreamCancelled = 0;
  upstreamRequests = 0;
  upstream = httpServer((req, res) => {
    upstreamRequests++;
    const id = Number(
      req.url?.match(/\/(?:locations|staff)\/(\d+)/)?.[1] ?? 101
    );
    if (req.method === 'DELETE') mutations.push(req.url!);
    const data = req.url?.includes('/staff/')
      ? [{ id: 7, name: 'Synthetic member' }]
      : { id, title: req.headers.authorization ?? 'unknown' };
    const respond = () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data }));
    };
    if (id === 303 || id === 404) {
      upstreamStarted++;
      const timer = setTimeout(respond, id === 303 ? 2000 : 150);
      res.once('close', () => {
        clearTimeout(timer);
        if (!res.writableFinished) upstreamCancelled++;
      });
    } else respond();
  });
  const port = await listen(upstream);
  Object.assign(process.env, {
    CREDENTIALS_DIR: dir,
    MCP_PROTOCOL_MODE: 'dual',
    MCP_HTTP_MODE: 'hosted',
    MCP_PROXY_BACKEND_KEY: key,
    MCP_HTTP_ALLOWED_HOSTS: '127.0.0.1',
    MCP_HTTP_ALLOWED_ORIGINS: 'https://mcp.altegio.dev',
    MCP_HTTP_MAX_SESSIONS: '2',
    ALTEGIO_API_BASE: `http://127.0.0.1:${port}/api/v1`,
  });
  ConfigLoader.getInstance().reset();
  runtime = createApp();
  listener = httpServer(runtime.app);
  base = `http://127.0.0.1:${await listen(listener)}`;
});

afterEach(async () => {
  await runtime.closeTransports();
  for (const server of [listener, upstream]) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...savedEnv };
  ConfigLoader.getInstance().reset();
});

it.each(['old', 'legacy', 'auto', 'modern'] as const)(
  'serves %s clients without HTTP session state',
  async (mode) => {
    const client =
      mode === 'old'
        ? new OldClient({ name: 'old-host', version: '1' })
        : new Client(
            { name: 'new-host', version: '1' },
            {
              versionNegotiation: {
                mode: mode === 'modern' ? { pin: '2026-07-28' } : mode,
              },
            }
          );
    const Transport =
      mode === 'old' ? OldTransport : StreamableHTTPClientTransport;
    const transport = new Transport(new URL(`${base}/mcp`), {
      fetch: signedFetch(),
    });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(37);
      expect(
        tools.tools.every((tool) => tool.inputSchema.type === 'object')
      ).toBe(true);
      expect((await client.listResources()).resources.length).toBeGreaterThan(
        0
      );
      expect((await client.listResourceTemplates()).resourceTemplates).toEqual(
        []
      );
      expect(
        (await client.listPrompts()).prompts.some(
          ({ name }) => name === 'onboarding_walkthrough'
        )
      ).toBe(true);
      expect(
        (await client.readResource({ uri: 'altegio://docs/product-logic' }))
          .contents[0]
      ).toHaveProperty('text');
      expect(
        (await client.getPrompt({ name: 'onboarding_walkthrough' })).messages
          .length
      ).toBeGreaterThan(0);
      expect(transport.sessionId).toBeUndefined();
      expect(
        Object.values(runtime.transportsByFacet).every(
          (sessions) => Object.keys(sessions).length === 0
        )
      ).toBe(true);
      if (mode !== 'old')
        expect((client as Client).getProtocolEra()).toBe(
          mode === 'legacy' ? 'legacy' : 'modern'
        );
    } finally {
      await client.close();
    }
  }
);

it('binds interleaved modern callers to their own token and company', async () => {
  const clients = [
    new Client(
      { name: 'a', version: '1' },
      { versionNegotiation: { mode: 'auto' } }
    ),
    new Client(
      { name: 'b', version: '1' },
      { versionNegotiation: { mode: 'auto' } }
    ),
  ];
  try {
    await Promise.all(
      clients.map((client, i) =>
        client.connect(
          new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
            fetch: signedFetch(
              i ? 'synthetic-b' : 'synthetic-a',
              i ? 202 : 101
            ),
          })
        )
      )
    );
    const results = await Promise.all(
      clients.map((client) =>
        client.callTool({ name: 'locations_list', arguments: {} })
      )
    );
    expect(JSON.stringify(results[0])).toContain('synthetic-a');
    expect(JSON.stringify(results[0])).not.toContain('synthetic-b');
    expect(JSON.stringify(results[1])).toContain('synthetic-b');
    expect(JSON.stringify(results[1])).not.toContain('synthetic-a');
  } finally {
    await Promise.all(clients.map((client) => client.close()));
  }
});

it('keeps scope refusal before confirmation and enforces the readonly view', async () => {
  for (const path of ['/mcp', '/mcp/readonly']) {
    const client = new Client(
      { name: 'readonly', version: '1' },
      { versionNegotiation: { mode: 'auto' } }
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(base + path), {
          fetch: signedFetch('synthetic-a', 101, 'mcp:pro:read'),
        })
      );
      const result = client.callTool({
        name: 'team_members_delete',
        arguments: { location_id: 101, team_member_id: 7 },
      });
      if (path.endsWith('readonly'))
        await expect(result).rejects.toThrow(/read operations only/i);
      else {
        const denial = await result;
        expect(denial.isError).toBe(true);
        expect(JSON.stringify(denial)).not.toContain('confirmation_token');
      }
      expect(mutations).toEqual([]);
    } finally {
      await client.close();
    }
  }
});

it('uses confirmation tokens across independent modern requests', async () => {
  const client = new Client(
    { name: 'confirmation-host', version: '1' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: 'auto' },
    }
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        fetch: signedFetch(),
      })
    );
    const args = { location_id: 101, team_member_id: 7 };
    const gate = await client.callTool({
      name: 'team_members_delete',
      arguments: args,
    });
    const content = gate.structuredContent as Record<string, unknown>;
    expect(content.status).toBe('confirmation_required');
    expect(mutations).toEqual([]);
    const confirmed = await client.callTool({
      name: 'team_members_delete',
      arguments: { ...args, confirmation_token: content.confirmation_token },
    });
    expect(confirmed.isError).not.toBe(true);
    expect(mutations).toHaveLength(1);
  } finally {
    await client.close();
  }
});

it('cancels modern upstream work and reclaims request admission', async () => {
  const client = new Client(
    { name: 'cancel-host', version: '1' },
    { versionNegotiation: { mode: 'auto' } }
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        fetch: signedFetch('synthetic-a', 303),
      })
    );
    const controller = new AbortController();
    const pending = client.callTool(
      { name: 'locations_list', arguments: {} },
      { signal: controller.signal }
    );
    const rejected = expect(pending).rejects.toThrow();
    await until(() => upstreamStarted === 1);
    controller.abort();
    await rejected;
    await until(() => upstreamCancelled === 1);
    expect(await runtime.activity.drain(1000)).toBe(true);
  } finally {
    await client.close();
  }
});

it('bounds concurrent dual requests and drains accepted calls', async () => {
  const client = new Client(
    { name: 'capacity-host', version: '1' },
    { versionNegotiation: { mode: 'auto' } }
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        fetch: signedFetch('synthetic-a', 404),
      })
    );
    const calls = [0, 1].map(() =>
      client.callTool({ name: 'locations_list', arguments: {} })
    );
    await until(() => upstreamStarted === 2);
    await expect(client.listTools()).rejects.toThrow(/503|capacity/i);
    runtime.beginDrain();
    await expect(client.listTools()).rejects.toThrow(/503|draining/i);
    expect((await Promise.all(calls)).every((result) => !result.isError)).toBe(
      true
    );
    expect(await runtime.activity.drain(1000)).toBe(true);
    expect(upstreamCancelled).toBe(0);
  } finally {
    await client.close();
  }
});

it('runtime shutdown finishes an accepted modern request before closing the SDK', async () => {
  const running = await startHTTPServer({ port: 0, host: '127.0.0.1' });
  const client = new Client(
    { name: 'shutdown-host', version: '1' },
    { versionNegotiation: { mode: 'auto' } }
  );
  try {
    const port = (running.listener.address() as AddressInfo).port;
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        { fetch: signedFetch('synthetic-a', 404) }
      )
    );
    const pending = client.callTool({ name: 'locations_list', arguments: {} });
    await until(() => upstreamStarted === 1);
    const closing = running.shutdown();
    expect((await pending).isError).not.toBe(true);
    await closing;
    expect(upstreamCancelled).toBe(0);
  } finally {
    await client.close();
    await running.shutdown();
  }
});

it('preserves each caller rate window across fresh SDK request instances', async () => {
  Object.assign(process.env, {
    RATE_LIMIT_REQUESTS: '1',
    RATE_LIMIT_WINDOW_MS: '2000',
    ALTEGIO_REQUEST_TIMEOUT_MS: '500',
  });
  ConfigLoader.getInstance().reset();
  const running = await startHTTPServer({ port: 0, host: '127.0.0.1' });
  const clients = [101, 202].map(
    () =>
      new Client(
        { name: 'rate-host', version: '1' },
        { versionNegotiation: { mode: 'auto' } }
      )
  );
  try {
    const port = (running.listener.address() as AddressInfo).port;
    await Promise.all(
      clients.map((client, i) =>
        client.connect(
          new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${port}/mcp`),
            {
              fetch: signedFetch(
                i ? 'synthetic-b' : 'synthetic-a',
                i ? 202 : 101
              ),
            }
          )
        )
      )
    );
    expect(
      (await clients[0]!.callTool({ name: 'locations_list', arguments: {} }))
        .isError
    ).not.toBe(true);
    const limited = await clients[0]!.callTool({
      name: 'locations_list',
      arguments: {},
    });
    expect(limited.isError).toBe(true);
    expect(
      (await clients[1]!.callTool({ name: 'locations_list', arguments: {} }))
        .isError
    ).not.toBe(true);
    expect(upstreamRequests).toBe(2);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await running.shutdown();
  }
});
