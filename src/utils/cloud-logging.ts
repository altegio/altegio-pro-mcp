import { randomUUID } from 'node:crypto';

const METADATA = 'http://metadata.google.internal/computeMetadata/v1/';
const WRITE_URL = 'https://logging.googleapis.com/v2/entries:write';

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

/** One bounded, shared destination for hosted Pino logs. Never blocks requests. */
export class CloudLoggingDestination {
  private queue: PendingEntry[] = [];
  private inFlight: PendingEntry[] = [];
  private pending?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private metadata?: Metadata;
  private token?: { value: string; expiresAt: number };
  private retryAt = 0;

  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly fallback: (line: string) => void = (line) => {
      process.stderr.write(line);
    },
    private readonly capacity = 256
  ) {}

  write(line: string): void {
    if (this.queue.length >= this.capacity || line.length > 64 * 1024) {
      this.fallback(line);
      return;
    }
    try {
      const payload = JSON.parse(line) as Record<string, unknown>;
      const severity = String(payload.severity || 'DEFAULT');
      this.queue.push({
        line,
        entry: {
          insertId: randomUUID(),
          severity,
          timestamp: new Date(Number(payload.time) || Date.now()).toISOString(),
          jsonPayload: payload,
        },
      });
    } catch {
      this.fallback(line);
      return;
    }
    if (!this.timer && !this.pending) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.drain();
      }, 200);
      this.timer.unref();
    }
  }

  private async getMetadata(path: string): Promise<Response> {
    const response = await this.fetcher(`${METADATA}${path}`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error('Metadata unavailable');
    return response;
  }

  private async credentials(): Promise<{ metadata: Metadata; token: string }> {
    if (!this.metadata) {
      const [project, instance, zone] = await Promise.all(
        ['project/project-id', 'instance/id', 'instance/zone'].map(
          async (path) => (await this.getMetadata(path)).text()
        )
      );
      if (!project || !instance || !zone) throw new Error('Missing metadata');
      this.metadata = { project, instance, zone: zone.split('/').at(-1)! };
    }
    if (!this.token || this.token.expiresAt <= Date.now()) {
      const response = await this.getMetadata(
        'instance/service-accounts/default/token'
      );
      const token = (await response.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (!token.access_token || !token.expires_in) {
        throw new Error('Missing metadata token');
      }
      this.token = {
        value: token.access_token,
        expiresAt: Date.now() + Math.max(0, token.expires_in - 60) * 1000,
      };
    }
    return { metadata: this.metadata, token: this.token.value };
  }

  private drain(): Promise<void> {
    if (this.pending) return this.pending;
    this.pending = this.send().finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }

  private async send(): Promise<void> {
    while (this.queue.length) {
      const batch = this.queue.splice(0, 20);
      this.inFlight = batch;
      try {
        if (Date.now() < this.retryAt) throw new Error('Logging cooldown');
        const { metadata, token } = await this.credentials();
        const response = await this.fetcher(WRITE_URL, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(3000),
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
        if (response.status === 401) this.token = undefined;
        if (!response.ok) throw new Error('Cloud Logging write failed');
      } catch {
        if (Date.now() >= this.retryAt) this.retryAt = Date.now() + 30_000;
        for (const item of batch) this.writeFallback(item);
      } finally {
        this.inFlight = [];
      }
    }
  }

  private writeFallback(item: PendingEntry): void {
    if (!item.fallbackWritten) {
      item.fallbackWritten = true;
      this.fallback(item.line);
    }
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
