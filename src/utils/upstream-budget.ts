import { setTimeout as delay } from 'node:timers/promises';
import { currentRequestSignal } from './request-lifecycle.js';
import { AltegioApiError } from './errors.js';
import { noteRateLimited } from './tool-call-observation.js';

/** One budget covers admission, every read attempt, headers and the final body. */
export class UpstreamBudget {
  readonly signal: AbortSignal;
  private readonly cancellation: AbortSignal;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly deadlineAt: number;
  /**
   * Time a request needs once admitted: a slot that opens later than this
   * before the deadline would still end in a timeout.
   */
  readonly requestAllowanceMs: number;
  constructor(timeoutMs: number, signal?: AbortSignal | null) {
    this.deadlineAt = performance.now() + timeoutMs;
    this.requestAllowanceMs = Math.min(1000, timeoutMs / 5);
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
  /** Milliseconds left before the deadline. */
  remainingMs(): number {
    return this.deadlineAt - performance.now();
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

/**
 * The caller's own request rate is at its limit, and no request slot opens
 * before this call's deadline: refused at once, with nothing sent, instead of
 * waiting out the deadline in the queue.
 */
export class UpstreamRateLimitedError extends AltegioApiError {
  constructor(
    readonly waitMs: number,
    requests: number,
    windowMs: number
  ) {
    const seconds = Math.max(1, Math.ceil(waitMs / 1000));
    super(
      `The next request to Altegio was not sent: this connection already made its ${requests} requests ` +
        `for the last ${Math.round(windowMs / 1000)} seconds, and the next one fits in about ${seconds} seconds, ` +
        'later than this call could wait. Wait that long before the next call, and send calls one at a ' +
        'time rather than in parallel or in a tight loop.',
      429
    );
    this.name = 'UpstreamRateLimitedError';
    noteRateLimited();
  }
}

/**
 * Sliding-window admission, bounded by each call's own request budget. A
 * call that would get its slot only after its deadline is refused at once:
 * waiting would end in a timeout anyway, and it would hold up the calls
 * queued behind it.
 */
export class UpstreamRateGate {
  private timestamps: number[] = [];
  /** Calls queued for a slot, by arrival; the earlier ones get slots first. */
  private readonly queue: number[] = [];
  private nextTicket = 0;
  constructor(
    private readonly requests: number,
    private readonly windowMs: number
  ) {}
  async admit(budget: UpstreamBudget): Promise<void> {
    const ticket = this.nextTicket++;
    this.queue.push(ticket);
    try {
      for (;;) {
        budget.signal.throwIfAborted();
        const now = performance.now();
        this.timestamps = this.timestamps.filter(
          (at) => at > now - this.windowMs
        );
        const ahead = this.queue.indexOf(ticket);
        if (this.timestamps.length + ahead < this.requests) {
          this.timestamps.push(now);
          return;
        }
        // The slot this call can expect: free room and the slots that open
        // first go to the calls queued ahead of it. A slot that only a request
        // not made yet would free opens a window after it at the earliest.
        const index = this.timestamps.length + ahead - this.requests;
        const opensAt =
          index < this.timestamps.length
            ? this.timestamps[index]! + this.windowMs
            : now + this.windowMs;
        if (opensAt - now > budget.remainingMs() - budget.requestAllowanceMs) {
          throw new UpstreamRateLimitedError(
            opensAt - now,
            this.requests,
            this.windowMs
          );
        }
        // Wake when the oldest slot frees, or soon when only the calls ahead
        // still have to take the free ones.
        const oldest = this.timestamps[0];
        await budget.pause(
          Math.max(1, oldest === undefined ? 1 : oldest + this.windowMs - now)
        );
      }
    } finally {
      this.queue.splice(this.queue.indexOf(ticket), 1);
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
