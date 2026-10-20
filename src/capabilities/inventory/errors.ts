/**
 * Inventory error mapping.
 *
 * The V1 inventory endpoints answer failures with the `{success:false,
 * meta:{message}}` body, the V2 product endpoints with JSON:API `errors`.
 * Both are normalized here into typed errors whose messages name the next
 * action in canonical vocabulary; the upstream wording is quoted after our own
 * sentence as data, never spliced into it (ADR-001 D8).
 */
import { AltegioApiError } from '../../utils/errors.js';
import { mapHttpFailure, type FailureHints } from '../../api/http-failure.js';

/** Bad or impossible input, refused before or by the API. */
export class InventoryInputError extends AltegioApiError {
  constructor(message: string) {
    super(message, 422);
    this.name = 'InventoryInputError';
  }
}

/** The signed-in user has no such right at the location. */
export class InventoryAccessError extends AltegioApiError {
  constructor(message: string) {
    super(message, 403);
    this.name = 'InventoryAccessError';
  }
}

/** The location, product, inventory, document or appointment does not exist. */
export class InventoryNotFoundError extends AltegioApiError {
  constructor(message: string) {
    super(message, 404);
    this.name = 'InventoryNotFoundError';
  }
}

export type InventoryErrorHints = FailureHints;

const FORBIDDEN =
  'The user needs the Inventory access rights at this location (ask the location owner); locations_diagnose_access shows what the user can do.';

/** Map an HTTP failure from an inventory or product endpoint to a typed error. */
export function mapInventoryHttpError(
  status: number,
  body: unknown,
  context: string,
  hints: InventoryErrorHints = {}
): AltegioApiError {
  return mapHttpFailure(
    status,
    body,
    context,
    {
      input: InventoryInputError,
      access: InventoryAccessError,
      notFound: InventoryNotFoundError,
    },
    {
      service: 'inventory',
      forbidden: FORBIDDEN,
      notFound:
        'Check the location id with locations_list and the other ids with the inventory tools.',
      alsoInvalid: [409],
    },
    hints
  );
}
