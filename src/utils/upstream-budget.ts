import { setTimeout as delay } from 'node:timers/promises';
import { currentRequestSignal } from './request-lifecycle.js';

/** One budget covers admission, every read attempt, headers and the final body. */
export class UpstreamBudget {
  readonly signal: AbortSignal;
  private readonly cancellation: AbortSignal;
  private readonly timer: ReturnType<typeof setTimeout>;
  constructor(timeoutMs: number, signal?: AbortSignal | null) {
    const deadline = new AbortController();
    this.timer = setTimeout(
      () =>
        deadline.abort(
          new DOMException('Altegio request deadline exceeded', 'TimeoutError')
        ),
      timeoutMs
    );
    this.timer.unref();
    this.cancellation = AbortSignal.any(
      [signal, currentRequestSignal()].filter((s): s is AbortSignal => !!s)
    );
    this.signal = AbortSignal.any([deadline.signal, this.cancellation]);
  }
  get cancelled(): boolean {
    return (
      this.cancellation.aborted &&
      this.signal.reason === this.cancellation.reason
    );
  }
  close(): void {
    clearTimeout(this.timer);
  }
  async pause(ms: number): Promise<void> {
    this.signal.throwIfAborted();
    try {
      await delay(ms, undefined, { signal: this.signal });
    } catch {
      this.signal.throwIfAborted();
    }
  }
  async fetch(
    url: string | URL,
    init: RequestInit = {},
    fetchImpl: typeof fetch = fetch
  ): Promise<Response> {
    this.signal.throwIfAborted();
    return fetchImpl(url, { ...init, signal: this.signal });
  }

  /** Retain the deadline until a consumer drains/cancels the body, including streaming readers. */
  response(response: Response, onFailure?: (error: unknown) => void): Response {
    if (response.body?.getReader) {
      const reader = response.body.getReader();
      const signal = this.signal;
      let ended = false;
      let abort: () => void;
      const finish = () => {
        if (ended) return;
        ended = true;
        signal.removeEventListener('abort', abort);
        this.close();
      };
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          abort = () => {
            if (ended) return;
            onFailure?.(signal.reason);
            controller.error(signal.reason);
            finish();
            void reader.cancel(signal.reason).catch(() => undefined);
          };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        },
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (ended) return;
            if (done) {
              finish();
              controller.close();
            } else controller.enqueue(value);
          } catch (error) {
            if (!ended) {
              onFailure?.(signal.aborted ? signal.reason : error);
              finish();
              controller.error(signal.aborted ? signal.reason : error);
            }
          }
        },
        async cancel(reason) {
          finish();
          await reader.cancel(reason);
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    // Some adapter tests supply a structural Response with only json/text.
    // Bind those methods to their receiver and release the same budget on read.
    this.close();
    return response;
  }
}

/** Sliding-window admission, bounded by each call's own request budget. */
export class UpstreamRateGate {
  private timestamps: number[] = [];
  constructor(
    private readonly requests: number,
    private readonly windowMs: number
  ) {}
  async admit(budget: UpstreamBudget): Promise<void> {
    for (;;) {
      budget.signal.throwIfAborted();
      const now = performance.now();
      this.timestamps = this.timestamps.filter(
        (at) => at > now - this.windowMs
      );
      if (this.timestamps.length < this.requests) {
        this.timestamps.push(now);
        return;
      }
      await budget.pause(
        Math.max(1, this.timestamps[0]! + this.windowMs - now)
      );
    }
  }
}

export async function fetchWithDeadline(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl?: typeof fetch,
  onFailure?: (
    error: unknown,
    phase: 'headers' | 'body',
    cancelled: boolean
  ) => void
): Promise<Response> {
  const budget = new UpstreamBudget(timeoutMs, init.signal);
  try {
    return budget.response(await budget.fetch(url, init, fetchImpl), (error) =>
      onFailure?.(error, 'body', budget.cancelled)
    );
  } catch (error) {
    onFailure?.(error, 'headers', budget.cancelled);
    budget.close();
    throw error;
  }
}
