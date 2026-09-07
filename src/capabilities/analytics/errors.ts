/**
 * Analytics error mapping.
 *
 * The v1 analytics surface reports the same problem — "this user may not read
 * analytics here" — as 403, as 401 (the chart endpoints) and as 404 (the report
 * builder). Feature flags and licence gates add more 403/404 cases. Raw backend
 * messages also speak the legacy dialect ("No rights to view the statistics").
 *
 * Everything is normalized here into a small set of typed errors whose messages
 * name the next action and use canonical vocabulary only. They extend
 * `AltegioApiError`, so the tool factory's error wrapper passes the message
 * through unchanged.
 */
import { AltegioApiError } from '../../utils/errors.js';

/** Bad or impossible tool input (range too long, missing period, unknown field). */
export class AnalyticsInputError extends AltegioApiError {
  constructor(message: string) {
    super(message, 422);
    this.name = 'AnalyticsInputError';
  }
}

/** The user may not read analytics in this location. */
export class AnalyticsAccessError extends AltegioApiError {
  constructor(message: string, statusCode = 403) {
    super(message, statusCode);
    this.name = 'AnalyticsAccessError';
  }
}

/** The feature exists but is switched off for this location. */
export class AnalyticsUnavailableError extends AltegioApiError {
  constructor(message: string, statusCode = 404) {
    super(message, statusCode);
    this.name = 'AnalyticsUnavailableError';
  }
}

/** Which family of endpoints produced the failure — decides how to read 404. */
export type AnalyticsEndpointKind =
  | 'metrics'
  | 'charts'
  | 'receptionist'
  | 'forecast'
  | 'occupancy'
  | 'day_end_report'
  | 'client_visits'
  | 'report_builder'
  | 'loyalty';

const NO_ACCESS =
  'The signed-in user has no Analytics access right in this location. ' +
  'Ask a location owner to grant the Analytics access right, or call list_locations to pick a location the user can report on.';

const NO_DAY_END_ACCESS =
  'The signed-in user has no Analytics access right for the day-end report in this location. ' +
  'The day-end report needs the finance reporting right; ask a location owner to grant it.';

const NO_OCCUPANCY_ACCESS =
  'The signed-in user cannot read the work schedule of this location, which occupancy is calculated from. ' +
  'Ask a location owner to grant access to the work schedule.';

const NO_CLIENT_ACCESS =
  'The signed-in user cannot read client cards in this location, which per-client visit counts come from. ' +
  'Ask a location owner to grant access to clients.';

const FORECAST_OFF =
  'The revenue and visits forecast is not enabled for this location. ' +
  'It is an optional module; ask Altegio support to switch it on, or use analytics_get_overview and analytics_get_daily_series for actuals.';

const BUILDER_OFF =
  'The report builder is unavailable for this location: it needs an active subscription and the Analytics access right. ' +
  'Use analytics_get_overview, analytics_get_daily_series or analytics_get_day_end_report instead.';

function accessMessage(kind: AnalyticsEndpointKind): string {
  switch (kind) {
    case 'day_end_report':
      return NO_DAY_END_ACCESS;
    case 'occupancy':
      return NO_OCCUPANCY_ACCESS;
    case 'client_visits':
      return NO_CLIENT_ACCESS;
    case 'forecast':
      return `${NO_ACCESS} If the right is already granted, the forecast module itself may be switched off for this location.`;
    default:
      return NO_ACCESS;
  }
}

/** Pull the backend's own message out of an enveloped error body. */
function backendMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const meta = (body as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const message = (meta as { message?: unknown }).message;
  return typeof message === 'string' ? message : undefined;
}

/** Flatten `meta.errors` (`{"[date_to]": ["…"]}`) into one readable line. */
function backendFieldErrors(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const meta = (body as { meta?: unknown }).meta;
  if (!meta || typeof meta !== 'object') return undefined;
  const errors = (meta as { errors?: unknown }).errors;
  if (!errors || typeof errors !== 'object') return undefined;
  const parts: string[] = [];
  for (const [field, messages] of Object.entries(
    errors as Record<string, unknown>
  )) {
    const cleaned = field.replace(/^\[|\]$/g, '');
    const text = Array.isArray(messages)
      ? messages.join('; ')
      : String(messages);
    parts.push(`${cleaned}: ${text}`);
  }
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

/**
 * Map an HTTP failure from an analytics endpoint to an actionable error.
 *
 * `kind` matters because the report builder answers a missing access right with
 * 404 rather than 403, and because the chart endpoints answer it with 401 —
 * which must not be mistaken for an expired session.
 */
export function mapAnalyticsHttpError(
  status: number,
  body: unknown,
  kind: AnalyticsEndpointKind,
  context: string
): AltegioApiError {
  if (status === 401 || status === 403) {
    if (kind === 'forecast' && status === 403) {
      return new AnalyticsUnavailableError(FORECAST_OFF, status);
    }
    return new AnalyticsAccessError(accessMessage(kind), status);
  }

  if (status === 404) {
    if (kind === 'report_builder') {
      return new AnalyticsUnavailableError(BUILDER_OFF, status);
    }
    if (kind === 'forecast') {
      return new AnalyticsUnavailableError(FORECAST_OFF, status);
    }
    return new AnalyticsUnavailableError(
      `${context} is not available for this location. Verify the location id with list_locations.`,
      status
    );
  }

  if (status === 422 || status === 400) {
    const fields = backendFieldErrors(body);
    if (fields && /maximum interval|date range/i.test(fields)) {
      return new AnalyticsInputError(
        'The requested period is longer than the 365 days analytics accepts. Narrow the range and retry.'
      );
    }
    return new AnalyticsInputError(
      `${context} was rejected: ${fields ?? backendMessage(body) ?? 'invalid arguments'}. Check the dates and ids and retry.`
    );
  }

  if (status === 429) {
    return new AltegioApiError(
      `Analytics is rate limited right now. Wait a few seconds, then retry ${context} — or ask for a shorter period so fewer calls are needed.`,
      429,
      body
    );
  }

  if (status >= 500) {
    return new AltegioApiError(
      `Analytics is temporarily unavailable while trying to ${context} (HTTP ${status}). Retry in a moment; if it keeps failing, narrow the period.`,
      status,
      body
    );
  }

  return new AltegioApiError(
    `Could not ${context} (HTTP ${status}).`,
    status,
    body
  );
}
