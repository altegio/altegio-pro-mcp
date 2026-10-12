import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const METADATA = 'http://metadata.google.internal/computeMetadata/v1/';
const WRITE_URL = 'https://logging.googleapis.com/v2/entries:write';

/** Hard bound on one metadata step, body included. */
const METADATA_TIMEOUT_MS = 5000;
/**
 * A write's deadline grows with its body: a base for the connection and the
 * API, plus a second per 16 KiB, capped. Production timed out at a flat 5 s
 * on batches of up to twenty entries.
 */
const WRITE_TIMEOUT_BASE_MS = 5000;
const WRITE_TIMEOUT_PER_16_KIB_MS = 1000;
const WRITE_TIMEOUT_MAX_MS = 15_000;
/** Entries and serialized bytes per write. One oversized entry still goes alone. */
const BATCH_MAX_ENTRIES = 10;
const BATCH_MAX_BYTES = 64 * 1024;
/** A failed attempt that may succeed on a fresh connection is retried once, after this. */
const RETRY_BASE_MS = 250;
const RETRY_JITTER_MS = 500;
/**
 * After a batch fails twice, entries go straight to the fallback for a while:
 * 5 s, doubling with every further consecutive failure, at most a minute.
 * A flat 30 s after every failure sent most of production's fallback volume
 * to stderr.
 */
const COOLDOWN_BASE_MS = 5000;
const COOLDOWN_MAX_MS = 60_000;
/** At most one write-failure diagnostic per this interval. */
const DIAGNOSTIC_INTERVAL_MS = 60_000;
/** At most one note per this interval that retries recovered writes. */
const RECOVERY_REPORT_INTERVAL_MS = 10 * 60_000;
/**
 * Idle keep-alive sockets close after this, well under the idle timeouts of
 * the Google front end and the VPC connection tracking, so a reused socket is
 * never one the network already dropped.
 */
const KEEP_ALIVE_IDLE_MS = 30_000;

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

/** What the destination needs of an HTTP response. */
export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

/** What the destination needs of an HTTP client; `fetch` satisfies it. */
export type Fetcher = (
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  }
) => Promise<FetchResponse>;

const agents = {
  'http:': new http.Agent({
    keepAlive: true,
    maxSockets: 2,
    timeout: KEEP_ALIVE_IDLE_MS,
  }),
  'https:': new https.Agent({
    keepAlive: true,
    maxSockets: 2,
    timeout: KEEP_ALIVE_IDLE_MS,
    scheduling: 'lifo',
  }),
};

/**
 * A request over this module's own keep-alive sockets: the writer reuses one
 * warm TLS connection instead of resolving and connecting for most batches,
 * and an aborted request takes its socket with it, so a retry starts fresh.
 */
export const keepAliveFetch: Fetcher = (url, init) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'http:' ? http : https;
    const request = transport.request(
      target,
      {
        method: init.method ?? 'GET',
        headers: {
          ...init.headers,
          ...(init.body !== undefined
            ? { 'Content-Length': String(Buffer.byteLength(init.body)) }
            : {}),
        },
        agent: target.protocol === 'http:' ? agents['http:'] : agents['https:'],
        signal: init.signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => body,
          });
        });
      }
    );
    request.on('error', reject);
    request.end(init.body);
  });

/** Why a step did not land, as the diagnostic reports it. */
class WriteFailure extends Error {
  constructor(
    readonly stage: 'metadata' | 'token' | 'write',
    readonly httpStatus?: number,
    readonly reason?: string
  ) {
    super(`Cloud Logging ${stage} failed`);
    this.name = 'WriteFailure';
  }

