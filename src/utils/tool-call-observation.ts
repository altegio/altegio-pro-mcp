/**
 * What one `tools/call` did on its way to its result, for the `tool_call` log.
 *
 * Tool handlers turn their failures into `isError` results before the registry
 * sees them (`withErrorHandling`), which leaves the registry with a result and
 * no cause. This module is the side channel that keeps the cause: the upstream
 * HTTP layer notes the status of every Altegio response, and the shared error
 * base classes note themselves when they are constructed. The registry opens
 * one observation per call and reads it back only to classify a failure.
 *
 * It is a leaf module on purpose — no imports — so the error classes and the
 * HTTP client can depend on it without an import cycle. Nothing here is ever
 * logged as-is: the registry reduces it to a class name and a status code.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Why an upstream request produced no HTTP response at all. */
export type UpstreamFailure = 'timeout' | 'network';

export interface ToolCallObservation {
  /** Upstream requests that returned a response, whatever its status. */
  upstreamResponses: number;
  /** The most recent upstream status of 400 or above, if any. */
  upstreamErrorStatus?: number;
  /** The most recent upstream request that failed without a response. */
  upstreamFailure?: UpstreamFailure;
  /** The most recent typed error constructed during the call. */
  lastError?: Error;
}

const storage = new AsyncLocalStorage<ToolCallObservation>();

/** A fresh, empty observation for one tool call. */
export function createToolCallObservation(): ToolCallObservation {
  return { upstreamResponses: 0 };
}

/**
 * Run `fn` with `observation` bound. The caller keeps the object, so it can
 * still read what happened when `fn` throws.
 */
export function runObservingToolCall<T>(
  observation: ToolCallObservation,
  fn: () => T
): T {
  return storage.run(observation, fn);
}

/** Note one upstream HTTP response. A no-op outside a tool call. */
export function noteUpstreamResponse(status: number): void {
  const observation = storage.getStore();
  if (!observation) return;
  observation.upstreamResponses += 1;
  if (status >= 400) observation.upstreamErrorStatus = status;
}

/** Note an upstream request that failed before any response arrived. */
export function noteUpstreamFailure(error: unknown): void {
  const observation = storage.getStore();
  if (!observation) return;
  observation.upstreamFailure = isTimeout(error) ? 'timeout' : 'network';
}

/** Note a typed error at construction. A no-op outside a tool call. */
export function noteError(error: Error): void {
  const observation = storage.getStore();
  if (observation) observation.lastError = error;
}

/** A fetch or abort timeout, by error name or undici's cause code. */
export function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' && cause.code.includes('TIMEOUT');
}
