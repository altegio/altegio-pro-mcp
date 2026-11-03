import {
  RequestActivity,
  currentRequestSignal,
} from '../utils/request-lifecycle.js';

it('stops accepting work in per-request descendants when the runtime drains', async () => {
  const runtime = new RequestActivity();
  const request = new RequestActivity(runtime);
  runtime.stop();
  const handler = jest.fn(async () => 'unexpected');
  await expect(request.run(undefined, handler)).rejects.toThrow(
    'Server is draining'
  );
  expect(handler).not.toHaveBeenCalled();
  expect(await runtime.drain(10)).toBe(true);
});

it('propagates the runtime shutdown deadline to nested request cancellation', async () => {
  const runtime = new RequestActivity();
  const request = new RequestActivity(new RequestActivity(runtime));
  const pending = request.run(
    undefined,
    async () =>
      new Promise((_, reject) => {
        const signal = currentRequestSignal()!;
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      })
  );
  const cancelled = expect(pending).rejects.toThrow(
    'Server drain deadline exceeded'
  );
  runtime.abort();
  await cancelled;
  expect(await runtime.drain(10)).toBe(true);
});
