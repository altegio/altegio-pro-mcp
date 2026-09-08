/**
 * Request plumbing shared by the v1 clients adapter.
 *
 * The client endpoints answer with the `{success, data, meta}` envelope. `meta`
 * carries the counts the segmentation search needs (`total_count`) and the date
 * paginator the visit-history search needs (`from`, `to`), so it is returned
 * alongside `data`. Every failure is normalized by `mapClientsHttpError`.
 *
 * The transport already sends `Accept: application/vnd.api.v2+json`, which is
 * what these endpoints require, so only `Content-Type` is added for POST bodies.
 */
import { requireUserToken, type AltegioHttp } from '../altegio-http.js';
import { mapClientsHttpError } from '../../capabilities/clients/errors.js';

export interface CallOptions {
  /** Verb phrase for error messages, e.g. `search the client base`. */
  context: string;
  method?: 'GET' | 'POST';
  /** JSON request body for the POST search endpoints. */
  body?: unknown;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** Perform one client request and return the parsed JSON payload. */
export async function callClients(
  http: AltegioHttp,
  path: string,
  options: CallOptions
): Promise<unknown> {
  requireUserToken(http, options.context);

  const headers: Record<string, string> = {};
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
    throw mapClientsHttpError(
      response.status,
      await safeJson(response),
      options.context
    );
  }

  return safeJson(response);
}

/** Read an enveloped response, returning `data` and `meta`. */
export async function callEnveloped<T = unknown>(
  http: AltegioHttp,
  path: string,
  options: CallOptions
): Promise<{ data: T; meta: Record<string, unknown> }> {
  const payload = await callClients(http, path, options);
  if (!payload || typeof payload !== 'object') {
    throw mapClientsHttpError(502, payload, options.context);
  }
  const envelope = payload as {
    success?: boolean;
    data?: unknown;
    meta?: unknown;
  };
  if (envelope.success === false) {
    throw mapClientsHttpError(422, payload, options.context);
  }
  const meta =
    envelope.meta && typeof envelope.meta === 'object'
      ? (envelope.meta as Record<string, unknown>)
      : {};
  return { data: (envelope.data ?? null) as T, meta };
}
