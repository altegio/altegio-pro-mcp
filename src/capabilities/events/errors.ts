/**
 * Events error mapping.
 *
 * The event endpoints answer failures either with the legacy
 * `{success:false, meta:{message}}` body or with a JSON:API `errors` array.
 * Both are normalized here into typed errors whose messages name the next
 * action in canonical vocabulary; the upstream wording is quoted after our own
 * sentence as data, never spliced into it (ADR-001 D8).
 */
import { AltegioApiError } from '../../utils/errors.js';
import { upstreamDetail } from '../../tools/tool-result.js';
import {
  apiMessage,
  mapHttpFailure,
  type FailureHints,
} from '../../api/http-failure.js';

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

export { backendMessage } from '../../api/http-failure.js';

/** Events name no next step of their own for a 403. */
export type EventsErrorHints = Omit<FailureHints, 'forbidden'>;

/** Map an HTTP failure from an event endpoint to an actionable typed error. */
export function mapEventsHttpError(
  status: number,
  body: unknown,
  context: string,
  hints: EventsErrorHints = {}
): AltegioApiError {
  if (status === 409) {
    const detail = upstreamDetail(apiMessage(body));
    return new EventsConflictError(
      `Could not ${context}: the team member or a resource is busy at that time. Pick another time, team member or resource, or pass force: true to keep the event despite the overlap.${detail ? ` ${detail}` : ''}`
    );
  }
  return mapHttpFailure(
    status,
    body,
    context,
    {
      input: EventsInputError,
      access: EventsAccessError,
      notFound: EventsNotFoundError,
    },
    {
      service: 'events',
      forbidden:
        'Ask a location owner for access to group events in this location, or call locations_list to pick a location the user can work with.',
      notFound:
        'Check the location id with locations_list and the event id with events_list.',
    },
    { ...hints, forbidden: undefined }
  );
}
