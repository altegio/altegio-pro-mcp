import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as OldClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as OldTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const key = 'synthetic-compiled-sdk-v2-key-at-least-32-characters';
const signed =
  (company = 101) =>
  async (input, init) => {
    const req = new Request(input, init);
    const token = company === 101 ? 'synthetic-a' : 'synthetic-b';
    const claims = {
      'x-mcp-auth-kind': 'user',
      'x-mcp-auth-sub': token,
      'x-mcp-auth-scope': 'mcp:pro:write',
    };
    for (const [name, value] of Object.entries(claims))
      req.headers.set(name, value);
    req.headers.set('x-altegio-user-token', token);
    req.headers.set('x-altegio-company-id', String(company));
    const url = new URL(req.url);
    const ts = Math.floor(Date.now() / 1000);
    const canonical = [
      'mcp-proxy-auth/v1',
      ts,
      req.method,
      url.pathname + url.search,
      ...Object.entries(claims)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}:${v}`),
    ].join('\n');
    req.headers.set(
      'x-mcp-proxy-auth',
      `v1:${ts}:${createHmac('sha256', key).update(canonical).digest('hex')}`
    );
    return fetch(req);
  };

async function inspect(client) {
  const tools = await client.listTools();
  assert.ok(tools.tools.some(({ name }) => name === 'locations_list'));
  assert.ok(
    tools.tools.every(({ inputSchema }) => inputSchema.type === 'object')
  );
  assert.ok((await client.listResources()).resources.length);
  assert.ok(
    (await client.listPrompts()).prompts.some(
      ({ name }) => name === 'onboarding_walkthrough'
    )
  );
  assert.match(
    (await client.readResource({ uri: 'altegio://docs/product-logic' }))
      .contents[0].text,
    /^# /
  );
  return tools.tools.length;
}

export async function smokeHttpV2(
  base,
  { protocolMode = 'dual', identity = false } = {}
) {
  const results = [];
  for (const mode of [
    'old',
    'legacy',
    'auto',
    ...(protocolMode === 'dual' ? ['modern'] : []),
  ]) {
    const client =
      mode === 'old'
        ? new OldClient({ name: 'compiled-v1-host', version: '1' })
        : new Client(
            { name: 'compiled-v2-host', version: '1' },
            {
              versionNegotiation: {
                mode: mode === 'modern' ? { pin: '2026-07-28' } : mode,
              },
            }
          );
    const Transport =
      mode === 'old' ? OldTransport : StreamableHTTPClientTransport;
    const transport = new Transport(new URL('/mcp', base), { fetch: signed() });
    try {
      await client.connect(transport);
      const tools = await inspect(client);
      const era = mode === 'old' ? 'legacy' : client.getProtocolEra();
      assert.equal(
        era,
        protocolMode === 'dual' && ['auto', 'modern'].includes(mode)
          ? 'modern'
          : 'legacy'
      );
      if (protocolMode === 'dual') assert.equal(transport.sessionId, undefined);
      results.push({ mode, era, tools });
    } finally {
      await client.close();
    }
  }
  if (identity) {
    const clients = [101, 202].map(
      () =>
        new Client(
          { name: 'compiled-identity-host', version: '1' },
          { versionNegotiation: { mode: 'auto' } }
        )
    );
    try {
      await Promise.all(
        clients.map((client, i) =>
          client.connect(
            new StreamableHTTPClientTransport(new URL('/mcp', base), {
              fetch: signed(i ? 202 : 101),
            })
          )
        )
      );
      const replies = await Promise.all(
        clients.map((client) =>
          client.callTool({ name: 'locations_list', arguments: {} })
        )
      );
      assert.match(JSON.stringify(replies[0]), /synthetic-a/);
      assert.doesNotMatch(JSON.stringify(replies[0]), /synthetic-b/);
      assert.match(JSON.stringify(replies[1]), /synthetic-b/);
      assert.doesNotMatch(JSON.stringify(replies[1]), /synthetic-a/);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
    }
  }
  return results;
}

export async function smokeStdioV2(parameters, protocolMode = 'dual') {
  const matrix = [];
  for (const mode of [
    'legacy',
    'auto',
    ...(protocolMode === 'dual' ? ['modern'] : []),
  ]) {
    const client = new Client(
      { name: 'compiled-v2-stdio', version: '1' },
      {
        versionNegotiation: {
          mode: mode === 'modern' ? { pin: '2026-07-28' } : mode,
        },
      }
    );
    try {
      await client.connect(
        new StdioClientTransport({ ...parameters, stderr: 'pipe' })
      );
      const tools = await inspect(client);
      const era = client.getProtocolEra();
      assert.equal(
        era,
        protocolMode === 'dual' && mode !== 'legacy' ? 'modern' : 'legacy'
      );
      matrix.push({ mode, era, tools });
    } finally {
      await client.close();
    }
  }
  return matrix;
}

/** Exercise native compiled ESM, including an installed production-only tarball. */
export async function smokeSdkV2(packageRoot) {
  const temp = await mkdtemp(path.join(tmpdir(), 'altegio-compiled-v2-'));
  const upstream = createServer((req, res) => {
    const company = Number(req.url.match(/\/locations\/(\d+)/)?.[1] ?? 101);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        data: { id: company, title: req.headers.authorization },
      })
    );
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  try {
    const matrix = [];
    for (const protocolMode of ['legacy', 'dual']) {
      const env = {
        PATH: process.env.PATH,
        HOME: temp,
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        ALTEGIO_API_TOKEN: 'synthetic-partner',
        ALTEGIO_API_BASE: `http://127.0.0.1:${upstream.address().port}/api/v1`,
        CREDENTIALS_DIR: path.join(temp, 'credentials'),
        MCP_PROTOCOL_MODE: protocolMode,
        MCP_HTTP_MODE: 'hosted',
        MCP_HTTP_ALLOWED_HOSTS: '127.0.0.1',
        MCP_PROXY_BACKEND_KEY: key,
      };
      const entry = pathToFileURL(
        path.join(packageRoot, 'dist/http-server.js')
      ).href;
      const program = `const {startHTTPServer}=await import(${JSON.stringify(entry)}); const r=await startHTTPServer({port:0,host:'127.0.0.1',handleSignals:true}); process.send({port:r.listener.address().port});`;
      const child = spawn(
        process.execPath,
        ['--input-type=module', '-e', program],
        { cwd: temp, env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }
      );
      let stderr = '';
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-2000);
      });
      try {
        const port = await new Promise((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error('Compiled server readiness timeout')),
            15_000
          );
          child.once('message', ({ port }) => {
            clearTimeout(timer);
            resolve(port);
          });
          child.once('error', (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Compiled server exit ${code}: ${stderr}`));
          });
        });
        const http = await smokeHttpV2(`http://127.0.0.1:${port}`, {
          protocolMode,
          identity: true,
        });
        const stdio = await smokeStdioV2(
          {
            command: process.execPath,
            args: [path.join(packageRoot, 'dist/index.js')],
            cwd: temp,
            env,
          },
          protocolMode
        );
        matrix.push({ protocolMode, http, stdio });
      } finally {
        const exited = new Promise((resolve) => child.once('exit', resolve));
        if (child.exitCode === null && child.signalCode === null) {
          const force = setTimeout(() => child.kill('SIGKILL'), 5000);
          child.kill('SIGTERM');
          await exited;
          clearTimeout(force);
        }
      }
    }
    return matrix;
  } finally {
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  console.log(
    JSON.stringify({
      sdkV2: await smokeSdkV2(path.resolve(process.argv[2] ?? '.')),
    })
  );
