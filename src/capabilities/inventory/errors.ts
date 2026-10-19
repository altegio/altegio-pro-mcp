/**
 * Inventory error mapping.
 *
 * The V1 inventory endpoints answer failures with the `{success:false,
 * meta:{message}}` body, the V2 product endpoints with JSON:API `errors`.
 * Both are normalized here into typed errors whose messages name the next
 * action in canonical vocabulary; the upstream wording is quoted after our own
 * sentence as data, never spliced into it (ADR-001 D8).
 */
import { AltegioApiError, AuthenticationError } from '../../utils/errors.js';
import { upstreamDetail } from '../../tools/tool-result.js';
import { backendMessage } from '../events/errors.js';

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

export interface InventoryErrorHints {
  /** Extra next step for a 400/422. */
  invalid?: string;
  /** Extra next step for a 403. */
  forbidden?: string;
  /** Extra next step for a 404. */
  notFound?: string;
}

const FORBIDDEN =
  'The user needs the Inventory access rights at this location (ask the location owner); locations_diagnose_access shows what the user can do.';

/** The API's message plus its field errors (`meta.errors`), when present. */
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

/** Map an HTTP failure from an inventory or product endpoint to a typed error. */
export function mapInventoryHttpError(
  status: number,
  body: unknown,
  context: string,
  hints: InventoryErrorHints = {}
): AltegioApiError {
  const detail = upstreamDetail(apiMessage(body));
  const quoted = detail ? ` ${detail}` : '';
  if (status === 401) {
    return new AuthenticationError(
      `Session expired while trying to ${context}. Call auth_login to re-authenticate.`
    );
  }
  if (status === 403) {
    return new InventoryAccessError(
      `The signed-in user may not ${context}. ${hints.forbidden ?? FORBIDDEN}${quoted}`
    );
  }
  if (status === 404) {
    return new InventoryNotFoundError(
      `Not found while trying to ${context}. ${hints.notFound ?? 'Check the location id with locations_list and the other ids with the inventory tools.'}${quoted}`
    );
  }
  if (status === 400 || status === 409 || status === 422) {
    return new InventoryInputError(
      `The API refused to ${context}. ${hints.invalid ?? 'Check the values and retry.'}${quoted}`
    );
  }
  if (status >= 500) {
    return new AltegioApiError(
      `The inventory service is temporarily unavailable while trying to ${context} (HTTP ${status}). Retry in a moment.`,
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
