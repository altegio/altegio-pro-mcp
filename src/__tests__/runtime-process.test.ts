import { afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { request as rawRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const rpc = (method: string, id?: number, params?: object) => ({
  jsonrpc: '2.0',
  ...(id === undefined ? {} : { id }),
  method,
  ...(params ? { params } : {}),
});
const headers = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'x-altegio-user-token': 'synthetic-direct-user',
};

describe('compiled runtime lifecycle and cancellation', () => {
  const children: ChildProcess[] = [];
  const servers: Server[] = [];
  const dirs: string[] = [];
  beforeAll(() => {
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc'], {
      timeout: 60000,
      stdio: 'pipe',
    });
  }, 65000);
  afterEach(async () => {
    for (const child of children.splice(0))
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  async function launch(upstream: Server, grace = 1000) {
    servers.push(upstream);
    await new Promise<void>((resolve) =>
      upstream.listen(0, '127.0.0.1', resolve)
    );
    const dir = mkdtempSync(join(tmpdir(), 'altegio-process-'));
    dirs.push(dir);
    const script = `import { startHTTPServer } from './dist/http-server.js'; const r = await startHTTPServer({port:0,handleSignals:true}); console.log('READY:'+JSON.stringify(r.listener.address()));`;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CREDENTIALS_DIR: dir,
          ALTEGIO_API_TOKEN: 'synthetic-partner',
          ALTEGIO_API_BASE: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/api/v1`,
          MCP_SHUTDOWN_TIMEOUT_MS: String(grace),
          ALTEGIO_REQUEST_TIMEOUT_MS: '3000',
          LOG_LEVEL: 'error',
          MCP_HTTP_MODE: 'local',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    children.push(child);
    let stderr = '';
    child.stderr!.on('data', (data) => {
      stderr += String(data).slice(0, 2000);
    });
    const exit = new Promise<number | null>((resolve) =>
      child.once('exit', resolve)
    );
    const ready = await new Promise<AddressInfo>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(
        () => reject(new Error(`Runtime did not become ready: ${stderr}`)),
        8000
      );
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Runtime exited ${code}: ${stderr}`));
      });
      child.stdout!.on('data', (data) => {
        output += String(data);
        const match = /READY:(.+)\n/.exec(output);
        if (match) {
          clearTimeout(timer);
          resolve(JSON.parse(match[1]!) as AddressInfo);
        }
      });
    });
    const url = `http://127.0.0.1:${ready.port}/mcp`;
    return {
      child,
      exit,
      ready,
      post: (body: object, extra: Record<string, string> = {}) =>
        fetch(url, {
          method: 'POST',
          headers: { ...headers, ...extra },
          body: JSON.stringify(body),
        }),
    };
  }

  it('imports both public entry modules without starting or installing signal handlers', () => {
    const script = `const before=['SIGINT','SIGTERM'].map(s=>process.listenerCount(s)); await import('./dist/index.js'); await import('./dist/http-server.js'); if (before.some((n,i)=>n!==process.listenerCount(['SIGINT','SIGTERM'][i]))) throw Error('signal side effect'); console.log('imported');`;
    expect(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, ALTEGIO_API_TOKEN: '', PORT: '0' },
        timeout: 5000,
        encoding: 'utf8',
      }).trim()
    ).toBe('imported');
  });

  it('binds local HTTP to loopback and drains a pending read on SIGTERM', async () => {
    let release!: () => void;
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const runtime = await launch(
      createServer((_req, res) => {
        release = () => res.end('{"success":true,"data":[]}');
        arrived();
      })
    );
    expect(runtime.ready.address).toBe('127.0.0.1');
    const response = runtime
      .post(rpc('tools/call', 1, { name: 'locations_list', arguments: {} }))
      .then((res) => res.text());
    await arrival;
    runtime.child.kill('SIGTERM');
    await pause(80);
    expect(runtime.child.exitCode).toBeNull();
    release();
    expect(await response).toMatch(/data:/);
    expect(await runtime.exit).toBe(0);
  });

  it('bounds shutdown when an upstream never sends headers', async () => {
    let arrived!: () => void;
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const runtime = await launch(
      createServer(() => arrived()),
      120
    );
    const response = runtime
      .post(rpc('tools/call', 1, { name: 'locations_list', arguments: {} }))
      .then((res) => res.text())
      .catch(() => 'closed');
    await arrival;
    const started = performance.now();
    runtime.child.kill('SIGTERM');
    expect(await runtime.exit).toBe(0);
    expect(performance.now() - started).toBeLessThan(1200);
    await response;
  });

  it('does not treat a disconnected HTTP caller as explicit cancellation', async () => {
    let arrived!: () => void;
    let release!: () => void;
    let upstreamClosed = false;
    let requests = 0;
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const runtime = await launch(
      createServer((_req, res) => {
        requests++;
        arrived();
        res.once('close', () => {
          upstreamClosed = true;
        });
        release = () => res.end('{"success":true,"data":[]}');
      })
    );
    const req = rawRequest(
      {
        hostname: '127.0.0.1',
        port: runtime.ready.port,
        path: '/mcp',
        method: 'POST',
        headers,
      },
      (res) => res.resume()
    );
    req.on('error', () => undefined);
    req.end(
      JSON.stringify(
        rpc('tools/call', 1, { name: 'locations_list', arguments: {} })
      )
    );
    await arrival;
    req.destroy();
    await pause(80);
    expect(upstreamClosed).toBe(false);
    release();
    runtime.child.kill('SIGTERM');
    expect(await runtime.exit).toBe(0);
    expect(requests).toBe(1);
  });

  it('propagates explicit MCP cancellation to the upstream without retrying', async () => {
    let arrived!: () => void;
    let closed!: () => void;
    let requests = 0;
    const arrival = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const closure = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const runtime = await launch(
      createServer((_req, res) => {
        requests++;
        arrived();
        res.once('close', closed);
      })
    );
    const init = await runtime.post(
      rpc('initialize', 1, {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'cancel-test', version: '1' },
      })
    );
    const session = { 'mcp-session-id': init.headers.get('mcp-session-id')! };
    await init.text();
    await (
      await runtime.post(rpc('notifications/initialized'), session)
    ).text();
    const response = runtime
      .post(
        rpc('tools/call', 2, { name: 'locations_list', arguments: {} }),
        session
      )
      .then((res) => res.text())
      .catch(() => 'closed');
    await arrival;
    expect(
      (
        await runtime.post(
          rpc('notifications/cancelled', undefined, {
            requestId: 2,
            reason: 'user cancelled',
          }),
          session
        )
      ).status
    ).toBe(202);
    await Promise.race([
      closure,
      pause(1200).then(() => {
        throw new Error('Upstream did not observe explicit cancellation');
      }),
    ]);
    expect(requests).toBe(1);
    runtime.child.kill('SIGTERM');
    await runtime.exit;
    await response;
  });
});
