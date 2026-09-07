/**
 * Result projection and the per-result size budget (ADR-001 D8).
 *
 * Every executor result passes through here, so a `GET` on a busy location can
 * never dump a hundred kilobytes of API payload into the model's context. Two
 * mechanisms, in order: the overlay's `projection` allowlist keeps only the
 * fields a caller needs, then the budget truncates whatever is still too big
 * and says how to ask for less.
 */

/**
 * Serialized-character budget for one tool result. ~4 characters per JSON token
 * puts this at roughly 3.5k tokens, inside the ≤ 4k target of D8.
 */
export const RESULT_BUDGET_CHARS = 14000;

/** What to tell the model when a result had to be cut. */
export const NARROW_HINT =
  'Result truncated to stay inside the size budget. Narrow the query — ' +
  'add a date range, a smaller `count`/`page`, or a more specific id — ' +
  'or use the curated tool for this domain, which projects the fields that matter.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serializedSize(value: unknown): number {
  try {
    return JSON.stringify(value ?? null)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

/**
 * An overlay projection path addresses the payload, so the `data[].` /  `data.`
 * prefix that documents "each item of the list response" is dropped here — by
 * the time we project, the envelope is already unwrapped.
 */
function normalizePath(path: string): string[] {
  return path
    .replace(/^data\[\]\.?/, '')
    .replace(/^data\./, '')
    .split('.')
    .filter((segment) => segment.length > 0);
}

function assignPath(
  out: Record<string, unknown>,
  source: Record<string, unknown>,
  segments: string[]
): void {
  const [head, ...rest] = segments;
  if (head === undefined || !(head in source)) return;

  const value = source[head];
  if (rest.length === 0) {
    out[head] = value;
    return;
  }

  if (Array.isArray(value)) {
    const existing = Array.isArray(out[head])
      ? (out[head] as unknown[])
      : value.map(() => ({}));
    value.forEach((item, i) => {
      const target = existing[i];
      if (isRecord(item) && isRecord(target)) assignPath(target, item, rest);
    });
    out[head] = existing;
    return;
  }

  if (isRecord(value)) {
    const nested = isRecord(out[head]) ? out[head] : {};
    assignPath(nested, value, rest);
    out[head] = nested;
  }
}

/**
 * Keep only the allowlisted fields (ADR-001 D8: a projection of the API object,
 * never the raw payload). Applies per item for a list payload.
 */
export function applyProjection(payload: unknown, paths: string[]): unknown {
  const normalized = paths.map(normalizePath).filter((p) => p.length > 0);
  if (normalized.length === 0) return payload;

  if (Array.isArray(payload)) {
    return payload.map((item) => applyProjection(item, paths));
  }
  if (!isRecord(payload)) return payload;

  const out: Record<string, unknown> = {};
  for (const segments of normalized) assignPath(out, payload, segments);
  return out;
}

// ---------------------------------------------------------------------------
// Size budget
// ---------------------------------------------------------------------------

export interface BudgetResult {
  value: unknown;
  truncated: boolean;
  /** Items kept, for a list payload. */
  returned?: number;
  /** Items the API returned, for a list payload. */
  total?: number;
  /** Object fields dropped to make the payload fit. */
  omittedFields?: string[];
}

/** Keep as many leading items as fit the budget (at least one). */
function truncateArray(items: unknown[], budget: number): BudgetResult {
  let kept = items.length;
  while (kept > 1 && serializedSize(items.slice(0, kept)) > budget) {
    // Halve first, then walk back up: linear shrinking on a 5k-item list is
    // thousands of serializations.
    kept = kept > 8 ? Math.floor(kept / 2) : kept - 1;
  }
  while (
    kept < items.length &&
    serializedSize(items.slice(0, kept + 1)) <= budget
  ) {
    kept += 1;
  }

  return {
    value: items.slice(0, kept),
    truncated: kept < items.length,
    returned: kept,
    total: items.length,
  };
}

/** Drop the heaviest fields until the object fits, reporting what went. */
function pruneObject(
  obj: Record<string, unknown>,
  budget: number
): BudgetResult {
  const remaining = { ...obj };
  const omitted: string[] = [];
  // Heaviest first, then by name so the outcome is deterministic.
  const bySize = Object.keys(remaining).sort((a, b) => {
    const diff = serializedSize(remaining[b]) - serializedSize(remaining[a]);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  for (const key of bySize) {
    if (serializedSize(remaining) <= budget) break;
    delete remaining[key];
    omitted.push(key);
  }

  return {
    value: remaining,
    truncated: omitted.length > 0,
    ...(omitted.length > 0 ? { omittedFields: omitted } : {}),
  };
}

/**
 * Force a payload inside `budget` characters: lists lose trailing items,
 * objects lose their heaviest fields. Callers surface `truncated` plus
 * `NARROW_HINT` so the model knows the result is partial and what to do.
 */
export function enforceBudget(
  payload: unknown,
  budget: number = RESULT_BUDGET_CHARS
): BudgetResult {
  if (serializedSize(payload) <= budget) {
    return {
      value: payload,
      truncated: false,
      ...(Array.isArray(payload)
        ? { returned: payload.length, total: payload.length }
        : {}),
    };
  }

  if (Array.isArray(payload)) {
    const result = truncateArray(payload, budget);
    // A single item can still be over budget; prune it like any object.
    if (serializedSize(result.value) > budget) {
      const items = result.value as unknown[];
      const first = items[0];
      if (isRecord(first)) {
        const pruned = pruneObject(first, budget);
        return {
          value: [pruned.value],
          truncated: true,
          returned: 1,
          total: payload.length,
          ...(pruned.omittedFields
            ? { omittedFields: pruned.omittedFields }
            : {}),
        };
      }
    }
    return result;
  }

  if (isRecord(payload)) return pruneObject(payload, budget);

  // A scalar over budget can only be a huge string.
  return {
    value:
      typeof payload === 'string' ? payload.slice(0, budget) : String(payload),
    truncated: true,
  };
}
