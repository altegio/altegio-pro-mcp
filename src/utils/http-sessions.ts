/** Default idle expiry of a session that has done real work (a tool call). */
export const DEFAULT_SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * Default idle expiry of a session that never did real work. Some hosts open a
 * session (initialize + tools/list) on every thread start and never call a
 * tool; holding those for half an hour is what filled the budget.
 */
export const DEFAULT_UNUSED_SESSION_IDLE_MS = 5 * 60 * 1000;

/**
 * How long a session is spared from capacity eviction after its last request.
 * A host that opens a session per call (ChatGPT) initializes and calls a tool
 * within a second or two; the next host's initialize must not take that slot.
 */
export const DEFAULT_EVICTION_GRACE_MS = 60 * 1000;

/** Counts reported when a session is evicted to make room; never an ID. */
export interface HttpSessionEviction {
  /** Whether the evicted session had made a tool call. */
  readonly used: boolean;
  /** How long it had been idle, in whole seconds. */
  readonly idleSeconds: number;
  /** Sessions held after the eviction, before the new one is added. */
  readonly sessions: number;
}

export interface HttpSessionBudgetOptions {
  /** Idle expiry once a session has done real work. */
  readonly idleTimeoutMs?: number;
  /** Idle expiry before it has; never longer than `idleTimeoutMs`. */
  readonly unusedIdleTimeoutMs?: number;
  /** Time after its last request during which a session is evicted last. */
  readonly evictionGraceMs?: number;
  readonly onEvict?: (eviction: HttpSessionEviction) => void;
  /** Clock, for tests. */
  readonly now?: () => number;
}

/**
 * Bound retained HTTP servers across all views, including abandoned sessions.
 *
 * Memory stays bounded by `maxSessions` leases. When the budget is full, a new
 * session takes the slot of the least recently used idle one — among those
 * idle past the eviction grace, a session that never made a tool call before
 * one that did — and only a budget whose every lease is serving a request
 * refuses. A per-request (sessionless) server holds a
 * lease too, for exactly as long as its request runs.
 */
export class HttpSessionBudget {
  /** Insertion order is recency order: the first entry is least recently used. */
  private readonly leases = new Set<HttpSessionLease>();
  private readonly idleTimeoutMs: number;
  private readonly unusedIdleTimeoutMs: number;
  private readonly evictionGraceMs: number;
  private readonly now: () => number;
  private readonly onEvict?: (eviction: HttpSessionEviction) => void;

  constructor(
    private readonly maxSessions: number,
    options: HttpSessionBudgetOptions | number = {}
  ) {
    const resolved =
      typeof options === 'number' ? { idleTimeoutMs: options } : options;
    this.idleTimeoutMs = resolved.idleTimeoutMs ?? DEFAULT_SESSION_IDLE_MS;
    this.unusedIdleTimeoutMs = Math.min(
      resolved.unusedIdleTimeoutMs ?? DEFAULT_UNUSED_SESSION_IDLE_MS,
      this.idleTimeoutMs
    );
    this.evictionGraceMs =
      resolved.evictionGraceMs ?? DEFAULT_EVICTION_GRACE_MS;
    this.now = resolved.now ?? Date.now;
    this.onEvict = resolved.onEvict;
  }

  /** Leases currently held. */
  get size(): number {
    return this.leases.size;
  }

  acquire(close: () => Promise<void>): HttpSessionLease | undefined {
    if (this.leases.size >= this.maxSessions && !this.evictIdle()) {
      return undefined;
    }
    const lease = new HttpSessionLease(
      (used) => (used ? this.idleTimeoutMs : this.unusedIdleTimeoutMs),
      close,
      {
        remove: () => {
          this.leases.delete(lease);
        },
        bump: () => {
          // Re-inserting moves the lease to the most recently used end.
          if (this.leases.delete(lease)) this.leases.add(lease);
        },
        now: this.now,
      }
    );
    this.leases.add(lease);
    lease.touch();
    return lease;
  }

  /**
   * Close one idle session to make room; false when every lease is busy.
   *
   * Among sessions idle past the grace, one that never made a tool call goes
   * before one that did, least recently used first. A session inside the
   * grace goes only when no older one is idle, and then the oldest. Until
   * 2026-10-24 the first unused session went whatever its age: on 2026-10-23
   * ChatGPT (a session per call) kept the customer budget full, 613 sessions
   * were evicted in three hours, most of them idle 0 s, and its tool calls
   * came back 404 a second or two after their initialize.
   */
  private evictIdle(): boolean {
    const now = this.now();
    let oldestIdle: HttpSessionLease | undefined;
    let usedPastGrace: HttpSessionLease | undefined;
    let unusedPastGrace: HttpSessionLease | undefined;
    // Recency order: once one lease is inside the grace, so is every later one.
    for (const lease of this.leases) {
      if (!lease.idle) continue;
      oldestIdle ??= lease;
      if (now - lease.lastActive < this.evictionGraceMs) break;
      if (!lease.used) {
        unusedPastGrace = lease;
        break;
      }
      usedPastGrace ??= lease;
    }
    const candidate = unusedPastGrace ?? usedPastGrace ?? oldestIdle;
    if (!candidate) return false;
    const idleSeconds = Math.max(
      0,
      Math.round((now - candidate.lastActive) / 1000)
    );
    candidate.evict();
    this.onEvict?.({
      used: candidate.used,
      idleSeconds,
      sessions: this.leases.size,
    });
    return true;
  }
}

interface LeaseHooks {
  readonly remove: () => void;
  readonly bump: () => void;
  readonly now: () => number;
}

export class HttpSessionLease {
  private timer?: ReturnType<typeof setTimeout>;
  private activePosts = 0;
  private released = false;
  private hasDoneWork = false;
  private lastActiveAt: number;

  constructor(
    private readonly idleTimeoutFor: (used: boolean) => number,
    private readonly close: () => Promise<void>,
    private readonly hooks: LeaseHooks
  ) {
    this.lastActiveAt = hooks.now();
  }

  /** Whether the session has made a tool call (or other real work). */
  get used(): boolean {
    return this.hasDoneWork;
  }

  /** No request of this session is being served right now. */
  get idle(): boolean {
    return !this.released && this.activePosts === 0;
  }

  get lastActive(): number {
    return this.lastActiveAt;
  }

  /** Record real work; the session keeps the long idle expiry from now on. */
  markUsed(): void {
    this.hasDoneWork = true;
  }

  touch(): void {
    clearTimeout(this.timer);
    if (this.released) return;
    this.lastActiveAt = this.hooks.now();
    this.hooks.bump();
    if (this.activePosts > 0) return;
    this.timer = setTimeout(
      () => this.evict(),
      this.idleTimeoutFor(this.hasDoneWork)
    );
    this.timer.unref();
  }

  /** A POST response may outlive handleRequest; keep its tool call alive. */
  beginPost(): () => void {
    this.activePosts++;
    clearTimeout(this.timer);
    if (!this.released) {
      this.lastActiveAt = this.hooks.now();
      this.hooks.bump();
    }
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.activePosts--;
      this.touch();
    };
  }

  /** Free the slot and close the session (idle expiry or capacity eviction). */
  evict(): void {
    // Release the slot before closing; onclose also releases idempotently.
    this.release();
    void this.close().catch(() => undefined);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    clearTimeout(this.timer);
    this.hooks.remove();
  }
}
