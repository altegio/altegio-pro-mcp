/**
 * Finance error mapping.
 *
 * The finance endpoints answer failures with the V1 `{success:false,
 * meta:{message}}` body. Failures are normalized here into typed errors whose
 * messages name the next action in canonical vocabulary; the upstream wording
 * is quoted after our own sentence as data, never spliced into it (ADR-001 D8).
 *
 * A 403 is the common failure: finances, payroll and client accounts each have
 * their own right in the user's access settings, and a user may also be limited
 * to some accounts and cash registers or to recent days.
 */
import { AltegioApiError, AuthenticationError } from '../../utils/errors.js';
import { upstreamDetail } from '../../tools/tool-result.js';
import { backendMessage } from '../events/errors.js';

/** Bad or impossible input, refused before or by the API. */
export class FinanceInputError extends AltegioApiError {
  constructor(message: string) {
    super(message, 422);
    this.name = 'FinanceInputError';
  }
}

/** The signed-in user has no such right at the location. */
export class FinanceAccessError extends AltegioApiError {
  constructor(message: string) {
    super(message, 403);
    this.name = 'FinanceAccessError';
  }
}

/** The appointment, payment, transaction or client account does not exist. */
export class FinanceNotFoundError extends AltegioApiError {
  constructor(message: string) {
    super(message, 404);
    this.name = 'FinanceNotFoundError';
  }
}

export interface FinanceErrorHints {
  /** Extra next step for a 400/409/416/422. */
  invalid?: string;
  /** Extra next step for a 403. */
  forbidden?: string;
  /** Extra next step for a 404. */
  notFound?: string;
}

const FORBIDDEN =
  'Ask the location owner to grant the right in the user’s access settings (Finances, Payroll or Client accounts), or call locations_diagnose_access to see what the user may do.';

/**
 * The API's message plus its field errors. A validation failure may answer
 * with a generic message and put the cause in `meta.errors`, keyed by field.
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

/** Map an HTTP failure from a finance endpoint to an actionable typed error. */
export function mapFinanceHttpError(
  status: number,
  body: unknown,
  context: string,
  hints: FinanceErrorHints = {}
): AltegioApiError {
  const detail = upstreamDetail(apiMessage(body));
  const quoted = detail ? ` ${detail}` : '';
  if (status === 401) {
    return new AuthenticationError(
      `Session expired while trying to ${context}. Call auth_login to re-authenticate.`
    );
  }
  if (status === 403) {
    return new FinanceAccessError(
      `The signed-in user may not ${context}. ${hints.forbidden ?? FORBIDDEN}${quoted}`
    );
  }
  if (status === 404) {
    return new FinanceNotFoundError(
      `Not found while trying to ${context}. ${hints.notFound ?? 'Check the ids and the location_id (locations_list).'}${quoted}`
    );
  }
  if (status === 400 || status === 409 || status === 416 || status === 422) {
    return new FinanceInputError(
      `The API refused to ${context}. ${hints.invalid ?? 'Check the values and retry.'}${quoted}`
    );
  }
  if (status >= 500) {
    return new AltegioApiError(
      `The finance service is temporarily unavailable while trying to ${context} (HTTP ${status}). Retry in a moment.`,
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
