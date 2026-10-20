/**
 * What every write method of a port accepts besides its payload.
 *
 * `idempotency_key` names one logical write across repeats. The use case
 * takes it from the confirmation (`ConfirmedCall.idempotency_key` in
 * `src/tools/confirmation.ts`): the same key for every repeat of one confirmed
 * call, a new one for a new confirmation. A V3 adapter sends it as the
 * `Idempotency-Key` header, so a repeat returns the original result instead of
 * writing again. The V1 and V2 adapters ignore it — those APIs have no such
 * header — and the use cases' own replay guards stand in.
 */
export interface WriteOptions {
  readonly idempotency_key?: string;
}

/** The write options of a call a person confirmed, or none. */
export function writeOptions(
  confirmation: { readonly idempotency_key: string } | undefined
): WriteOptions {
  return confirmation ? { idempotency_key: confirmation.idempotency_key } : {};
}
