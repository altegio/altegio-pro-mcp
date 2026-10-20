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
import { AltegioApiError } from '../../utils/errors.js';
import { mapHttpFailure, type FailureHints } from '../../api/http-failure.js';

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

export type FinanceErrorHints = FailureHints;

const FORBIDDEN =
  'Ask the location owner to grant the right in the user’s access settings (Finances, Payroll or Client accounts), or call locations_diagnose_access to see what the user may do.';

/** Map an HTTP failure from a finance or visit endpoint to a typed error. */
export function mapFinanceHttpError(
  status: number,
  body: unknown,
  context: string,
  hints: FinanceErrorHints = {}
): AltegioApiError {
  return mapHttpFailure(
    status,
    body,
    context,
    {
      input: FinanceInputError,
      access: FinanceAccessError,
      notFound: FinanceNotFoundError,
    },
    {
      service: 'finance',
      forbidden: FORBIDDEN,
      notFound: 'Check the ids and the location_id (locations_list).',
      alsoInvalid: [409, 416],
    },
    hints
  );
}
