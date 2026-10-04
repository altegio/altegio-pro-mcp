/** Bound retained HTTP servers across all views, including abandoned sessions. */
export class HttpSessionBudget {
  private readonly leases = new Set<HttpSessionLease>();

  constructor(
    private readonly maxSessions = 128,
    private readonly idleTimeoutMs = 30 * 60 * 1000
  ) {}

  acquire(close: () => Promise<void>): HttpSessionLease | undefined {
    if (this.leases.size >= this.maxSessions) return undefined;
    const lease = new HttpSessionLease(this.idleTimeoutMs, close, () => {
      this.leases.delete(lease);
    });
    this.leases.add(lease);
    lease.touch();
    return lease;
  }
}

export class HttpSessionLease {
  private timer?: ReturnType<typeof setTimeout>;
  private activePosts = 0;
  private released = false;

  constructor(
    private readonly idleTimeoutMs: number,
    private readonly close: () => Promise<void>,
    private readonly remove: () => void
  ) {}

  touch(): void {
    clearTimeout(this.timer);
    if (this.released || this.activePosts > 0) return;
    this.timer = setTimeout(() => {
      // Release the slot before closing; onclose also releases idempotently.
      this.release();
      void this.close().catch(() => undefined);
    }, this.idleTimeoutMs);
    this.timer.unref();
  }

  /** A POST response may outlive handleRequest; keep its tool call alive. */
  beginPost(): () => void {
    this.activePosts++;
    clearTimeout(this.timer);
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.activePosts--;
      this.touch();
    };
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    clearTimeout(this.timer);
    this.remove();
  }
}
