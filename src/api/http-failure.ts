/**
 * One mapping from an HTTP failure to a typed error (ADR-001 D8).
 *
 * The finance, visit, inventory, events and memberships adapters answer a
 * failed call the same way: a sentence of ours naming the next action, with
 * the API's own wording quoted after it as data, never spliced into it. Each
 * domain brings its error classes and the next steps that fit it; the status
 * rules, the quoting and the sign-in wording live here once.
 *
 * The sign-in wording depends on the connection. Where the running view
 * serves password login (stdio, or a deployment that exposes it) the caller
 * signs in with `auth_login`. Every other HTTP view is signed in by the app
 * that opened the connection, so the text sends the user there instead of to
 * a tool the view does not have.
 */
import { AltegioApiError, AuthenticationError } from '../utils/errors.js';
import { upstreamDetail } from '../tools/tool-result.js';
import { servesPasswordLogin } from '../tools/serving-view.js';

/** The first human-readable message in a V1 or JSON:API error body. */
export function backendMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const meta = (body as { meta?: { message?: unknown } }).meta;
  if (typeof meta?.message === 'string' && meta.message) return meta.message;
  const errors = (body as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    const parts = errors
      .map((error) => {
        if (!error || typeof error !== 'object') return undefined;
        const { detail, title } = error as {
          detail?: unknown;
          title?: unknown;
        };
        if (typeof detail === 'string' && detail) return detail;
        return typeof title === 'string' && title ? title : undefined;
      })
      .filter((part): part is string => part !== undefined);
    if (parts.length > 0) return parts.join('; ');
  }
  return undefined;
}

/**
 * The API's message plus its field errors. A validation failure may answer
 * with a generic message ("An error occurred") and put the cause in
 * `meta.errors`, keyed by field (`{"[is_archived]": ["…invalid"]}`).
 */
export function apiMessage(body: unknown): string | undefined {
  const message = backendMessage(body);
  const errors = (body as { meta?: { errors?: unknown } } | undefined)?.meta
    ?.errors;
  if (!errors || typeof errors !== 'object') return message;
  const fields = Object.entries(errors as Record<string, unknown>)
    .map(([field, value]) => {
      const text = Array.isArray(value) ? value.join('; ') : String(value);
      return `${field.replace(/^\[|\]$/g, '')}: ${text}`;
    })
    .join('; ');
  if (!fields) return message;
  return message ? `${message} (${fields})` : fields;
}

/** The Altegio session of this connection ran out during `context`. */
export function sessionExpired(context: string): AuthenticationError {
  return new AuthenticationError(
    servesPasswordLogin()
      ? `Session expired while trying to ${context}. Call auth_login to re-authenticate.`
      : `The Altegio sign-in of this connection expired while trying to ${context}. Sign in again in your MCP client (reconnect Altegio in the app this connection runs in), then retry.`
  );
}

/** This connection has no Altegio session (to `action` with). */
export function notSignedIn(action?: string): AuthenticationError {
  return new AuthenticationError(
    servesPasswordLogin()
      ? `Not authenticated. Call auth_login ${action ? `before trying to ${action}` : 'first'}.`
      : `This connection has no Altegio sign-in${action ? ` to ${action}` : ''}. Sign in in your MCP client (connect Altegio in the app this connection runs in), then retry.`
  );
}

/** The error classes a domain throws for each kind of failure. */
export interface FailureClasses {
  input: new (message: string) => AltegioApiError;
  access: new (message: string) => AltegioApiError;
  notFound: new (message: string) => AltegioApiError;
}

/** A domain's wording for the failures it maps. */
export interface FailureWording {
  /** `finance` in "The finance service is temporarily unavailable". */
  service: string;
  /** Next step after a 403. */
  forbidden: string;
  /** Next step after a 404. */
  notFound: string;
  /** Statuses refused as bad input, besides 400 and 422. */
  alsoInvalid?: readonly number[];
}

/**
 * What a caller does about HTTP 429, which the client already waited out and
 * retried once (`AltegioClient.apiRequest`): pause, then send requests one at
 * a time. Agents that repeated the call at once kept failing — 2,456 calls
 * from three batch sessions in October 2026.
 */
export function rateLimitedMessage(
  context: string,
  retryAfterSeconds?: number
): string {
  const wait =
    retryAfterSeconds !== undefined && retryAfterSeconds > 0
      ? `${retryAfterSeconds} second${retryAfterSeconds === 1 ? '' : 's'}`
      : 'a few seconds';
  return (
    `Altegio is limiting the request rate while trying to ${context} (HTTP 429). ` +
    `Wait ${wait} before the next request, and send requests one at a time rather than in parallel.`
  );
}

/** Next steps a single call names instead of the domain's own. */
export interface FailureHints {
  /** Extra next step for a refused input. */
  invalid?: string;
  /** Extra next step for a 403. */
  forbidden?: string;
  /** Extra next step for a 404. */
  notFound?: string;
}

/** Map an HTTP failure to an actionable typed error of the domain. */
export function mapHttpFailure(
  status: number,
  body: unknown,
  context: string,
  classes: FailureClasses,
  wording: FailureWording,
  hints: FailureHints = {}
): AltegioApiError {
  const detail = upstreamDetail(apiMessage(body));
  const quoted = detail ? ` ${detail}` : '';
  if (status === 401) return sessionExpired(context);
  if (status === 403) {
    return new classes.access(
      `The signed-in user may not ${context}. ${hints.forbidden ?? wording.forbidden}${quoted}`
    );
  }
  if (status === 404) {
    return new classes.notFound(
      `Not found while trying to ${context}. ${hints.notFound ?? wording.notFound}${quoted}`
    );
  }
  if (
    status === 400 ||
    status === 422 ||
    wording.alsoInvalid?.includes(status)
  ) {
    return new classes.input(
      `The API refused to ${context}. ${hints.invalid ?? 'Check the values and retry.'}${quoted}`
    );
  }
  if (status === 429) {
    return new AltegioApiError(
      `${rateLimitedMessage(context)}${quoted}`,
      status,
      body
    );
  }
  if (status >= 500) {
    return new AltegioApiError(
      `The ${wording.service} service is temporarily unavailable while trying to ${context} (HTTP ${status}). Retry in a moment.`,
      status,
      body
    );
  }
  return new AltegioApiError(
    `Could not ${context} (HTTP ${status}).${quoted}`,
    status,
    body
  );
}
