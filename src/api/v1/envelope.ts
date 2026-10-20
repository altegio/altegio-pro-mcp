/**
 * One V1 request and the readers for its loosely typed values.
 *
 * V1 answers `{success, data, meta}`, and some refusals arrive as HTTP 200
 * with `success: false`. `v1Call` sends a request, reads the envelope and
 * turns a failure into the typed error of the calling domain (`mapError`),
 * so the finance, visit, inventory and memberships adapters share one request
 * path. The readers are those the finance and visit adapters share: V1 sends
 * numbers as numbers or numeric strings, and 0 for "no id".
 */
import { queryString, type AltegioHttp } from '../altegio-http.js';
import type { AltegioApiError } from '../../utils/errors.js';

export type Row = Record<string, unknown>;
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | undefined | null;

export function asRow(value: unknown): Row {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {};
}

export function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.map(asRow) : [];
}

export function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** A positive id, or null for 0, empty and missing (V1 writes 0 for "none"). */
export function id(value: unknown): number | null {
  const n = num(value);
  return n !== null && Number.isInteger(n) && n > 0 ? n : null;
}

export function text(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}

export function flag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const n = num(value);
  return n === null ? null : n !== 0;
}

export async function safeJson(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** A domain's mapping from a failed status to its typed error. */
export type FailureMapper<H> = (
  status: number,
  body: unknown,
  context: string,
  hints?: H
) => AltegioApiError;

export interface V1CallOptions<H> {
  method?: Method;
  query?: Record<string, QueryValue>;
  body?: unknown;
  hints?: H;
  /** Statuses answered with `null` instead of an error. */
  tolerate?: readonly number[];
}

export interface V1Envelope {
  data: unknown;
  meta: Row;
}

/**
 * Send one V1 request. A missing session is refused before anything is sent;
 * a failed status, or `success: false`, becomes `mapError`'s typed error.
 */
export async function v1Call<H>(
  http: AltegioHttp,
  path: string,
  context: string,
  mapError: FailureMapper<H>,
  options: V1CallOptions<H> = {}
): Promise<V1Envelope | null> {
  if (!http.isAuthenticated()) {
    throw mapError(401, undefined, context);
  }
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await http.request(
    `${path}${options.query ? queryString(options.query) : ''}`,
    {
      method: options.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {}),
    }
  );
  const payload = await safeJson(response);
  if (options.tolerate?.includes(response.status)) return null;
  if (!response.ok) {
    throw mapError(response.status, payload, context, options.hints);
  }
  const envelope = asRow(payload);
  if (envelope.success === false) {
    throw mapError(422, payload, context, options.hints);
  }
  return { data: envelope.data ?? null, meta: asRow(envelope.meta) };
}

/** `v1Call` where a tolerated status reads as no data. */
export async function v1Read<H>(
  http: AltegioHttp,
  path: string,
  context: string,
  mapError: FailureMapper<H>,
  options: V1CallOptions<H> = {}
): Promise<V1Envelope> {
  return (
    (await v1Call(http, path, context, mapError, options)) ?? {
      data: null,
      meta: {},
    }
  );
}
