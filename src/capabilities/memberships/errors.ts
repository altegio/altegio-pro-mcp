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
import { AltegioApiError } from '../../utils/errors.js';
import { mapHttpFailure, type FailureHints } from '../../api/http-failure.js';

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

export type MembershipsErrorHints = FailureHints;

const CHAIN_FORBIDDEN =
  'Call memberships_list_chains to see the chains the user belongs to and the membership rights in each, then use a chain where the right is granted, or ask the chain owner for it.';

/** Map an HTTP failure from a membership endpoint to an actionable typed error. */
export function mapMembershipsHttpError(
  status: number,
  body: unknown,
  context: string,
  hints: MembershipsErrorHints = {}
): AltegioApiError {
  return mapHttpFailure(
    status,
    body,
    context,
    {
      input: MembershipsInputError,
      access: MembershipsAccessError,
      notFound: MembershipsNotFoundError,
    },
    {
      service: 'memberships',
      forbidden: CHAIN_FORBIDDEN,
      notFound:
        'Check the chain id with memberships_list_chains and the membership type id with memberships_list_types.',
      alsoInvalid: [409],
    },
    hints
  );
}
