/**
 * Defensive readers for loosely typed V1 JSON payloads.
 *
 * Several curated tools read small V1 documents whose shape the public contract
 * describes only by example. These readers never throw: a value of the wrong
 * type becomes `null` (or an empty record/list), and the caller decides whether
 * that is a refusal or an unknown field.
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

export function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : null;
}

/** A stable positive id; zero, negatives and non-integers are "no id". */
export function asPositiveId(value: unknown): number | null {
  const id = asInteger(value);
  return id !== null && id > 0 ? id : null;
}

export function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function asText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}
