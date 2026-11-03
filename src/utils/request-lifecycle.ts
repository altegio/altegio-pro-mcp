import { AsyncLocalStorage } from 'node:async_hooks';

const requestSignal = new AsyncLocalStorage<AbortSignal>();
export const currentRequestSignal = (): AbortSignal | undefined =>
  requestSignal.getStore();

/** Counts admitted work independently of whether the client keeps its socket. */
export class RequestActivity {
  private count = 0;
  private accepting = true;
  private readonly idle = new Set<() => void>();
  private readonly shutdown = new AbortController();
  constructor(private readonly parent?: RequestActivity) {}

  begin(): () => void {
    this.count++;
    const finishParent = this.parent?.begin();
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      finishParent?.();
      if (--this.count === 0) for (const notify of this.idle) notify();
    };
  }

  async run<T>(
    signal: AbortSignal | undefined,
    fn: () => Promise<T>
  ): Promise<T> {
    if (!this.accepting)
      throw new DOMException('Server is draining', 'AbortError');
    const finish = this.begin();
    try {
      return await requestSignal.run(
        AbortSignal.any(
          signal ? [signal, this.shutdown.signal] : [this.shutdown.signal]
        ),
        fn
      );
    } finally {
      finish();
    }
  }

  async drain(timeoutMs: number): Promise<boolean> {
    if (this.count === 0) return true;
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.idle.delete(finish);
        resolve(true);
      };
      const timer = setTimeout(() => {
        this.idle.delete(finish);
        resolve(false);
      }, timeoutMs);
      this.idle.add(finish);
    });
  }

  stop(): void {
    this.accepting = false;
  }

  abort(): void {
    this.shutdown.abort(
      new DOMException('Server drain deadline exceeded', 'AbortError')
    );
  }
}
