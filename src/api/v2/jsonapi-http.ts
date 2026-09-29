/**
 * Request plumbing for the JSON:API endpoints under `/api/v2`.
 *
 * The transport behind `AltegioHttp` is bound to the `/api/v1` base and already
 * sends `Accept: application/vnd.api.v2+json`; `v2Path` reaches the sibling
 * tree. This module adds what a write needs — the method, a JSON body,
 * repeated query keys (`include[]`, `filter[master_ids][]`) — and reads the
 * `{data, included, meta}` document back. Failures go through the caller's
 * error mapper, so each capability keeps its own next-action wording.
 */
import { requireUserToken, v2Path, type AltegioHttp } from '../altegio-http.js';
import type { AltegioApiError } from '../../utils/errors.js';

export type JsonApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** One resource object. Some V2 side-loads carry `type: null`. */
export interface JsonApiResource {
  type: string | null;
  id: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data?: unknown }>;
}

export interface JsonApiDocument {
  data: JsonApiResource | JsonApiResource[] | null;
  included: JsonApiResource[];
  meta: Record<string, unknown>;
}

/** A query value; arrays are sent as repeated keys. */
export type QueryValue =
  string | number | boolean | readonly (string | number)[] | undefined | null;

export interface JsonApiCall {
  /** Verb phrase for error messages, e.g. `list the events`. */
  context: string;
  method?: JsonApiMethod;
  query?: Record<string, QueryValue>;
  body?: unknown;
  mapError: (status: number, body: unknown, context: string) => AltegioApiError;
}

/** Render a query with repeated keys and bracketed names, skipping empty values. */
export function renderQuery(query: Record<string, QueryValue> = {}): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      parts.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`
      );
    }
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asResource(value: unknown): JsonApiResource | null {
  if (!isRecord(value) || value.id === undefined || value.id === null) {
    return null;
  }
  return {
    type: typeof value.type === 'string' ? value.type : null,
    id: String(value.id),
    ...(isRecord(value.attributes) ? { attributes: value.attributes } : {}),
    ...(isRecord(value.relationships)
      ? {
          relationships: value.relationships as Record<
            string,
            { data?: unknown }
          >,
        }
      : {}),
  };
}

/**
 * Perform one request below `/api/v2` and return the parsed document, or
 * `null` for an empty success (204).
 */
export async function callJsonApi(
  http: AltegioHttp,
  path: string,
  call: JsonApiCall
): Promise<JsonApiDocument | null> {
  requireUserToken(http, call.context);
  const method = call.method ?? 'GET';
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (call.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(call.body);
  }

  const response = await http.request(
    `${v2Path(path)}${renderQuery(call.query)}`,
    { method, headers, ...(body !== undefined ? { body } : {}) }
  );
  const payload = await readJson(response);
  if (!response.ok) {
    throw call.mapError(response.status, payload, call.context);
  }
  if (payload === undefined) return null;
  if (!isRecord(payload) || !('data' in payload)) {
    throw call.mapError(502, payload, call.context);
  }
  if (payload.success === false) {
    throw call.mapError(422, payload, call.context);
  }

  const data = Array.isArray(payload.data)
    ? payload.data
        .map(asResource)
        .filter((r): r is JsonApiResource => r !== null)
    : asResource(payload.data);
  const included = Array.isArray(payload.included)
    ? payload.included
        .map(asResource)
        .filter((r): r is JsonApiResource => r !== null)
    : [];
  // An empty `meta` arrives as `[]`; it carries nothing.
  const meta = isRecord(payload.meta) ? payload.meta : {};
  return { data, included, meta };
}

/** Side-loaded resources, looked up by type and id. */
export class IncludedIndex {
  private readonly byKey = new Map<string, JsonApiResource>();
  private readonly byId = new Map<string, JsonApiResource>();

  constructor(included: readonly JsonApiResource[]) {
    for (const resource of included) {
      this.byKey.set(`${resource.type ?? ''}:${resource.id}`, resource);
      if (!this.byId.has(resource.id)) this.byId.set(resource.id, resource);
    }
  }

  /** Exact lookup; an untyped reference falls back to the first id match. */
  get(type: string | null, id: string): JsonApiResource | undefined {
    return (
      this.byKey.get(`${type ?? ''}:${id}`) ??
      (type === null ? this.byId.get(id) : undefined)
    );
  }
}

/** The `{type, id}` references of one relationship, to-one or to-many. */
export function relationshipRefs(
  resource: JsonApiResource,
  name: string
): Array<{ type: string | null; id: string }> {
  const data = resource.relationships?.[name]?.data;
  const refs = Array.isArray(data) ? data : data ? [data] : [];
  return refs
    .filter(isRecord)
    .filter((ref) => ref.id !== undefined && ref.id !== null)
    .map((ref) => ({
      type: typeof ref.type === 'string' ? ref.type : null,
      id: String(ref.id),
    }));
}

/** The document's primary data as a list. */
export function primaryList(doc: JsonApiDocument | null): JsonApiResource[] {
  if (!doc?.data) return [];
  return Array.isArray(doc.data) ? doc.data : [doc.data];
}

/** The document's primary data as one resource. */
export function primaryOne(
  doc: JsonApiDocument | null
): JsonApiResource | null {
  if (!doc?.data) return null;
  return Array.isArray(doc.data) ? (doc.data[0] ?? null) : doc.data;
}
