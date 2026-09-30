/**
 * Memberships error mapping.
 *
 * The membership endpoints answer failures with the V1 `{success:false,
 * meta:{message}}` body. Failures are normalized here into typed errors whose
 * messages name the next action in canonical vocabulary; the upstream wording
 * is quoted after our own sentence as data, never spliced into it (ADR-001 D8).
 *
 * A 403 is the common failure: membership types and sold memberships belong to
 * a chain, and the chain grants its own rights. A location a user manages can
 * belong to several chains, and its main chain is not necessarily one the user
 * has rights in — so the refusal points at `memberships_list_chains`.
 */
import { AltegioApiError, AuthenticationError } from '../../utils/errors.js';
import { upstreamDetail } from '../../tools/tool-result.js';
import { backendMessage } from '../events/errors.js';

/** Bad or impossible input, refused before or by the API. */
export class MembershipsInputError extends AltegioApiError {
  constructor(message: string) {
    super(message, 422);
    this.name = 'MembershipsInputError';
  }
}

/** The signed-in user has no such right in the chain or location. */
export class MembershipsAccessError extends AltegioApiError {
  constructor(message: string) {
    super(message, 403);
    this.name = 'MembershipsAccessError';
  }
}

/** The chain, location, client, membership type or membership does not exist. */
export class MembershipsNotFoundError extends AltegioApiError {
  constructor(message: string) {
    super(message, 404);
    this.name = 'MembershipsNotFoundError';
  }
}

export interface MembershipsErrorHints {
  /** Extra next step for a 400/422. */
  invalid?: string;
  /** Extra next step for a 403. */
  forbidden?: string;
  /** Extra next step for a 404. */
  notFound?: string;
}

const CHAIN_FORBIDDEN =
  'Call memberships_list_chains to see the chains the user belongs to and the membership rights in each, then use a chain where the right is granted, or ask the chain owner for it.';

/**
 * The API's message plus its field errors. A validation failure answers with
 * the generic "An error occurred" and puts the cause in `meta.errors`, keyed
 * by field (`{"[is_archived]": ["The value you selected is invalid"]}`).
 */
function apiMessage(body: unknown): string | undefined {
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

/** Map an HTTP failure from a membership endpoint to an actionable typed error. */
export function mapMembershipsHttpError(
  status: number,
  body: unknown,
  context: string,
  hints: MembershipsErrorHints = {}
): AltegioApiError {
  const detail = upstreamDetail(apiMessage(body));
  const quoted = detail ? ` ${detail}` : '';
  if (status === 401) {
    return new AuthenticationError(
      `Session expired while trying to ${context}. Call auth_login to re-authenticate.`
    );
  }
  if (status === 403) {
    return new MembershipsAccessError(
      `The signed-in user may not ${context}. ${hints.forbidden ?? CHAIN_FORBIDDEN}${quoted}`
    );
  }
  if (status === 404) {
    return new MembershipsNotFoundError(
      `Not found while trying to ${context}. ${hints.notFound ?? 'Check the chain id with memberships_list_chains and the membership type id with memberships_list_types.'}${quoted}`
    );
  }
  if (status === 400 || status === 409 || status === 422) {
    return new MembershipsInputError(
      `The API refused to ${context}. ${hints.invalid ?? 'Check the values and retry.'}${quoted}`
    );
  }
  if (status >= 500) {
    return new AltegioApiError(
      `The memberships service is temporarily unavailable while trying to ${context} (HTTP ${status}). Retry in a moment.`,
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
