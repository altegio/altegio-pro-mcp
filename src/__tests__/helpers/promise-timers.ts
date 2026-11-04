import type { TimerOptions } from 'node:timers';

/**
 * Route promise sleeps through the current Jest clock in mocked-fetch suites.
 * Jest replaces global timers in its sandbox, but not node:timers/promises.
 * Keep the native timer's cancellation shape and listener cleanup; transport
 * integration suites continue to use native promise timers.
 */
export function clockTimeout<T = void>(
  ms = 1,
  value?: T,
  { signal, ref = true }: TimerOptions = {}
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(
        Object.assign(
          new Error('The operation was aborted', { cause: signal?.reason }),
          { name: 'AbortError', code: 'ABORT_ERR' }
        )
      );
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve(value as T);
    }, ms);
    if (!ref) timer.unref();
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}
