/**
 * Tolerant arguments for `api_call_operation`.
 *
 * The tool takes `{operation_id, params}`, but models arrive with the shapes
 * other APIs taught them: `path_params` + `query`, `arguments`, `operationId`,
 * parameters at the top level, `params` as a JSON string. A strict schema
 * answered all of those with a bare "Unrecognized key", which names neither
 * `params` nor the parameters the operation takes. This step runs before the
 * schema and folds every such shape into the one the tool documents; the
 * handler then reports what was folded, or refuses with an instruction that
 * names `params` when something cannot be folded at all.
 *
 * The folded notes travel inside `params` under reserved keys (`$`-prefixed,
 * which no API parameter uses), because the strict schema keeps nothing else.
 */

/** Reserved `params` key: the misplaced top-level keys that were folded. */
export const FOLDED_KEY = '$folded';
/** Reserved `params` key: a container that could not be read as parameters. */
export const INVALID_KEY = '$invalid';

/** Containers models use for parameters, folded into `params` in this order. */
const PARAM_CONTAINERS = [
  'params',
  'parameters',
  'path_params',
  'pathParams',
  'path_parameters',
  'query',
  'query_params',
  'queryParams',
  'query_parameters',
  'arguments',
  'args',
  'input',
  'body',
];

/** Other spellings of `operation_id`. */
const OPERATION_ID_KEYS = ['operation_id', 'operationId', 'operation', 'op'];

/** Top-level arguments the tool itself declares. */
const DECLARED = new Set(['operation_id', 'params', 'include_contacts']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A container as an object: as given, or parsed from a JSON string. */
function asParameters(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Fold the shapes models actually send into `{operation_id, params,
 * include_contacts}`. Anything that is not an object is returned unchanged.
 */
export function foldCallArguments(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;

  const operationKey = OPERATION_ID_KEYS.find(
    (key) => typeof raw[key] === 'string'
  );
  const params: Record<string, unknown> = {};
  const folded: string[] = [];
  const invalid: string[] = [];

  for (const container of PARAM_CONTAINERS) {
    if (!(container in raw) || raw[container] === undefined) continue;
    const value = raw[container];
    if (value === null) continue;
    const parsed = asParameters(value);
    if (!parsed) {
      invalid.push(container);
      continue;
    }
    if (container !== 'params' || !isRecord(value)) folded.push(container);
    for (const [name, entry] of Object.entries(parsed)) {
      // An explicit `params` entry wins over the same name in another container.
      if (!(name in params)) params[name] = entry;
    }
  }

  // Remaining unknown top-level keys are parameters the caller forgot to nest.
  for (const [key, value] of Object.entries(raw)) {
    if (DECLARED.has(key) || PARAM_CONTAINERS.includes(key)) continue;
    if (OPERATION_ID_KEYS.includes(key) && typeof value === 'string') continue;
    if (!(key in params)) params[key] = value;
    folded.push(key);
  }

  if (folded.length > 0) params[FOLDED_KEY] = folded;
  if (invalid.length > 0) params[INVALID_KEY] = invalid;

  const includeContacts =
    raw.include_contacts === 'true'
      ? true
      : raw.include_contacts === 'false'
        ? false
        : raw.include_contacts;
  return {
    operation_id: operationKey ? raw[operationKey] : '',
    ...(includeContacts !== undefined
      ? { include_contacts: includeContacts }
      : {}),
    params,
  };
}

/** Split the reserved notes off the folded `params`. */
export function takeFoldNotes(params: Record<string, unknown>): {
  params: Record<string, unknown>;
  folded: string[];
  invalid: string[];
} {
  const { [FOLDED_KEY]: folded, [INVALID_KEY]: invalid, ...rest } = params;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String) : [];
  return { params: rest, folded: strings(folded), invalid: strings(invalid) };
}
