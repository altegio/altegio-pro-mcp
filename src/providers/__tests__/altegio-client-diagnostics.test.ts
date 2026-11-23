import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AltegioClient } from '../altegio-client.js';
import {
  UpstreamRateGate,
  UpstreamRateLimitedError,
} from '../../utils/upstream-budget.js';
import {
  createToolCallObservation,
  runObservingToolCall,
} from '../../utils/tool-call-observation.js';

jest.mock('node:timers/promises', () => ({
  ...jest.requireActual('node:timers/promises'),
  setTimeout: jest.requireActual('../../__tests__/helpers/promise-timers.js')
    .clockTimeout,
}));

let testDir: string;
let client: AltegioClient;
let fetchMock: jest.SpiedFunction<typeof fetch>;
const endpoint = '/locations/123/appointments/456?user_hash=PRIVATE';
const template = '/locations/{location_id}/appointments/{appointment_id}';

beforeEach(() => {
  jest.useFakeTimers();
  testDir = mkdtempSync(join(tmpdir(), 'altegio-diagnostics-'));
  client = new AltegioClient(
    { partnerToken: 'synthetic', userToken: 'synthetic', timeout: 50 },
    testDir
  );
  fetchMock = jest.spyOn(global, 'fetch');
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  rmSync(testDir, { recursive: true, force: true });
});

it('refuses at once, sending nothing, when no slot opens before the deadline', async () => {
  client = new AltegioClient(
    { partnerToken: 'synthetic', timeout: 50 },
    testDir,
    { rateGate: new UpstreamRateGate(1, 1000) }
  );
  fetchMock.mockResolvedValue(new Response('ok'));
  await (await client.apiRequest(endpoint)).text();
  fetchMock.mockClear();
  const observation = createToolCallObservation();
  const started = Date.now();
  const error = await runObservingToolCall(observation, () =>
    client.apiRequest(endpoint, { method: 'PUT' })
  ).catch((e: unknown) => e);
  // No time passed in the queue: the refusal does not wait for the deadline.
  expect(Date.now() - started).toBe(0);
  expect(error).toBeInstanceOf(UpstreamRateLimitedError);
  expect((error as UpstreamRateLimitedError).statusCode).toBe(429);
  expect((error as Error).message).toContain(
    'the next one fits in about 1 seconds'
  );
  expect(fetchMock).not.toHaveBeenCalled();
  expect(observation.rateLimited).toBe(true);
  expect(observation.upstreamFailure).toBeUndefined();
  expect(observation.upstreamRequests ?? 0).toBe(0);
});

it('waits for a slot that opens before the deadline', async () => {
  client = new AltegioClient(
    { partnerToken: 'synthetic', timeout: 500 },
    testDir,
    { rateGate: new UpstreamRateGate(1, 100) }
  );
  fetchMock.mockImplementation(async () => new Response('ok'));
  await (await client.apiRequest(endpoint)).text();
  const second = client.apiRequest(endpoint);
  await jest.advanceTimersByTimeAsync(100);
  await expect((await second).text()).resolves.toBe('ok');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('counts the calls queued ahead when it decides', async () => {
  // Two slots per 100 ms, used at 0 and 60 ms. At 60 ms the next slot opens
  // at 100 ms and the one after at 160 ms. With a 100 ms budget (80 ms after
  // the request allowance), the first queued call waits 40 ms; the second,
  // whose slot is 100 ms away, is refused at once.
  client = new AltegioClient(
    { partnerToken: 'synthetic', timeout: 100 },
    testDir,
    { rateGate: new UpstreamRateGate(2, 100) }
  );
  fetchMock.mockImplementation(async () => new Response('ok'));
  await (await client.apiRequest(endpoint)).text();
  await jest.advanceTimersByTimeAsync(60);
  await (await client.apiRequest(endpoint)).text();

  const settled: string[] = [];
  const first = client.apiRequest(endpoint).then(
    () => settled.push('first admitted'),
    () => settled.push('first refused')
  );
  const second = client.apiRequest(endpoint).then(
    () => settled.push('second admitted'),
    (error: unknown) =>
      settled.push(
        error instanceof UpstreamRateLimitedError
          ? 'second refused'
          : 'second failed'
      )
  );
  await jest.advanceTimersByTimeAsync(0);
  // Refused before any time passed, while the first is still queued.
  expect(settled).toEqual(['second refused']);
  await jest.advanceTimersByTimeAsync(40);
  await Promise.all([first, second]);
  expect(settled).toEqual(['second refused', 'first admitted']);
});

it('records a retry refused at admission as a failure of the request it follows', async () => {
  client = new AltegioClient(
    { partnerToken: 'synthetic', timeout: 500 },
    testDir,
    { rateGate: new UpstreamRateGate(1, 1000) }
  );
  // Altegio answers 429 with a short Retry-After; the retry needs a slot the
  // gate cannot give before the deadline.
  fetchMock.mockImplementation(
    async () =>
      new Response('{}', { status: 429, headers: { 'Retry-After': '0' } })
  );
  const observation = createToolCallObservation();
  const pending = runObservingToolCall(observation, () =>
    client.apiRequest(endpoint)
  ).catch((e: unknown) => e);
  // The client waits at least 100 ms before a retry.
  await jest.advanceTimersByTimeAsync(150);
  const error = await pending;
  expect(error).toBeInstanceOf(UpstreamRateLimitedError);
  expect((error as Error).message).toContain(
    'The next request to Altegio was not sent'
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(observation.upstreamFailureDetail).toMatchObject({
    phase: 'admission',
  });
});

it.each(['GET', 'PUT'])(
  'records a %s header timeout without replaying it',
  async (method) => {
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(init!.signal!.reason),
            { once: true }
          );
        })
    );
    const observation = createToolCallObservation();
    const rejected = expect(
      runObservingToolCall(observation, () =>
        client.apiRequest(endpoint, { method })
      )
    ).rejects.toThrow('deadline');
    await jest.advanceTimersByTimeAsync(50);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(observation).toMatchObject({
      upstreamResponses: 0,
      upstreamRequests: 1,
      upstreamFailure: 'timeout',
      upstreamFailureDetail: { phase: 'headers', method, route: template },
    });
    expect(JSON.stringify(observation)).not.toMatch(/PRIVATE|123|456/);
  }
);

