/**
 * What every curated tool does to its arguments before, and after, Zod sees
 * them: forgive the one cosmetic mistake models make constantly, explain the
 * one they cannot fix without help, and give a confirmation token one stable
 * thing to bind to.
 *
 * - **Id coercion.** `"4564"` for `location_id` is the same id a model meant,
 *   and refusing it ("expected number, received string") only costs a retry.
 *   An integer-typed argument whose key names an id (`id`, `*_id`, `*_ids`)
 *   accepts a canonical digit string. Nothing else is loosened: `"12abc"`,
 *   `"1.5"`, a page number as a string and every non-id field stay strict.
 * - **First-page size.** A first page asked above the tool's `page_size`
 *   ceiling is served at the ceiling and says so (`capPageSize`).
 * - **Accepted keys.** The strict top-level object refuses an unknown key; the
 *   error then names the keys that object does accept (`./tool-result.ts`).
 * - **Canonical input.** The confirmation gate binds its token to the parsed
 *   input with absent and `null` optionals removed, so repeating a call with
 *   `null` where it first left a field out — or `"4564"` where it first sent
 *   `4564` — still matches the token it was given.
 *
 * Zod 4 internals are read through `_zod.def`, the documented introspection
 * surface; wrappers (optional, nullable, default, pipe, …) are looked through.
 */
import type { ZodType } from 'zod';

interface ZodDef {
  type: string;
  innerType?: ZodType;
  in?: ZodType;
  element?: ZodType;
  shape?: Record<string, ZodType>;
}

function defOf(schema: ZodType): ZodDef {
  return (schema as unknown as { _zod: { def: ZodDef } })._zod.def;
}

/** Wrapper types that hold one inner schema and do not change its shape. */
const WRAPPERS = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'readonly',
  'catch',
  'nonoptional',
]);

/** The schema under every wrapper and the input side of every pipe. */
export function unwrapSchema(schema: ZodType): ZodType {
  let current = schema;
  for (let depth = 0; depth < 16; depth += 1) {
    const def = defOf(current);
    if (WRAPPERS.has(def.type) && def.innerType) current = def.innerType;
    else if (def.type === 'pipe' && def.in) current = def.in;
    else break;
  }
  return current;
}

function shapeOf(schema: ZodType): Record<string, ZodType> | undefined {
  const def = defOf(schema);
  return def.type === 'object' ? def.shape : undefined;
}

/** Keys that name an id: `id`, `client_id`, `team_member_ids`, … */
const ID_KEY = /(?:^|_)ids?$/;

/** A canonical non-negative integer: no sign, no spaces, no leading zeros. */
const CANONICAL_INTEGER = /^(?:0|[1-9]\d*)$/;

function coerceIdString(value: string): number | string {
  if (!CANONICAL_INTEGER.test(value)) return value;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
}

/**
 * Turn digit strings into numbers wherever the schema expects an integer id;
 * return everything else untouched for Zod to judge.
 */
export function coerceIdStrings(
  schema: ZodType,
  value: unknown,
  key?: string
): unknown {
  const core = unwrapSchema(schema);
  const def = defOf(core);

  if (def.type === 'number') {
    return typeof value === 'string' && key !== undefined && ID_KEY.test(key)
      ? coerceIdString(value)
      : value;
  }
  if (def.type === 'array' && def.element && Array.isArray(value)) {
    const element = def.element;
    return value.map((item) => coerceIdStrings(element, item, key));
  }
  const shape = shapeOf(core);
  if (shape && value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [entryKey, entry] of Object.entries(value)) {
      const entrySchema = shape[entryKey];
      out[entryKey] = entrySchema
        ? coerceIdStrings(entrySchema, entry, entryKey)
        : entry;
    }
    return out;
  }
  return value;
}

/** A first page asked larger than the tool serves: what was asked and served. */
export interface PageSizeCap {
  requested: number;
  served: number;
}

