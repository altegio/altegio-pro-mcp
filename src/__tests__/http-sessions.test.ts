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
    expect(evictions).toEqual([
      { used: false, idleSeconds: 4, sessions: 1, principalSessions: 1 },
    ]);
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
    expect(evictions).toEqual([
      { used: true, idleSeconds: 601, sessions: 1, principalSessions: 1 },
    ]);
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

describe('HTTP session budget shared between callers', () => {
  let clock = 0;
  const now = () => clock;
  const MINUTE = 60 * 1000;

  beforeEach(() => {
    jest.useFakeTimers();
    clock = 0;
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /** A session that initialized and made one tool call, now idle. */
  const usedSession = (
    budget: HttpSessionBudget,
    principal: string | undefined,
    close = closer()
  ) => {
    const lease = budget.acquire(close, { principal })!;
    lease.beginPost()();
    lease.markUsed();
    return { lease, close };
  };

  it('takes the slot from the caller holding the most sessions, not the oldest one', () => {
    const evictions: HttpSessionEviction[] = [];
    const budget = new HttpSessionBudget(4, {
      now,
      onEvict: (eviction) => evictions.push(eviction),
    });
    // A conversation paused 12 minutes ago: the oldest session in the budget.
    const person = usedSession(budget, 'altegio-user-1');
    clock += 12 * MINUTE;
    // A client that opens a session per call, each newer than the pause.
    const churn = [1, 2, 3].map(() => {
      clock += 2 * MINUTE;
      return usedSession(budget, 'token-churn');
    });
    clock += 2 * MINUTE;

    expect(
      budget.acquire(closer(), { principal: 'token-churn' })
    ).toBeDefined();
    expect(person.close).not.toHaveBeenCalled();
    expect(churn[0]!.close).toHaveBeenCalledTimes(1);
    expect(churn[1]!.close).not.toHaveBeenCalled();
    expect(evictions).toEqual([
      { used: true, idleSeconds: 360, sessions: 3, principalSessions: 3 },
    ]);
  });

  it('keeps every person’s session while a churning client fills the budget', () => {
    // 2026-11-23: up to 6.5k evictions a day, 93% of used sessions idle a
    // median 12.5 min, while Codex opened 2.7 sessions per tool call.
    const capacity = 16;
    const budget = new HttpSessionBudget(capacity, { now });
    const people = Array.from({ length: 5 }, (_, i) =>
      usedSession(budget, `altegio-user-${i}`)
    );
    for (let call = 0; call < 500; call++) {
      clock += 20 * 1000;
      // Initialize, then a tool call on a fresh session; the last ones stay
      // inside the grace, the rest are abandoned.
      expect(usedSession(budget, 'token-codex').lease).toBeDefined();
      // A probe that never calls a tool, every third call.
      if (call % 3 === 0) {
        expect(
          budget.acquire(closer(), { principal: 'token-codex' })
        ).toBeDefined();
      }
      expect(budget.size).toBeLessThanOrEqual(capacity);
    }
    // 2.8 hours of churn later, nobody's paused conversation was taken.
    for (const person of people) expect(person.close).not.toHaveBeenCalled();
  });

  it('falls back to the least recently used between equal shares', () => {
    const budget = new HttpSessionBudget(2, { now });
    const first = usedSession(budget, 'altegio-user-1');
    clock += MINUTE;
    const second = usedSession(budget, 'altegio-user-2');
    clock += 2 * MINUTE;

    expect(
      budget.acquire(closer(), { principal: 'altegio-user-3' })
    ).toBeDefined();
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).not.toHaveBeenCalled();
  });

  it('counts a caller of unknown identity as a caller of its own', () => {
    const budget = new HttpSessionBudget(3, { now });
    const unknown = [
      usedSession(budget, undefined),
      usedSession(budget, undefined),
    ];
    clock += MINUTE;
    const known = [usedSession(budget, 'altegio-user-1')];
    clock += 2 * MINUTE;

    // Two unknown sessions are not one caller holding two: the oldest goes.
    expect(budget.acquire(closer())).toBeDefined();
    expect(unknown[0]!.close).toHaveBeenCalledTimes(1);
    expect(unknown[1]!.close).not.toHaveBeenCalled();
    expect(known[0]!.close).not.toHaveBeenCalled();
  });

  it('still takes a session that never made a tool call first', () => {
    const budget = new HttpSessionBudget(3, { now });
    const heavy = [
      usedSession(budget, 'token-churn'),
      usedSession(budget, 'token-churn'),
    ];
    clock += MINUTE;
    const probe = closer();
    budget.acquire(probe, { principal: 'altegio-user-1' });
    clock += 2 * MINUTE;

    expect(
      budget.acquire(closer(), { principal: 'token-churn' })
    ).toBeDefined();
    expect(probe).toHaveBeenCalledTimes(1);
    for (const session of heavy) expect(session.close).not.toHaveBeenCalled();
  });

  it('spares the heavy caller’s sessions inside the grace before a lighter caller’s older one', () => {
    const budget = new HttpSessionBudget(3, { now });
    const person = usedSession(budget, 'altegio-user-1');
    clock += 10 * MINUTE;
    // Initialized a moment ago, its tool call still to come.
    const fresh = [
      usedSession(budget, 'token-churn'),
      usedSession(budget, 'token-churn'),
    ];
    clock += 1000;

    expect(
      budget.acquire(closer(), { principal: 'token-churn' })
    ).toBeDefined();
    expect(person.close).toHaveBeenCalledTimes(1);
    for (const session of fresh) expect(session.close).not.toHaveBeenCalled();
  });
});
