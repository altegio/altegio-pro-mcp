/**
 * Events error mapping.
 *
 * The event endpoints answer failures either with the legacy
 * `{success:false, meta:{message}}` body or with a JSON:API `errors` array.
 * Both are normalized here into typed errors whose messages name the next
 * action in canonical vocabulary; the upstream wording is quoted after our own
 * sentence as data, never spliced into it (ADR-001 D8).
 */
import { AltegioApiError, AuthenticationError } from '../../utils/errors.js';
import { upstreamDetail } from '../../tools/tool-result.js';

/** Bad or impossible input, refused before or by the API. */
export class EventsInputError extends AltegioApiError {
  constructor(message: string) {
    super(message, 422);
    this.name = 'EventsInputError';
  }
}

/** The team member or a resource is busy at that time. */
export class EventsConflictError extends AltegioApiError {
  constructor(message: string) {
    super(message, 409);
    this.name = 'EventsConflictError';
  }
}

/** The signed-in user may not do this in the location. */
export class EventsAccessError extends AltegioApiError {
  constructor(message: string) {
    super(message, 403);
    this.name = 'EventsAccessError';
  }
}

/** The location, event, strategy or appointment does not exist. */
export class EventsNotFoundError extends AltegioApiError {
  constructor(message: string) {
    super(message, 404);
    this.name = 'EventsNotFoundError';
  }
}

/** The first human-readable message in either error body shape. */
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

export interface EventsErrorHints {
  /** Extra next step for a 400/422, e.g. the period rule. */
  invalid?: string;
  /** Extra next step for a 404. */
  notFound?: string;
}

/** Map an HTTP failure from an event endpoint to an actionable typed error. */
export function mapEventsHttpError(
  status: number,
  body: unknown,
  context: string,
  hints: EventsErrorHints = {}
): AltegioApiError {
  const detail = upstreamDetail(backendMessage(body));
  const quoted = detail ? ` ${detail}` : '';
  if (status === 401) {
    return new AuthenticationError(
      `Session expired while trying to ${context}. Call auth_login to re-authenticate.`
    );
  }
  if (status === 403) {
    return new EventsAccessError(
      `The signed-in user may not ${context} in this location. Ask a location owner for access to group events, or call locations_list to pick a location the user can work with.${quoted}`
    );
  }
  if (status === 404) {
    return new EventsNotFoundError(
      `Not found while trying to ${context}. ${hints.notFound ?? 'Check the location id with locations_list and the event id with events_list.'}${quoted}`
    );
  }
  if (status === 409) {
    return new EventsConflictError(
      `Could not ${context}: the team member or a resource is busy at that time. Pick another time, team member or resource, or pass force: true to keep the event despite the overlap.${quoted}`
    );
  }
  if (status === 400 || status === 422) {
    return new EventsInputError(
      `The API refused to ${context}. ${hints.invalid ?? 'Check the values and retry.'}${quoted}`
    );
  }
  if (status >= 500) {
    return new AltegioApiError(
      `The events service is temporarily unavailable while trying to ${context} (HTTP ${status}). Retry in a moment.`,
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
