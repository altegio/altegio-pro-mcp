/**
 * Clients error mapping.
 *
 * The v1 client surface reports access, licence and validation problems in the
 * enveloped `{success:false, meta:{message, errors}}` form. The segmentation
 * search is rate-limited and answers 400 with a `meta.errors.filters` array when
 * a filter value is wrong; an expired location licence answers 402. Everything
 * is normalized here into typed errors whose messages name the next action, in
 * canonical vocabulary.
 */
import { AltegioApiError, AuthenticationError } from '../../utils/errors.js';

/** Bad or impossible tool input. */
export class ClientsInputError extends AltegioApiError {
  constructor(message: string) {
    super(message, 422);
    this.name = 'ClientsInputError';
  }
}

/** The user may not read the client base in this location. */
export class ClientsAccessError extends AltegioApiError {
  constructor(message: string, statusCode = 403) {
    super(message, statusCode);
    this.name = 'ClientsAccessError';
  }
}

/** The feature exists but is unavailable for this location (licence, module). */
export class ClientsUnavailableError extends AltegioApiError {
  constructor(message: string, statusCode = 404) {
    super(message, statusCode);
    this.name = 'ClientsUnavailableError';
  }
}

const NO_ACCESS =
  'The signed-in user cannot read the client base in this location. ' +
  'Ask a location owner to grant access to clients, or call list_locations to pick a location the user can work with.';

function backendMessage(body: unknown): string | undefined {
  const meta = (body as { meta?: { message?: unknown } })?.meta;
  return typeof meta?.message === 'string' ? meta.message : undefined;
}

/** Flatten `meta.errors` into one readable line (the search reports `filters`). */
function backendFieldErrors(body: unknown): string | undefined {
  const errors = (body as { meta?: { errors?: unknown } })?.meta?.errors;
  if (!errors || typeof errors !== 'object') return undefined;
  const parts: string[] = [];
  for (const [field, messages] of Object.entries(
    errors as Record<string, unknown>
  )) {
    const cleaned = field.replace(/^\[|\]$/g, '');
    const text = Array.isArray(messages)
      ? messages.join('; ')
      : String(messages);
    parts.push(cleaned ? `${cleaned}: ${text}` : text);
  }
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

/** Map an HTTP failure from a client endpoint to an actionable typed error. */
export function mapClientsHttpError(
  status: number,
  body: unknown,
  context: string
): AltegioApiError {
  if (status === 401) {
    return new AuthenticationError(
      `Session expired while trying to ${context}. Call altegio_login to re-authenticate.`
    );
  }
  if (status === 403) {
    return new ClientsAccessError(NO_ACCESS, status);
  }
  if (status === 402) {
    return new ClientsUnavailableError(
      `The location licence is inactive, so ${context} is unavailable. Renew the subscription for this location and retry.`,
      402
    );
  }
  if (status === 404) {
    return new ClientsUnavailableError(
      `Not found while trying to ${context}. Verify the location id with list_locations and the client id with clients_search.`,
      404
    );
  }
  if (status === 400 || status === 422) {
    const fields = backendFieldErrors(body);
    return new ClientsInputError(
      `${context} was rejected: ${fields ?? backendMessage(body) ?? 'invalid arguments'}. Check the filter values and retry.`
    );
  }
  if (status === 429) {
    return new AltegioApiError(
      `The client search is rate limited right now. Wait a few seconds and retry ${context}.`,
      429,
      body
    );
  }
  if (status >= 500) {
    return new AltegioApiError(
      `The client service is temporarily unavailable while trying to ${context} (HTTP ${status}). Retry in a moment.`,
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
