import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CloudLoggingDestination,
  keepAliveFetch,
  writeTimeoutMs,
} from '../utils/cloud-logging.js';

const line = `${JSON.stringify({
  severity: 'WARNING',
  time: 1720000000000,
  service: 'altegio-pro-mcp',
  commit: 'test-commit',
  request_id: 'request-1',
  outcome: 'error',
})}\n`;

function mockFetch(writeStatus = 200, expiresIn = 3600) {
  return jest.fn(async (url: string | URL | Request) => {
    const path = String(url);
    if (path.endsWith('/token')) {
      return Response.json({
        access_token: 'test-token',
        expires_in: expiresIn,
      });
    }
    if (path.endsWith('project/project-id'))
      return new Response('test-project');
    if (path.endsWith('instance/id')) return new Response('123');
    if (path.endsWith('instance/zone'))
      return new Response('projects/1/zones/test-zone');
    return new Response('{}', { status: writeStatus });
  });
}

/** The `entries:write` requests a mock fetch received. */
function writes(fetcher: jest.Mock) {
  return (fetcher.mock.calls as unknown as [string, RequestInit][]).filter(
    ([url]) => String(url).includes('entries:write')
  );
}

describe('Cloud Logging destination', () => {
  it('promotes severity and resource and caches native metadata credentials', async () => {
    const fetcher = mockFetch();
    const fallback = jest.fn();
    const destination = new CloudLoggingDestination(
      fetcher as typeof fetch,
      fallback
    );
    destination.write(line);
    await destination.flush();
    destination.write(line);
    await destination.flush();
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    const writes = calls.filter(([url]) => url.includes('entries:write'));
    expect(writes).toHaveLength(2);
    expect(calls.filter(([url]) => url.endsWith('/token'))).toHaveLength(1);
    const body = JSON.parse(String(writes[0]![1].body));
    expect(body.logName).toBe('projects/test-project/logs/altegio-pro-mcp');
    expect(body.resource).toEqual({
      type: 'gce_instance',
      labels: {
        project_id: 'test-project',
        instance_id: '123',
        zone: 'test-zone',
      },
    });
    expect(body.entries[0]).toMatchObject({
      severity: 'WARNING',
      jsonPayload: {
        service: 'altegio-pro-mcp',
        request_id: 'request-1',
        outcome: 'error',
      },
    });
    expect(fallback).not.toHaveBeenCalled();
  });

  it('falls back on a failed write and suppresses retries during cooldown', async () => {
    const fetcher = mockFetch(403);
    const fallback = jest.fn();
    const destination = new CloudLoggingDestination(
      fetcher as typeof fetch,
      fallback
    );
    destination.write(line);
    await destination.flush();
    destination.write(line);
    await destination.flush();
    const lines = fallback.mock.calls.map(([written]) => written);
    expect(lines.filter((written) => written === line)).toHaveLength(2);
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).includes('entries:write')
      )
    ).toHaveLength(1);
  });

  it('says once a minute why writes fail, with status and API reason only', async () => {
    let clock = 1_000_000;
    const fetcher = jest.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes('entries:write')) {
        return Response.json(
          {
            error: {
              status: 'PERMISSION_DENIED',
              message: 'free text that must not be echoed',
            },
          },
          { status: 403 }
        );
      }
      return mockFetch()(url);
    });
    const fallback = jest.fn();
    const destination = new CloudLoggingDestination(
      fetcher as typeof fetch,
      fallback,
      256,
      () => clock
    );
    const diagnostics = () =>
      fallback.mock.calls
        .map(([written]) => String(written))
        .filter((written) => written.includes('cloud_logging_write_failed'))
        .map((written) => JSON.parse(written));

    destination.write(line);
    await destination.flush();
    expect(diagnostics()).toEqual([
      expect.objectContaining({
        severity: 'WARNING',
        stage: 'write',
        http_status: 403,
        reason: 'PERMISSION_DENIED',
        failures: 1,
        entries_to_fallback: 1,
      }),
    ]);
    expect(JSON.stringify(diagnostics())).not.toContain('free text');

    clock += 31_000; // past the cooldown, inside the diagnostic interval
    destination.write(line);
    await destination.flush();
    expect(diagnostics()).toHaveLength(1);

    clock += 31_000; // past both
    destination.write(line);
    await destination.flush();
    expect(diagnostics()).toHaveLength(2);
    expect(diagnostics()[1]).toMatchObject({ failures: 2 });
  });

  it('recovers from a write that never settles instead of stalling for good', async () => {
    jest.useFakeTimers();
    try {
      let hang = true;
      const fetcher = jest.fn(async (url: string | URL | Request) => {
        if (String(url).includes('entries:write') && hang) {
          return new Promise<Response>(() => undefined);
        }
        return mockFetch()(url);
      });
      const fallback = jest.fn();
      const destination = new CloudLoggingDestination(
        fetcher as typeof fetch,
        fallback,
        256,
        Date.now,
        { retryDelayMs: () => 100 }
      );
      destination.write(line);
      // Two attempts, each under its deadline, with the retry delay between.
      await jest.advanceTimersByTimeAsync(200 + writeTimeoutMs(1000) * 2 + 100);
      // The stuck batch went to the fallback; the destination says why.
      expect(fallback).toHaveBeenCalledWith(line);
      expect(
        fallback.mock.calls.some(([written]) =>
          String(written).includes('"reason":"TimeoutError"')
        )
      ).toBe(true);
      expect(writes(fetcher)).toHaveLength(2);

      hang = false;
      fallback.mockClear();
      await jest.advanceTimersByTimeAsync(5_000);
      destination.write(line);
      await jest.advanceTimersByTimeAsync(200);
      expect(fallback).not.toHaveBeenCalled();
      expect(writes(fetcher)).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a timed-out write once and keeps the entries on the direct log', async () => {
    jest.useFakeTimers();
    try {
      let calls = 0;
      const fetcher = jest.fn(async (url: string | URL | Request) => {
        if (String(url).includes('entries:write') && calls++ === 0) {
          return new Promise<Response>(() => undefined);
        }
        return mockFetch()(url);
      });
      const fallback = jest.fn();
      const destination = new CloudLoggingDestination(
        fetcher as typeof fetch,
        fallback,
        256,
        Date.now,
        { retryDelayMs: () => 100 }
      );
      destination.write(line);
      await jest.advanceTimersByTimeAsync(200 + writeTimeoutMs(1000) + 100);
      const retried = writes(fetcher);
      expect(retried).toHaveLength(2);
      // The same entry, under the same insertId, so the API deduplicates it.
      expect(JSON.parse(String(retried[1]![1].body)).entries).toEqual(
        JSON.parse(String(retried[0]![1].body)).entries
      );
      const lines = fallback.mock.calls.map(([written]) => String(written));
      expect(lines).not.toContain(line);
      expect(lines.map((written) => JSON.parse(written))).toEqual([
        expect.objectContaining({
          event: 'cloud_logging_write_recovered',
          recovered: 1,
        }),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a transient status once, and a refusal not at all', async () => {
    let status = 503;
    const fetcher = jest.fn(async (url: string | URL | Request) => {
      if (String(url).includes('entries:write')) {
        const answer = new Response('{}', { status });
        status = 200;
        return answer;
      }
      return mockFetch()(url);
    });
    const fallback = jest.fn();
    const destination = new CloudLoggingDestination(
      fetcher as typeof fetch,
      fallback,
      256,
      Date.now,
      { retryDelayMs: () => 0 }
    );
    destination.write(line);
    await destination.flush();
    expect(writes(fetcher)).toHaveLength(2);
    expect(fallback.mock.calls.map(([written]) => written)).not.toContain(line);
  });

  it('names the step that failed and lengthens the cooldown while failures repeat', async () => {
    let clock = 1_000_000;
    const fetcher = jest.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/token')) {
        const error = new Error('stalled');
        error.name = 'TimeoutError';
        throw error;
      }
      return mockFetch()(url);
    });
    const fallback = jest.fn();
    const destination = new CloudLoggingDestination(
      fetcher as typeof fetch,
      fallback,
      256,
      () => clock,
      { retryDelayMs: () => 0 }
    );
    const diagnostics = () =>
      fallback.mock.calls
        .map(([written]) => String(written))
        .filter((written) => written.includes('cloud_logging_write_failed'))
        .map((written) => JSON.parse(written));

    destination.write(line);
    await destination.flush();
    expect(diagnostics()).toEqual([
      expect.objectContaining({
        stage: 'token',
        reason: 'TimeoutError',
        cooldown_ms: 5_000,
      }),
    ]);

    clock += 61_000;
    destination.write(line);
    await destination.flush();
    expect(diagnostics()[1]).toMatchObject({ cooldown_ms: 10_000 });
  });
  it('keeps draining after the queue overflows', async () => {
    jest.useFakeTimers();
    try {
      const fetcher = mockFetch();
      const fallback = jest.fn();
      const destination = new CloudLoggingDestination(
        fetcher as typeof fetch,
        fallback,
        2
      );
      for (let i = 0; i < 3; i++) destination.write(line);
      expect(fallback).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(200);
      destination.write(line);
      await jest.advanceTimersByTimeAsync(200);
      expect(fallback).toHaveBeenCalledTimes(1);
      const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
      expect(
        calls
          .filter(([url]) => url.includes('entries:write'))
          .reduce(
            (sum, [, init]) =>
              sum + JSON.parse(String(init.body)).entries.length,
            0
          )
      ).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds queued entries and batches at ten entries', async () => {
    const fetcher = mockFetch();
    const fallback = jest.fn();
    const destination = new CloudLoggingDestination(
      fetcher as typeof fetch,
      fallback,
      21
    );
    for (let i = 0; i < 22; i++) destination.write(line);
    expect(fallback).toHaveBeenCalledTimes(1);
    await destination.flush();
    expect(
      writes(fetcher).map(
        ([, init]) => JSON.parse(String(init.body)).entries.length
      )
    ).toEqual([10, 10, 1]);
  });

  it('bounds a batch at 64 KiB, and still sends one larger entry alone', async () => {
    const big = (size: number) =>
      `${JSON.stringify({ severity: 'INFO', time: 1, pad: 'x'.repeat(size) })}\n`;
    const fetcher = mockFetch();
    const destination = new CloudLoggingDestination(
      fetcher as typeof fetch,
      jest.fn()
    );
    for (let i = 0; i < 4; i++) destination.write(big(20_000));
    destination.write(big(60_000));
    await destination.flush();
    expect(
      writes(fetcher).map(
        ([, init]) => JSON.parse(String(init.body)).entries.length
      )
    ).toEqual([3, 1, 1]);
  });

  it('gives a larger write a longer deadline, within a cap', () => {
    expect(writeTimeoutMs(1_000)).toBe(6_000);
    expect(writeTimeoutMs(64 * 1024)).toBe(9_000);
    expect(writeTimeoutMs(10_000_000)).toBe(15_000);
  });

  it('reuses one keep-alive connection for consecutive writes', async () => {
    const ports = new Set<number>();
    const bodies: string[] = [];
    const server = createServer((request, response) => {
      ports.add(request.socket.remotePort ?? 0);
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        bodies.push(body);
        response.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address() as AddressInfo;
      for (const body of ['{"a":1}', '{"b":2}']) {
        const response = await keepAliveFetch(`http://127.0.0.1:${port}/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        expect(response.ok).toBe(true);
        expect(await response.text()).toBe('{}');
      }
      expect(bodies).toEqual(['{"a":1}', '{"b":2}']);
      expect(ports.size).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refreshes an expiring token through the native metadata endpoint', async () => {
    const fetcher = mockFetch(200, 30);
    const destination = new CloudLoggingDestination(
      fetcher as typeof fetch,
      jest.fn()
    );
    destination.write(line);
    await destination.flush();
    destination.write(line);
    await destination.flush();
    expect(
      fetcher.mock.calls.filter(([url]) => String(url).endsWith('/token'))
    ).toHaveLength(2);
  });

  it('preserves invalid input through fallback without contacting metadata', async () => {
    const fetcher = mockFetch();
    const fallback = jest.fn();
    const destination = new CloudLoggingDestination(
      fetcher as typeof fetch,
      fallback
    );
    destination.write('invalid');
    await destination.flush();
    expect(fallback).toHaveBeenCalledWith('invalid');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
