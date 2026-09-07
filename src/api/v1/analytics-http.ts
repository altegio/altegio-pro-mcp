/**
 * Request plumbing shared by the v1 analytics adapters.
 *
 * Two response conventions coexist on the v1 analytics surface:
 *  - most endpoints answer with the `{success, data, meta}` envelope, and
 *  - the daily/pie chart endpoints answer with a **raw array**, no envelope.
 *
 * Both are read here, and every failure is normalized by
 * `mapAnalyticsHttpError` so no backend message in the legacy dialect reaches
 * the agent. `Accept-Language: en` is always sent: several series carry only a
 * localized label, and the English wording is what the vocabulary module maps
 * to canonical keys.
 */
import {
  requireUserToken,
  type AltegioHttp,
} from '../altegio-http.js';
import {
  mapAnalyticsHttpError,
  type AnalyticsEndpointKind,
} from '../../capabilities/analytics/errors.js';

/** Language the label-only series must come back in. */
export const ANALYTICS_ACCEPT_LANGUAGE = 'en';

export interface CallOptions {
  /** Which endpoint family this is — decides how a 404 is read. */
  kind: AnalyticsEndpointKind;
  /** Verb phrase for error messages, e.g. `read key metrics`. */
  context: string;
  method?: 'GET' | 'POST';
  /** JSON request body, for the report builder's POST endpoints. */
  body?: unknown;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Perform one analytics request and return the parsed JSON payload. */
export async function callAnalytics(
  http: AltegioHttp,
  path: string,
  options: CallOptions
): Promise<unknown> {
  requireUserToken(http, options.context);

  const headers: Record<string, string> = {
    'Accept-Language': ANALYTICS_ACCEPT_LANGUAGE,
  };
  let payload: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(options.body);
  }

  const response = await http.request(path, {
    method: options.method ?? 'GET',
    headers,
    ...(payload !== undefined ? { body: payload } : {}),
  });

  if (!response.ok) {
    throw mapAnalyticsHttpError(
      response.status,
      await safeJson(response),
      options.kind,
      options.context
    );
  }

  return safeJson(response);
}

/**
 * Read an enveloped response, returning `data`.
 * A `success: false` envelope is treated as a failure of the same kind.
 */
export async function callEnveloped<T = unknown>(
  http: AltegioHttp,
  path: string,
  options: CallOptions
): Promise<T> {
  const payload = await callAnalytics(http, path, options);
  if (!payload || typeof payload !== 'object') {
    throw mapAnalyticsHttpError(502, payload, options.kind, options.context);
  }
  const envelope = payload as { success?: boolean; data?: unknown };
  if (envelope.success === false) {
    throw mapAnalyticsHttpError(422, payload, options.kind, options.context);
  }
  return (envelope.data ?? {}) as T;
}

/** Read a raw-array response (the chart endpoints). */
export async function callRawArray<T = unknown>(
  http: AltegioHttp,
  path: string,
  options: CallOptions
): Promise<T[]> {
  const payload = await callAnalytics(http, path, options);
  if (Array.isArray(payload)) return payload as T[];
  // A few charts were observed wrapped after all; accept both shapes.
  if (payload && typeof payload === 'object') {
    const data = (payload as { data?: unknown }).data;
    if (Array.isArray(data)) return data as T[];
  }
  return [];
}