/**
 * Serve the first page of an oversized `page_size` at the tool's ceiling.
 *
 * Scripts and models ask for 200 or 500 rows, and a refusal cost 2,400
 * failed calls from 2026-10-12 to 2026-10-22, most repeated unchanged. Only
 * page 1 is lowered: its items are the first ones whatever the size, and the
 * served size comes back in `pagination.page_size` with `next_page` counted
 * in it. A later page keeps the refusal — its offset would not be the one the
 * caller computed with its own size, and reading the wrong items without an
 * error is worse than a refusal (`renderPage`).
 */
export function capPageSize(
  schema: ZodType,
  value: unknown
): { value: unknown; cap?: PageSizeCap } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { value };
  }
  const args = value as Record<string, unknown>;
  const requested = args.page_size;
  if (
    typeof requested !== 'number' ||
    !Number.isSafeInteger(requested) ||
    (args.page !== undefined && args.page !== 1)
  ) {
    return { value };
  }
  const entry = shapeOf(unwrapSchema(schema))?.page_size;
  const core = entry ? unwrapSchema(entry) : undefined;
  if (!core || defOf(core).type !== 'number') return { value };
  const served = (core as unknown as { _zod: { bag: { maximum?: unknown } } })
    ._zod.bag.maximum;
  if (typeof served !== 'number' || requested <= served) return { value };
  return { value: { ...args, page_size: served }, cap: { requested, served } };
}

/**
 * The keys the object at `path` inside the arguments accepts, or `undefined`
 * when nothing there is an object schema.
 */
export function acceptedKeysAt(
  schema: ZodType,
  path: readonly PropertyKey[]
): string[] | undefined {
  let current: ZodType | undefined = unwrapSchema(schema);
  for (const segment of path) {
    if (!current) return undefined;
    const def = defOf(current);
    if (def.type === 'array' && def.element && typeof segment === 'number') {
      current = unwrapSchema(def.element);
      continue;
    }
    const shape = shapeOf(current);
    const next = shape?.[String(segment)];
    current = next ? unwrapSchema(next) : undefined;
  }
  const shape = current ? shapeOf(current) : undefined;
  return shape ? Object.keys(shape) : undefined;
}

/**
 * The parsed input as a confirmation binds it: object keys whose value is
 * `undefined` or `null` dropped at every depth, everything else as parsed.
 */
export function canonicalInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalInput);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined || entry === null) continue;
      out[key] = canonicalInput(entry);
    }
    return out;
  }
  return value;
}

// ========== listed JSON Schema ==========

/** Letters and digits only, lower case: `Location ID` and `location_id` agree. */
function bare(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A description that only spells the property name out ("Location ID"). */
function restatesName(name: string, description: unknown): boolean {
  return typeof description === 'string' && bare(description) === bare(name);
}

/**
 * Drop what a JSON Schema generated from Zod repeats without telling a model
 * anything, so `tools/list` costs fewer tokens. Validation is unaffected: the
 * server parses every call with the Zod schema, never with this document.
 *
 * - `maximum: 9007199254740991` / `minimum: -9007199254740991` — the safe
 *   integer range Zod writes on every `.int()`.
 * - `pattern` next to a `format` — Zod spells out a 400-character RFC 3339
 *   regex beside `format: "date-time"`.
 * - `exclusiveMinimum: 0` on an integer — written as `minimum: 1`.
 * - A property description that only restates the property name
 *   (`location_id`: "Location ID").
 */
export function compactJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compactJsonSchema);
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'maximum' && value === Number.MAX_SAFE_INTEGER) continue;
    if (key === 'minimum' && value === Number.MIN_SAFE_INTEGER) continue;
    out[key] = compactJsonSchema(value);
  }
  if (typeof out.format === 'string' && typeof out.pattern === 'string') {
    delete out.pattern;
  }
  if (out.properties && typeof out.properties === 'object') {
    for (const [name, property] of Object.entries(out.properties)) {
      if (
        property &&
        typeof property === 'object' &&
        restatesName(name, (property as { description?: unknown }).description)
      ) {
        delete (property as { description?: unknown }).description;
      }
    }
  }
  if (
    out.type === 'integer' &&
    out.exclusiveMinimum === 0 &&
    out.minimum === undefined
  ) {
    delete out.exclusiveMinimum;
    out.minimum = 1;
  }
  return out;
}
