import { AltegioClient } from '../altegio-client.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AltegioConfig } from '../../types/altegio.types.js';
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

/** What undici throws when a kept-alive connection was closed under it. */
function droppedConnection(): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('other side closed'), {
      code: 'UND_ERR_SOCKET',
    }),
  });
}

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

describe('AltegioClient - a read that got no response', () => {
  let client: AltegioClient;
  let fetchMock: jest.Mock;
  let testDir: string;

  beforeEach(() => {
    jest.useFakeTimers();
    testDir = mkdtempSync(join(tmpdir(), 'altegio-network-retry-'));
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

  it('is sent once more after a dropped connection, and the call succeeds', async () => {
    fetchMock
      .mockRejectedValueOnce(droppedConnection())
      .mockResolvedValueOnce(ok({ success: true, data: [{ id: 7 }] }));
    const observation = createToolCallObservation();

    const pending = runObservingToolCall(observation, () =>
      client.getStaff(4564)
    );
    await jest.advanceTimersByTimeAsync(149);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual([{ id: 7 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[0]).toBe(fetchMock.mock.calls[0]?.[0]);
    expect(observation).toMatchObject({
      upstreamResponses: 1,
      upstreamRetries: 1,
    });
    expect(observation.upstreamFailure).toBeUndefined();
  });

  it('fails as a network failure when the second attempt drops too', async () => {
    fetchMock
      .mockRejectedValueOnce(droppedConnection())
      .mockRejectedValueOnce(droppedConnection());
    const observation = createToolCallObservation();

    const rejected = expect(
      runObservingToolCall(observation, () => client.getStaff(4564))
    ).rejects.toThrow('fetch failed');
    await jest.advanceTimersByTimeAsync(149);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    await rejected;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(observation).toMatchObject({
      upstreamFailure: 'network',
      upstreamRetries: 1,
    });
  });

  it('never repeats a write: it may have been applied before the drop', async () => {
    fetchMock.mockRejectedValueOnce(droppedConnection());

    await expect(
      client.createStaff(4564, {
        name: 'John Doe',
        specialization: 'Stylist',
        position_id: 1,
        user_email: 'john@example.com',
        user_phone: '1234567890',
        is_user_invite: false,
        is_paid_staff: true,
        has_timetable_access: false,
      })
    ).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not repeat a read that timed out', async () => {
    fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('The operation timed out.'), {
        name: 'TimeoutError',
      })
    );
    const observation = createToolCallObservation();

    await expect(
      runObservingToolCall(observation, () => client.getStaff(4564))
    ).rejects.toThrow('timed out');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observation.upstreamFailure).toBe('timeout');
    expect(observation.upstreamRetries).toBeUndefined();
  });
});