  /** A timeout, a dropped connection or a transient status: worth one retry. */
  get retryable(): boolean {
    const status = this.httpStatus;
    if (status === undefined) return true;
    return status === 401 || status === 408 || status === 429 || status >= 500;
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

/** A thrown value as a `WriteFailure` of `stage`, keeping only its name. */
function asFailure(error: unknown, stage: WriteFailure['stage']): WriteFailure {
  if (error instanceof WriteFailure) return error;
  const name = error instanceof Error ? error.name : 'unknown';
  return new WriteFailure(stage, undefined, name.slice(0, 64));
}

/** The deadline for a write of `bytes`. */
export function writeTimeoutMs(bytes: number): number {
  return Math.min(
    WRITE_TIMEOUT_MAX_MS,
    WRITE_TIMEOUT_BASE_MS +
      Math.ceil(bytes / (16 * 1024)) * WRITE_TIMEOUT_PER_16_KIB_MS
  );
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
  timeoutMs: number,
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
    }, timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([step(controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

export interface CloudLoggingOptions {
  /** Delay before the one retry of a failed attempt. */
  retryDelayMs?: () => number;
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
  private consecutiveFailures = 0;
  private lastDiagnosticAt = Number.NEGATIVE_INFINITY;
  private failuresSinceDiagnostic = 0;
  private fallbackSinceDiagnostic = 0;
  private lastRecoveryReportAt = Number.NEGATIVE_INFINITY;
  private recoveredSinceReport = 0;
  private readonly retryDelayMs: () => number;

  constructor(
    private readonly fetcher: Fetcher = keepAliveFetch,
    private readonly fallback: (line: string) => void = (line) => {
      process.stderr.write(line);
    },
    private readonly capacity = 256,
    private readonly now: () => number = Date.now,
    options: CloudLoggingOptions = {}
  ) {
    this.retryDelayMs =
      options.retryDelayMs ??
      (() => RETRY_BASE_MS + Math.random() * RETRY_JITTER_MS);
  }

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
    const stage = path.endsWith('/token') ? 'token' : 'metadata';
    try {
      return await withDeadline(METADATA_TIMEOUT_MS, async (signal) => {
        const response = await this.fetcher(`${METADATA}${path}`, {
          headers: { 'Metadata-Flavor': 'Google' },
          signal,
        });
        const body = await response.text();
        if (!response.ok) throw new WriteFailure(stage, response.status);
        return body;
      });
    } catch (error) {
      throw asFailure(error, stage);
    }
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

  /** The next batch: at most ten entries and 64 KiB, at least one entry. */
  private nextBatch(): PendingEntry[] {
    let count = 0;
    let bytes = 0;
    while (count < this.queue.length && count < BATCH_MAX_ENTRIES) {
      const size = this.queue[count]!.line.length;
      if (count > 0 && bytes + size > BATCH_MAX_BYTES) break;
      bytes += size;
      count += 1;
    }
    return this.queue.splice(0, count);
  }

  /** One write of `batch`; throws a `WriteFailure` naming its stage. */
  private async attempt(batch: PendingEntry[]): Promise<void> {
    const { metadata, token } = await this.credentials();
    const body = JSON.stringify({
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
    });
    try {
      await withDeadline(
        writeTimeoutMs(Buffer.byteLength(body)),
        async (signal) => {
          const response = await this.fetcher(WRITE_URL, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            signal,
            body,
          });
          // Read the whole response so the socket goes back to the pool.
          const text = await response.text();
          if (response.status === 401) this.token = undefined;
          if (!response.ok) {
            throw new WriteFailure('write', response.status, apiReason(text));
          }
        }
      );
    } catch (error) {
      throw asFailure(error, 'write');
    }
  }

  private async send(): Promise<void> {
    while (this.queue.length) {
      const batch = this.nextBatch();
      this.inFlight = batch;
      try {
        if (this.now() < this.retryAt) {
          for (const item of batch) this.writeFallback(item);
          continue;
        }
        try {
          await this.attempt(batch);
        } catch (error) {
          const failure = asFailure(error, 'write');
          if (!failure.retryable) throw failure;
          // Entries carry their insertId, so a write that landed but timed
          // out is deduplicated by the API, not stored twice.
          await sleep(this.retryDelayMs());
          await this.attempt(batch);
          this.noteRecovered();
        }
        this.consecutiveFailures = 0;
      } catch (error) {
        this.consecutiveFailures += 1;
        this.retryAt =
          this.now() +
          Math.min(
            COOLDOWN_MAX_MS,
            COOLDOWN_BASE_MS * 2 ** (this.consecutiveFailures - 1)
          );
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

  /** One diagnostic line on the fallback stream, which the log driver ships. */
  private report(fields: Record<string, unknown>, msg: string): void {
    this.fallback(
      `${JSON.stringify({
        severity: 'WARNING',
        time: this.now(),
        service: 'altegio-pro-mcp',
        name: 'cloud-logging',
        ...fields,
        msg,
      })}\n`
    );
  }

  /**
   * Say, at most every ten minutes, how many writes a retry rescued — the
   * measure of how often the first attempt fails.
   */
  private noteRecovered(): void {
    this.recoveredSinceReport += 1;
    const at = this.now();
    if (at - this.lastRecoveryReportAt < RECOVERY_REPORT_INTERVAL_MS) return;
    this.lastRecoveryReportAt = at;
    this.report(
      {
        event: 'cloud_logging_write_recovered',
        recovered: this.recoveredSinceReport,
      },
      'Direct Cloud Logging writes succeeded on retry'
    );
    this.recoveredSinceReport = 0;
  }

  /**
   * Say why the direct writer is failing, at most once a minute, on the
   * fallback stream (which the container log driver still ships). Stage,
   * status, API reason code and counts only.
   */
  private diagnose(error: unknown): void {
    this.failuresSinceDiagnostic += 1;
    const at = this.now();
    if (at - this.lastDiagnosticAt < DIAGNOSTIC_INTERVAL_MS) return;
    this.lastDiagnosticAt = at;
    const failure = asFailure(error, 'write');
    this.report(
      {
        event: 'cloud_logging_write_failed',
        stage: failure.stage,
        ...(failure.httpStatus ? { http_status: failure.httpStatus } : {}),
        reason: failure.reason ?? 'unknown',
        failures: this.failuresSinceDiagnostic,
        entries_to_fallback: this.fallbackSinceDiagnostic,
        cooldown_ms: Math.max(0, this.retryAt - at),
      },
      'Direct Cloud Logging write failed; entries go to stderr'
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
