/**
 * How often one caller may get something in a sliding window: the report
 * limit of `feedback_submit` and the stale-list nudge of `./registry.ts`.
 * Process-local, like the sessions, and bounded: the least recently counted
 * caller is forgotten first.
 */
import { requestPrincipalKey } from '../request-context.js';

export interface CallerQuota {
  /** Count one event for `caller`, or refuse it when the window is full. */
  admit(caller: string, now?: number): boolean;
  /** Forget every caller. */
  clear(): void;
}

/** Callers tracked at once by default. */
const MAX_TRACKED_CALLERS = 10_000;

export function createCallerQuota(options: {
  readonly limit: number;
  readonly windowMs: number;
  readonly maxCallers?: number;
}): CallerQuota {
  const { limit, windowMs, maxCallers = MAX_TRACKED_CALLERS } = options;
  const recent = new Map<string, number[]>();
  return {
    admit(caller, now = Date.now()) {
      const since = now - windowMs;
      const times = (recent.get(caller) ?? []).filter((t) => t > since);
      const admitted = times.length < limit;
      if (admitted) times.push(now);
      recent.delete(caller);
      recent.set(caller, times);
      if (recent.size > maxCallers) {
        const oldest = recent.keys().next().value;
        if (oldest !== undefined) recent.delete(oldest);
      }
      return admitted;
    },
    clear() {
      recent.clear();
    },
  };
}

/**
 * Who a quota counts: the signed-in principal, else the MCP session. Some
 * hosts open a session per call, so a session alone would not bound a caller.
 */
export function quotaCaller(session: unknown): string {
  return (
    requestPrincipalKey() ?? (typeof session === 'string' ? session : 'local')
  );
}