it('attributes a delayed body timeout to the original call when consumed outside its context', async () => {
  fetchMock.mockResolvedValue(new Response(new ReadableStream()));
  const observation = createToolCallObservation();
  const response = await runObservingToolCall(observation, () =>
    client.apiRequest(endpoint)
  );
  const unrelated = createToolCallObservation();
  const rejected = expect(
    runObservingToolCall(unrelated, () => response.text())
  ).rejects.toThrow('deadline');
  await jest.advanceTimersByTimeAsync(50);
  await rejected;
  expect(observation).toMatchObject({
    upstreamResponses: 1,
    upstreamRequests: 1,
    upstreamFailure: 'timeout',
    upstreamFailureDetail: { phase: 'body', method: 'GET', route: template },
  });
  expect(unrelated).toEqual({ upstreamResponses: 0 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('keeps caller cancellation separate from deadline exhaustion, including custom abort reasons', async () => {
  const controller = new AbortController();
  fetchMock.mockResolvedValue(new Response(new ReadableStream()));
  const observation = createToolCallObservation();
  const response = await runObservingToolCall(observation, () =>
    client.apiRequest(endpoint, { method: 'PUT', signal: controller.signal })
  );
  const rejected = expect(response.text()).rejects.toThrow(
    'cancelled by caller'
  );
  controller.abort(new Error('cancelled by caller PRIVATE'));
  await rejected;
  expect(observation).toMatchObject({
    upstreamFailure: 'cancelled',
    upstreamFailureDetail: { phase: 'body', method: 'PUT', route: template },
  });
  expect(JSON.stringify(observation)).not.toContain('PRIVATE');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('records retry-wait exhaustion after a retryable read fails', async () => {
  fetchMock.mockRejectedValue(new TypeError('private upstream failure'));
  const observation = createToolCallObservation();
  const rejected = expect(
    runObservingToolCall(observation, () => client.apiRequest(endpoint))
  ).rejects.toThrow('deadline');
  await jest.advanceTimersByTimeAsync(50);
  await rejected;
  expect(observation).toMatchObject({
    upstreamFailure: 'timeout',
    upstreamRequests: 1,
    upstreamFailureDetail: { phase: 'retry_wait' },
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('records a body network failure without retrying an ambiguous write', async () => {
  let body!: ReadableStreamDefaultController<Uint8Array>;
  fetchMock.mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          body = controller;
        },
      })
    )
  );
  const observation = createToolCallObservation();
  const response = await runObservingToolCall(observation, () =>
    client.apiRequest(endpoint, { method: 'PUT' })
  );
  const rejected = expect(response.text()).rejects.toThrow('PRIVATE');
  body.error(new TypeError('PRIVATE body failure'));
  await rejected;
  expect(observation).toMatchObject({
    upstreamFailure: 'network',
    upstreamFailureDetail: { phase: 'body' },
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(observation)).not.toContain('PRIVATE');
});

it('counts an HTTP 429 response when its retry wait exhausts the deadline', async () => {
  fetchMock.mockResolvedValue(new Response('limited', { status: 429 }));
  const observation = createToolCallObservation();
  const rejected = expect(
    runObservingToolCall(observation, () => client.apiRequest(endpoint))
  ).rejects.toThrow('deadline');
  await jest.advanceTimersByTimeAsync(50);
  await rejected;
  expect(observation).toMatchObject({
    upstreamRequests: 1,
    upstreamResponses: 1,
    upstreamFailure: 'timeout',
    upstreamFailureDetail: { phase: 'retry_wait' },
  });
  expect(observation.upstreamErrorStatus).toBeUndefined();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('never logs unrecognized paths or methods', async () => {
  fetchMock.mockRejectedValue(new TypeError('PRIVATE'));
  const observation = createToolCallObservation();
  await expect(
    runObservingToolCall(observation, () =>
      client.apiRequest('/customer@example.com/PRIVATE?token=PRIVATE', {
        method: 'PRIVATE',
      })
    )
  ).rejects.toThrow();
  expect(observation.upstreamFailureDetail).toEqual({
    phase: 'headers',
    method: 'other',
    route: 'other',
  });
  expect(JSON.stringify(observation)).not.toMatch(/PRIVATE|example/);
});

it('records legacy report body failure without retaining the credential-bearing URL', async () => {
  fetchMock.mockResolvedValue(new Response(new ReadableStream()));
  const observation = createToolCallObservation();
  const response = await runObservingToolCall(observation, () =>
    client.requestLegacyWebReport({
      locationId: 123,
      path: '/finances_reports/account_period_search/123/',
      query: { start_date: 'PRIVATE' },
    })
  );
  const rejected = expect(response.text()).rejects.toThrow('deadline');
  await jest.advanceTimersByTimeAsync(50);
  await rejected;
  expect(observation).toMatchObject({
    upstreamRequests: 1,
    upstreamResponses: 1,
    upstreamFailure: 'timeout',
    upstreamFailureDetail: {
      phase: 'body',
      method: 'GET',
      route: '/finances_reports/account_period_search/{location_id}/',
    },
  });
  expect(JSON.stringify(observation)).not.toMatch(/PRIVATE|123|synthetic/);
});
