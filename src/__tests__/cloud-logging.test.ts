import { CloudLoggingDestination } from '../utils/cloud-logging.js';

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
    expect(fallback.mock.calls).toEqual([[line], [line]]);
    expect(
      fetcher.mock.calls.filter(([url]) =>
        String(url).includes('entries:write')
      )
    ).toHaveLength(1);
  });

  it('bounds queued entries and batches at twenty', async () => {
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
    const calls = fetcher.mock.calls as unknown as [string, RequestInit][];
    expect(
      calls
        .filter(([url]) => url.includes('entries:write'))
        .map(([, init]) => JSON.parse(String(init.body)).entries.length)
    ).toEqual([20, 1]);
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
