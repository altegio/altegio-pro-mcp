/**
 * In-memory store for full report output behind a `resource_link`.
 *
 * A report table is capped at `REPORT_ROW_CAP` rows in the tool result so one
 * answer stays inside the context budget (ADR-001 D8). The complete table is
 * rendered to CSV once and kept here under a server-minted `run_id`; the tool
 * result carries a `resource_link` to `altegio://reports/{location_id}/{run_id}.csv`
 * which the host can read through the resource handler.
 *
 * Deliberate limitation: the store lives in the process. The HTTP deployment is
 * a single container today, so a link resolves for the session that created it;
 * it does not survive a restart and would not resolve across replicas. Entries
 * expire after `REPORT_CSV_TTL_MS` and the store is capped so a long-running
 * server cannot grow without bound.
 */

/** Rows returned inline in a tool result before truncation kicks in. */
export const REPORT_ROW_CAP = 200;

/** How long a rendered CSV stays resolvable. */
export const REPORT_CSV_TTL_MS = 30 * 60 * 1000;

/** Most CSVs kept at once; the oldest is dropped first. */
export const REPORT_STORE_CAPACITY = 32;

export interface StoredReport {
  readonly run_id: string;
  readonly location_id: number;
  readonly uri: string;
  readonly name: string;
  readonly csv: string;
  readonly row_count: number;
  readonly expires_at: number;
}

const store = new Map<string, StoredReport>();

function key(locationId: number, runId: string): string {
  return `${locationId}/${runId}`;
}

function prune(now: number): void {
  for (const [entryKey, entry] of store) {
    if (entry.expires_at <= now) store.delete(entryKey);
  }
  while (store.size > REPORT_STORE_CAPACITY) {
    const oldest = store.keys().next();
    if (oldest.done) break;
    store.delete(oldest.value);
  }
}

/** Build the resource URI for one stored run. */
export function reportUri(locationId: number, runId: string): string {
  return `altegio://reports/${locationId}/${runId}.csv`;
}

/** Mint a run id. Short, opaque, and unique enough for one process. */
export function newRunId(now: number = Date.now()): string {
  return `${now.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Store one rendered CSV and return its handle. */
export function putReportCsv(input: {
  location_id: number;
  name: string;
  csv: string;
  row_count: number;
  run_id?: string;
  now?: number;
}): StoredReport {
  const now = input.now ?? Date.now();
  const runId = input.run_id ?? newRunId(now);
  const entry: StoredReport = {
    run_id: runId,
    location_id: input.location_id,
    uri: reportUri(input.location_id, runId),
    name: input.name,
    csv: input.csv,
    row_count: input.row_count,
    expires_at: now + REPORT_CSV_TTL_MS,
  };
  store.set(key(input.location_id, runId), entry);
  prune(now);
  return entry;
}

/** Read one stored CSV, or `undefined` when it expired or never existed. */
export function getReportCsv(
  locationId: number,
  runId: string,
  now: number = Date.now()
): StoredReport | undefined {
  prune(now);
  const entry = store.get(key(locationId, runId));
  if (!entry) return undefined;
  if (entry.expires_at <= now) {
    store.delete(key(locationId, runId));
    return undefined;
  }
  return entry;
}

/** Parse `altegio://reports/{location_id}/{run_id}.csv`. */
export function parseReportUri(
  uri: string
): { location_id: number; run_id: string } | null {
  const match = /^altegio:\/\/reports\/(\d+)\/([A-Za-z0-9_-]+)\.csv$/.exec(uri);
  if (!match) return null;
  return { location_id: Number(match[1]), run_id: match[2]! };
}

/** Drop everything — used by tests. */
export function clearReportStore(): void {
  store.clear();
}
