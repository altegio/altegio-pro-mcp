/**
 * Gift card error mapping.
 *
 * The gift card endpoints answer failures with the V1 `{success:false,
 * meta:{message}}` body. They are normalized here into typed errors whose
 * messages name the next action in canonical vocabulary; the upstream wording
 * is quoted after our own sentence as data, never spliced into it (ADR-001 D8).
 * Chain-level reads and writes need the chain's loyalty rights; the location
 * search and a client's gift cards need loyalty access in the location.
 */
import { AltegioApiError } from '../../utils/errors.js';
import { mapHttpFailure, type FailureHints } from '../../api/http-failure.js';

export class GiftCardsInputError extends AltegioApiError {
  constructor(message: string) {
    super(message, 422);
    this.name = 'GiftCardsInputError';
  }
}

export class GiftCardsAccessError extends AltegioApiError {
  constructor(message: string) {
    super(message, 403);
    this.name = 'GiftCardsAccessError';
  }
}

export class GiftCardsNotFoundError extends AltegioApiError {
  constructor(message: string) {
    super(message, 404);
    this.name = 'GiftCardsNotFoundError';
  }
}

export type GiftCardsErrorHints = FailureHints;

const FORBIDDEN =
  'Gift card types belong to a chain: call memberships_list_chains to see the user’s chains and loyalty rights, use a chain where they are granted, or ask the chain owner. In one location, gift_cards_list_location_types needs only loyalty access there.';

/** Map an HTTP failure from a gift card endpoint to an actionable typed error. */
export function mapGiftCardsHttpError(
  status: number,
  body: unknown,
  context: string,
  hints: GiftCardsErrorHints = {}
): AltegioApiError {
  return mapHttpFailure(
    status,
    body,
    context,
    {
      input: GiftCardsInputError,
      access: GiftCardsAccessError,
      notFound: GiftCardsNotFoundError,
    },
    {
      service: 'gift cards',
      forbidden: FORBIDDEN,
      notFound:
        'Check the chain id with memberships_list_chains and the gift card type id with gift_cards_list_types.',
      alsoInvalid: [409],
    },
    hints
  );
}
