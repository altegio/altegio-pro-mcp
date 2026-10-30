import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import {
  DEFAULT_EVICTION_GRACE_MS,
  HttpSessionBudget,
  type HttpSessionEviction,
} from '../utils/http-sessions.js';

const closer = () =>
  jest.fn<() => Promise<void>>().mockResolvedValue(undefined);

describe('HTTP session memory budget', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('frees a slot after idle expiry', async () => {
    const budget = new HttpSessionBudget(1, 100);
    const close = closer();
    expect(budget.acquire(close)).toBeDefined();
    expect(budget.size).toBe(1);
    await jest.advanceTimersByTimeAsync(100);
    expect(close).toHaveBeenCalledTimes(1);
    expect(budget.size).toBe(0);
  });

  it('refreshes idle time on activity, including SSE reconnects', async () => {
    const budget = new HttpSessionBudget(1, 100);
    const close = closer();
    const lease = budget.acquire(close)!;
    await jest.advanceTimersByTimeAsync(90);
    lease.touch();
    await jest.advanceTimersByTimeAsync(90);
    expect(close).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(10);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('expires a session that never did real work sooner than one that did', async () => {
    const budget = new HttpSessionBudget(2, {
      idleTimeoutMs: 1000,
      unusedIdleTimeoutMs: 100,
    });
    const probeClose = closer();
    const workClose = closer();
    budget.acquire(probeClose);
    const working = budget.acquire(workClose)!;
    const finish = working.beginPost();
    working.markUsed();
    finish();

    await jest.advanceTimersByTimeAsync(100);
    expect(probeClose).toHaveBeenCalledTimes(1);
    expect(workClose).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(900);
    expect(workClose).toHaveBeenCalledTimes(1);
  });

  it('never lets the short expiry exceed the configured one', async () => {
    const budget = new HttpSessionBudget(1, {
      idleTimeoutMs: 50,
      unusedIdleTimeoutMs: 1000,
    });
    const close = closer();
    budget.acquire(close);
    await jest.advanceTimersByTimeAsync(50);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does not expire long-running or overlapping POST responses', async () => {
    const budget = new HttpSessionBudget(1, 100);
    const close = closer();
    const lease = budget.acquire(close)!;
    const first = lease.beginPost();
    const second = lease.beginPost();
    await jest.advanceTimersByTimeAsync(1000);
    first();
    first(); // finish and close can both fire for one response
    lease.touch();
    await jest.advanceTimersByTimeAsync(1000);
    expect(close).not.toHaveBeenCalled();
    second();
    await jest.advanceTimersByTimeAsync(100);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('releases terminated or failed initializations without closing twice', async () => {
    const budget = new HttpSessionBudget(1, 100);
    const close = closer();
    const lease = budget.acquire(close)!;
    const finish = lease.beginPost();
    lease.release();
    lease.release();
    finish();
    lease.touch();
    expect(budget.acquire(close)).toBeDefined();
    await jest.advanceTimersByTimeAsync(100);
    expect(close).toHaveBeenCalledTimes(1); // only the replacement expired
  });
});

describe('HTTP session budget at capacity', () => {
  let clock = 0;
  const now = () => clock;

  beforeEach(() => {
    jest.useFakeTimers();
    clock = 0;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('evicts the least recently used idle session instead of refusing', () => {
    const evictions: HttpSessionEviction[] = [];
    const budget = new HttpSessionBudget(2, {
      now,
      onEvict: (eviction) => evictions.push(eviction),
    });
    const closes = [closer(), closer(), closer()];
    const older = budget.acquire(closes[0]!)!;
    clock = 1000;
    budget.acquire(closes[1]!);
    clock = 2000;
    older.touch(); // the first session is now the most recently used
    clock = 5000;

    expect(budget.acquire(closes[2]!)).toBeDefined();
    expect(closes[1]).toHaveBeenCalledTimes(1);
    expect(closes[0]).not.toHaveBeenCalled();
    expect(budget.size).toBe(2);
    expect(evictions).toEqual([{ used: false, idleSeconds: 4, sessions: 1 }]);
  });

  it('evicts a session that never did real work before one that did', () => {
    const budget = new HttpSessionBudget(2, { now });
    const usedClose = closer();
    const probeClose = closer();
    const used = budget.acquire(usedClose)!;
    used.markUsed();
    clock = 1000;
    budget.acquire(probeClose);
    clock = 1000 + DEFAULT_EVICTION_GRACE_MS; // both past the grace

    expect(budget.acquire(closer())).toBeDefined();
    expect(probeClose).toHaveBeenCalledTimes(1);
    expect(usedClose).not.toHaveBeenCalled();
  });

  it('spares a session that just initialized for its first tool call', () => {
    // 2026-10-23: a host that opens a session per call lost each new session
    // to the next initialize and got 404 on the call a second later.
    const evictions: HttpSessionEviction[] = [];
    const budget = new HttpSessionBudget(2, {
      now,
      onEvict: (eviction) => evictions.push(eviction),
    });
    const staleClose = closer();
    const freshClose = closer();
    budget.acquire(staleClose)!.markUsed();
    clock = 10 * 60 * 1000;
    budget.acquire(freshClose); // initialized, tool call still to come
    clock += 1000;

    expect(budget.acquire(closer())).toBeDefined();
    expect(freshClose).not.toHaveBeenCalled();
    expect(staleClose).toHaveBeenCalledTimes(1);
    expect(evictions).toEqual([{ used: true, idleSeconds: 601, sessions: 1 }]);
  });

  it('takes the oldest idle session when every idle one is inside the grace', () => {
    const budget = new HttpSessionBudget(3, { now, evictionGraceMs: 60_000 });
    const closes = [closer(), closer(), closer()];
    budget.acquire(closes[0]!)!.markUsed();
    clock = 1000;
    budget.acquire(closes[1]!);
    clock = 2000;
    budget.acquire(closes[2]!);
    clock = 3000;

    expect(budget.acquire(closer())).toBeDefined();
    expect(closes[0]).toHaveBeenCalledTimes(1);
    expect(closes[1]).not.toHaveBeenCalled();
    expect(closes[2]).not.toHaveBeenCalled();
  });

  it('refuses only when every session is serving a request', () => {
    const budget = new HttpSessionBudget(2, { now });
    const busy = [closer(), closer()];
    const finishes = busy.map((close) => budget.acquire(close)!.beginPost());

    expect(budget.acquire(closer())).toBeUndefined();
    for (const close of busy) expect(close).not.toHaveBeenCalled();

    finishes[1]!();
    expect(budget.acquire(closer())).toBeDefined();
    expect(busy[1]).toHaveBeenCalledTimes(1);
    expect(busy[0]).not.toHaveBeenCalled();
  });

  it('never holds more leases than its capacity', () => {
    const budget = new HttpSessionBudget(3, { now });
    for (let i = 0; i < 50; i++) {
      clock += 10;
      expect(budget.acquire(closer())).toBeDefined();
      expect(budget.size).toBeLessThanOrEqual(3);
    }
  });
});
