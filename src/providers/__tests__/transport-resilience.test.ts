import { afterEach, describe, expect, it } from '@jest/globals';
import { createServer, type Server, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AltegioClient } from '../altegio-client.js';
import { httpFromClient } from '../../api/altegio-http.js';

describe('bounded upstream transport', () => {
  const servers: Server[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });
  const clientFor = async (handler: RequestListener) => {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const dir = mkdtempSync(join(tmpdir(), 'altegio-deadline-'));
    dirs.push(dir);
    return new AltegioClient(
      {
        partnerToken: 'synthetic-partner',
        userToken: 'synthetic-user',
        apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        timeout: 500,
        retryConfig: { maxAttempts: 0 },
      },
      dir
    );
  };

  it.each(['headers', 'body'])(
    'bounds delayed %s and never replays a write',
    async (delay) => {
      let writes = 0;
      const client = await clientFor((_req, res) => {
        writes++;
        if (delay === 'body') {
          res.writeHead(200);
          res.write('{');
        }
        // Deliberately never finish. The client must end its own budget.
      });
      const started = performance.now();
      await expect(
        (async () => {
          const response = await httpFromClient(client).request('/auth', {
            method: 'POST',
          });
          await response.text();
        })()
      ).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(performance.now() - started).toBeLessThan(2000);
      expect(writes).toBe(1);
    }
  );

  it('honors cancellation even before admission and does not retry it', async () => {
    let requests = 0;
    const client = await clientFor((_req, res) => {
      requests++;
      res.end('{}');
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      httpFromClient(client).request('/locations', {
        signal: controller.signal,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toBe(0);
  });

  it('enforces configured upstream admission for writes too', async () => {
    await clientFor((_req, res) => res.end('{}'));
    // A separate client sets the deliberately tiny window and count.
    const limited = new AltegioClient(
      {
        partnerToken: 'p',
        userToken: 'u',
        apiBase: `http://127.0.0.1:${(servers[0]!.address() as AddressInfo).port}`,
        timeout: 1000,
        rateLimit: { requests: 1, windowMs: 140 },
      },
      dirs[0]
    );
    const http = httpFromClient(limited);
    await (await http.request('/auth', { method: 'POST' })).text();
    const started = performance.now();
    await (await http.request('/auth', { method: 'POST' })).text();
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
  });
});
