import { randomUUID } from 'node:crypto';

const METADATA = 'http://metadata.google.internal/computeMetadata/v1/';
const WRITE_URL = 'https://logging.googleapis.com/v2/entries:write';

/** Hard bound on one network step, body included. */
const STEP_TIMEOUT_MS = 5000;
/** After a failed write, entries go straight to the fallback for this long. */
const COOLDOWN_MS = 30_000;
/** At most one write-failure diagnostic per this interval. */
const DIAGNOSTIC_INTERVAL_MS = 60_000;

interface Entry {
  insertId: string;
  severity: string;
  timestamp: string;
  jsonPayload: Record<string, unknown>;
}

interface Metadata {
  project: string;
  instance: string;
  zone: string;
}

interface PendingEntry {
  entry: Entry;
  line: string;
  fallbackWritten?: boolean;
}

/** Why a write did not land, as the diagnostic reports it. */
class WriteFailure extends Error {
  constructor(
    readonly stage: 'metadata' | 'token' | 'write',
    readonly httpStatus?: number,
    readonly reason?: string
  ) {
    super(`Cloud Logging ${stage} failed`);
    this.name = 'WriteFailure';
  }
}

/** An API error status such as `PERMISSION_DENIED`; nothing free-form. */
function apiReason(body: string): string | undefined {
  try {
    const status = (JSON.parse(body) as { error?: { status?: unknown } }).error
      ?.status;
    return typeof status === 'string' && /^[A-Z_]{1,64}$/.test(status)
      ? status
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run one network step under a deadline this module owns.
 *
 * `AbortSignal.timeout()` alone is not enough: its timer is held weakly, so a
 * signal nothing else references can be collected and never fire, and a
 * stalled socket then leaves the step pending forever. Production showed
 * exactly that: the direct log stopped mid-burst and never resumed while every
 * later line went to the fallback. The race below settles on a referenced
 * timer whatever the request does, and aborts the request it gave up on.
 */
async function withDeadline<T>(
  step: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error('Cloud Logging step timed out');
      error.name = 'TimeoutError';
      controller.abort(error);
      reject(error);
    }, STEP_TIMEOUT_MS);
    timer.unref();
  });
  try {
    return await Promise.race([step(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** One bounded, shared destination for hosted Pino logs. Never blocks requests. */
export class CloudLoggingDestination {
  private queue: PendingEntry[] = [];
  private inFlight: PendingEntry[] = [];
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private metadata?: Metadata;
  private token?: { value: string; expiresAt: number };
  private retryAt = 0;
  private lastDiagnosticAt = Number.NEGATIVE_INFINITY;
  private failuresSinceDiagnostic = 0;
  private fallbackSinceDiagnostic = 0;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly fallback: (line: string) => void = (line) => {
      process.stderr.write(line);
    },
    private readonly capacity = 256,
    private readonly now: () => number = Date.now
  ) {}

  write(line: string): void {
    if (this.queue.length >= this.capacity || line.length > 64 * 1024) {
      this.fallback(line);
    } else {
      try {
        const payload = JSON.parse(line) as Record<string, unknown>;
        const severity = String(payload.severity || 'DEFAULT');
        this.queue.push({
          line,
          entry: {
            insertId: randomUUID(),
            severity,
            timestamp: new Date(
              Number(payload.time) || this.now()
            ).toISOString(),
            jsonPayload: payload,
          },
        });
      } catch {
        this.fallback(line);
      }
    }
    // Schedule even when this line overflowed: a full queue must drain, or
    // every later line would bypass the destination for good.
    if (this.queue.length > 0 && !this.timer && !this.pending) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.drain();
      }, 200);
      this.timer.unref();
    }
  }

  private async getMetadata(path: string): Promise<string> {
    return withDeadline(async (signal) => {
      const response = await this.fetcher(`${METADATA}${path}`, {
        headers: { 'Metadata-Flavor': 'Google' },
        signal,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new WriteFailure(
          path.endsWith('/token') ? 'token' : 'metadata',
          response.status
        );
      }
      return body;
    });
  }

  private async credentials(): Promise<{ metadata: Metadata; token: string }> {
    if (!this.metadata) {
      const [project, instance, zone] = await Promise.all(
        ['project/project-id', 'instance/id', 'instance/zone'].map((path) =>
          this.getMetadata(path)
        )
      );
      if (!project || !instance || !zone) {
        throw new WriteFailure('metadata', undefined, 'MISSING_METADATA');
      }
      this.metadata = { project, instance, zone: zone.split('/').at(-1)! };
    }
    if (!this.token || this.token.expiresAt <= this.now()) {
      const body = await this.getMetadata(
        'instance/service-accounts/default/token'
      );
      let token: { access_token?: string; expires_in?: number } = {};
      try {
        token = JSON.parse(body) as typeof token;
      } catch {
        // Reported as a missing token below.
      }
      if (!token.access_token || !token.expires_in) {
        throw new WriteFailure('token', undefined, 'MISSING_TOKEN');
      }
      this.token = {
        value: token.access_token,
        expiresAt: this.now() + Math.max(0, token.expires_in - 60) * 1000,
      };
    }
    return { metadata: this.metadata, token: this.token.value };
  }

  private drain(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.send().finally(() => {
      this.pending = undefined;
      // Lines queued while the last batch was in flight start the next drain.
      if (this.queue.length > 0 && !this.timer) void this.drain();
    });
    return this.pending;
  }

  private async send(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue.splice(0, 20);
      this.inFlight = batch;
      try {
        if (this.now() < this.retryAt) {
          for (const item of batch) this.writeFallback(item);
          continue;
        }
        const { metadata, token } = await this.credentials();
        await withDeadline(async (signal) => {
          const response = await this.fetcher(WRITE_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            signal,
            body: JSON.stringify({
              logName: `projects/${metadata.project}/logs/altegio-pro-mcp`,
              resource: {
                type: 'gce_instance',
                labels: {
                  project_id: metadata.project,
                  instance_id: metadata.instance,
                  zone: metadata.zone,
                },
              },
              entries: batch.map(({ entry }) => entry),
            }),
          });
          // Consume the native API response so Undici can reuse the socket.
          const body = await response.text();
          if (response.status === 401) this.token = undefined;
          if (!response.ok) {
            throw new WriteFailure('write', response.status, apiReason(body));
          }
        });
      } catch (error) {
        this.retryAt = this.now() + COOLDOWN_MS;
        for (const item of batch) this.writeFallback(item);
        this.diagnose(error);
      } finally {
        this.inFlight = [];
      }
    }
  }

  private writeFallback(item: PendingEntry): void {
    if (!item.fallbackWritten) {
      item.fallbackWritten = true;
      this.fallbackSinceDiagnostic += 1;
      this.fallback(item.line);
    }
  }

  /**
   * Say why the direct writer is failing, at most once a minute, on the
   * fallback stream (which the container log driver still ships). Status,
   * API reason code and counts only.
   */
  private diagnose(error: unknown): void {
    this.failuresSinceDiagnostic += 1;
    const at = this.now();
    if (at - this.lastDiagnosticAt < DIAGNOSTIC_INTERVAL_MS) return;
    this.lastDiagnosticAt = at;
    const failure = error instanceof WriteFailure ? error : undefined;
    this.fallback(
      `${JSON.stringify({
        severity: 'WARNING',
        time: at,
        service: 'altegio-pro-mcp',
        name: 'cloud-logging',
        event: 'cloud_logging_write_failed',
        stage: failure?.stage ?? 'write',
        ...(failure?.httpStatus ? { http_status: failure.httpStatus } : {}),
        reason:
          failure?.reason ??
          (error instanceof Error ? error.name : 'unknown').slice(0, 64),
        failures: this.failuresSinceDiagnostic,
        entries_to_fallback: this.fallbackSinceDiagnostic,
        msg: 'Direct Cloud Logging write failed; entries go to stderr',
      })}\n`
    );
    this.failuresSinceDiagnostic = 0;
    this.fallbackSinceDiagnostic = 0;
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.drain(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, 5000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    // Preserve queued entries even when the bounded shutdown wait expires.
    for (const item of [...this.inFlight, ...this.queue.splice(0)]) {
      this.writeFallback(item);
    }
  }
}
