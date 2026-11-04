import { AltegioClient, retryAfterSeconds } from '../altegio-client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AltegioConfig } from '../../types/altegio.types.js';
import { AltegioApiError } from '../../utils/errors.js';
import {
  createToolCallObservation,
  runObservingToolCall,
} from '../../utils/tool-call-observation.js';

jest.mock('node:timers/promises', () => ({
  ...jest.requireActual('node:timers/promises'),
  setTimeout: jest.requireActual('../../__tests__/helpers/promise-timers.js')
    .clockTimeout,
}));

const originalFetch = global.fetch;

const config: AltegioConfig = {
  partnerToken: 'test-token',
  userToken: 'test-user-token',
};

function rateLimited(retryAfter?: string): Response {
  return Response.json(
    { success: false, meta: { message: 'Too Many Requests' } },
    {
      status: 429,
      headers: retryAfter ? { 'Retry-After': retryAfter } : {},
    }
  );
}

const staffPage = () => Response.json({ success: true, data: [{ id: 7 }] });

const newStaff = {
  name: 'John Doe',
  specialization: 'Stylist',
  position_id: 1,
  user_email: 'john@example.com',
  user_phone: '1234567890',
  is_user_invite: false,
  is_paid_staff: true,
  has_timetable_access: false,
};

describe('AltegioClient - a read refused with HTTP 429', () => {
  let client: AltegioClient;
  let fetchMock: jest.Mock;
  let testDir: string;

  beforeEach(() => {
    jest.useFakeTimers();
    testDir = mkdtempSync(join(tmpdir(), 'altegio-rate-limit-'));
    client = new AltegioClient(config, testDir);
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    global.fetch = originalFetch;
    rmSync(testDir, { recursive: true, force: true });
  });

  it('waits a second without Retry-After, reads again and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(staffPage());
    const observation = createToolCallObservation();

    const pending = runObservingToolCall(observation, () =>
      client.getStaff(4564)
    );
    await jest.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual([{ id: 7 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(observation).toMatchObject({
      upstreamResponses: 1,
      upstreamRetries: 1,
    });
    expect(observation.upstreamErrorStatus).toBeUndefined();
  });

  it('waits as long as a short Retry-After asks', async () => {
    fetchMock
      .mockResolvedValueOnce(rateLimited('2'))
      .mockResolvedValueOnce(staffPage());

    const pending = client.getStaff(4564);
    await jest.advanceTimersByTimeAsync(1_999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual([{ id: 7 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails at once on a long Retry-After, saying how long to wait', async () => {
    fetchMock.mockResolvedValueOnce(rateLimited('30'));
    const observation = createToolCallObservation();

    const error = await runObservingToolCall(observation, () =>
      client.getStaff(4564)
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AltegioApiError);
    expect((error as AltegioApiError).statusCode).toBe(429);
    expect((error as Error).message).toContain(
      'Altegio is limiting the request rate while trying to fetch staff (HTTP 429). Wait 30 seconds before the next request, and send requests one at a time'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observation.upstreamErrorStatus).toBe(429);
  });

  it('reads again only once', async () => {
    fetchMock
      .mockResolvedValueOnce(rateLimited())
      .mockResolvedValueOnce(rateLimited('1'));
    const observation = createToolCallObservation();

    const pending = runObservingToolCall(observation, () =>
      client.getStaff(4564)
    ).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(1_000);
    const error = await pending;

    expect((error as Error).message).toContain('Wait 1 second before');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(observation).toMatchObject({
      upstreamErrorStatus: 429,
      upstreamRetries: 1,
    });
  });

  it('shares the one repeat with a dropped connection', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(rateLimited());

    const pending = client.getStaff(4564).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(1_000);
    const error = await pending;

    expect((error as AltegioApiError).statusCode).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never repeats a write', async () => {
    fetchMock.mockResolvedValueOnce(rateLimited());

    const error = await client
      .createStaff(4564, newStaff)
      .catch((e: unknown) => e);

    expect((error as AltegioApiError).statusCode).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['caller', 'deadline'] as const)(
    'stops a scheduled repeat when the %s cancels it',
    async (cancellation) => {
      fetchMock.mockResolvedValueOnce(rateLimited());
      const controller = new AbortController();
      const reason = new DOMException('stop waiting', 'AbortError');
      if (cancellation === 'deadline') {
        client = new AltegioClient({ ...config, timeout: 500 }, testDir);
      }

      const pending = client
        .apiRequest('/staff/4564', { signal: controller.signal })
        .catch((error: unknown) => error);
      await jest.advanceTimersByTimeAsync(499);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      if (cancellation === 'caller') controller.abort(reason);
      else await jest.advanceTimersByTimeAsync(1);

      if (cancellation === 'caller') expect(await pending).toBe(reason);
      else expect(await pending).toMatchObject({ name: 'TimeoutError' });
      await jest.advanceTimersByTimeAsync(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    }
  );
});

describe('retryAfterSeconds', () => {
  it('reads seconds and an HTTP date, and nothing else', () => {
    const at = (value: string) => new Headers({ 'Retry-After': value });
    expect(retryAfterSeconds(at('3'))).toBe(3);
    expect(
      retryAfterSeconds(at(new Date(Date.now() + 10_000).toUTCString()))
    ).toBeGreaterThanOrEqual(9);
    expect(retryAfterSeconds(at('soon'))).toBeUndefined();
    expect(retryAfterSeconds(new Headers())).toBeUndefined();
    expect(retryAfterSeconds(undefined)).toBeUndefined();
  });
});
