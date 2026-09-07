/**
 * Catalog-driven execution — backs `altegio_call_operation`.
 *
 * Policy (ADR-001 D2): any documented **read** is callable; writes are not,
 * until the overlay's `write_allowed` allowlist is wired to a curated policy.
 * Everything else here is the contract work between the model and the API —
 * binding canonical parameter names to the spec's spelling, validating against
 * the catalog, building the path and query, then projecting and budgeting the
 * result (D8).
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { ExecutorRefusalError } from '../../utils/errors.js';
import {
  acceptedNames,
  getOperation,
  type CatalogOperation,
  type CatalogParameter,
} from './catalog.js';
import {
  applyProjection,
  enforceBudget,
  NARROW_HINT,
  serializedSize,
} from './budget.js';
import { exposedParamName } from './describe.js';

/** Characters of payload kept in `structuredContent` (the rest of the budget is the text summary). */
export const PAYLOAD_BUDGET_CHARS = 10000;
/** Characters of payload echoed into the text summary, for hosts that show only text. */
export const TEXT_PREVIEW_CHARS = 3500;

type QueryValue = string | number | boolean;

interface BoundParameter {
  specName: string;
  /** The spelling the caller used — forwarded unchanged; V1 accepts the canonical aliases. */
  usedName: string;
  in: string;
  value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Names to look for, most canonical first: the name the model was told to use,
 * then the spec spelling, then the remaining legacy spellings.
 */
function lookupOrder(op: CatalogOperation, specName: string): string[] {
  const exposed = exposedParamName(op, specName);
  return [...new Set([exposed, specName, ...acceptedNames(specName)])];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isIntegerLike(value: unknown): boolean {
  if (typeof value === 'number') return Number.isInteger(value);
  return typeof value === 'string' && /^-?\d+$/.test(value.trim());
}

function isNumberLike(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    Number.isFinite(Number(value))
  );
}

function isBooleanLike(value: unknown): boolean {
  if (typeof value === 'boolean') return true;
  if (typeof value === 'number') return value === 0 || value === 1;
  return (
    typeof value === 'string' &&
    ['true', 'false', '0', '1'].includes(value.trim().toLowerCase())
  );
}

/**
 * Shallow validation against the catalog's parameter schema.
 *
 * Deliberately not a full JSON-Schema engine: the catalog stores path and query
 * parameter schemas one level deep, so every value here is a scalar or a list
 * of scalars. `ajv` + `ajv-formats` would add two runtime dependencies to a
 * public server to check `type: integer` — see docs/architecture/catalog.md.
 */
function validateValue(
  param: CatalogParameter,
  usedName: string,
  value: unknown
): string | null {
  const schema = param.schema ?? {};
  const declared = schema.type;
  const types = (
    Array.isArray(declared)
      ? declared
      : declared === undefined
        ? []
        : [declared]
  ).map(String);

  if (value === null) {
    return types.includes('null')
      ? null
      : `\`${usedName}\` must not be null (expected ${types.join(' | ') || 'a scalar'})`;
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const allowed = schema.enum.map((e) => String(e));
    if (!allowed.includes(String(value))) {
      return `\`${usedName}\` must be one of: ${allowed.join(', ')} (got ${JSON.stringify(value)})`;
    }
  }

  const nonNull = types.filter((t) => t !== 'null');
  if (nonNull.length === 0) return null;

  const ok = nonNull.some((type) => {
    switch (type) {
      case 'integer':
        return isIntegerLike(value);
      case 'number':
        return isNumberLike(value);
      case 'boolean':
        return isBooleanLike(value);
      case 'array':
        return Array.isArray(value) || typeof value === 'string';
      case 'string':
        return (
          typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean'
        );
      case 'object':
        return isRecord(value);
      default:
        return true;
    }
  });

  return ok
    ? null
    : `\`${usedName}\` must be ${nonNull.join(' | ')} (got ${JSON.stringify(value)})`;
}

/** Flatten a bound value into something a query string can carry. */
function toQueryValue(value: unknown): QueryValue {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(',');
  if (isRecord(value)) return JSON.stringify(value);
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  return String(value);
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

export interface BuiltRequest {
  path: string;
  query: Record<string, QueryValue>;
  /** Parameters forwarded although the spec does not document them. */
  warnings: string[];
}

export function buildRequest(
  op: CatalogOperation,
  params: Record<string, unknown>
): BuiltRequest {
  const consumed = new Set<string>();
  const bound: BoundParameter[] = [];
  const missing: string[] = [];
  const problems: string[] = [];

  for (const param of op.parameters) {
    const required = param.required === true || param.in === 'path';
    const names = lookupOrder(op, param.name);
    const usedName = names.find(
      (name) =>
        Object.prototype.hasOwnProperty.call(params, name) &&
        params[name] !== undefined
    );

    if (usedName === undefined) {
      if (required) missing.push(exposedParamName(op, param.name));
      continue;
    }

    consumed.add(usedName);
    const value = params[usedName];
    const problem = validateValue(param, usedName, value);
    if (problem) problems.push(problem);
    bound.push({
      specName: param.name,
      usedName,
      in: param.in ?? 'query',
      value,
    });
  }

  // Some V1 path items declare fewer parameters than their template uses; bind
  // whatever the template still needs so the call is not blocked by spec gaps.
  const placeholders = [...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  for (const placeholder of placeholders) {
    if (placeholder === undefined) continue;
    if (bound.some((b) => b.specName === placeholder && b.in === 'path')) {
      continue;
    }
    const usedName = lookupOrder(op, placeholder).find(
      (name) =>
        Object.prototype.hasOwnProperty.call(params, name) &&
        params[name] !== undefined
    );
    if (usedName === undefined) {
      const exposed = exposedParamName(op, placeholder);
      if (!missing.includes(exposed)) missing.push(exposed);
      continue;
    }
    consumed.add(usedName);
    bound.push({
      specName: placeholder,
      usedName,
      in: 'path',
      value: params[usedName],
    });
  }

  if (missing.length > 0 || problems.length > 0) {
    const lines = [
      `\`${op.operationId}\` (${op.method} ${op.displayPath}) cannot be called with these arguments:`,
    ];
    if (missing.length > 0) {
      lines.push(`  missing required: ${missing.join(', ')}`);
    }
    for (const problem of problems) lines.push(`  ${problem}`);
    lines.push(
      'Call `altegio_describe_operation` for the full parameter list with types.'
    );
    throw new ExecutorRefusalError(lines.join('\n'), {
      operationId: op.operationId,
      missing,
      problems,
    });
  }

  // Path parameters carry only their value, so the spec's own spelling is used
  // for substitution; query parameters keep the caller's spelling — V1 accepts
  // the canonical aliases on the wire.
  const pathValues = new Map(
    bound
      .filter((b) => b.in === 'path')
      .map((b) => [b.specName, String(toQueryValue(b.value))])
  );
  const path = op.path.replace(/\{([^}]+)\}/g, (match, name: string) => {
    const value = pathValues.get(name);
    return value === undefined ? match : encodeURIComponent(value);
  });

  const query: Record<string, QueryValue> = {};
  for (const b of bound) {
    if (b.in === 'path') continue;
    if (b.in === 'query') query[b.usedName] = toQueryValue(b.value);
  }

  // The V1 spec under-documents pagination (`page`, `count`) on many list
  // endpoints, so an undocumented argument is forwarded rather than refused —
  // a read is harmless, and refusing would block legitimate paging.
  const warnings: string[] = [];
  const extras = Object.keys(params)
    .filter((key) => !consumed.has(key) && params[key] !== undefined)
    .sort();
  for (const key of extras) {
    query[key] = toQueryValue(params[key]);
  }
  if (extras.length > 0) {
    warnings.push(
      `Forwarded as query parameters although the spec does not document them ` +
        `for this operation: ${extras.join(', ')}.`
    );
  }

  return { path, query, warnings };
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Refuse anything the executor is not allowed to run (ADR-001 D2). */
export function assertCallable(op: CatalogOperation): void {
  if (op.method !== 'GET') {
    const curated = op.curation?.tool_name;
    throw new ExecutorRefusalError(
      `\`${op.operationId}\` is a ${op.method} operation and will not be executed: ` +
        'writes are available through curated tools; executor writes require the ' +
        'allowlist from ADR-001 D2.' +
        (curated ? ` Use the curated tool \`${curated}\`.` : ''),
      { operationId: op.operationId, method: op.method }
    );
  }

  if (op.source !== 'v1') {
    throw new ExecutorRefusalError(
      `\`${op.operationId}\` comes from the ${op.source} preview contract ` +
        `(status: ${op.status ?? 'preview'}) and is not served by the live API yet. ` +
        'Search again without `include_preview` to find a callable equivalent.',
      { operationId: op.operationId, source: op.source }
    );
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface CallOutput {
  text: string;
  structuredContent: Record<string, unknown>;
}

function summarize(payload: unknown): string {
  if (Array.isArray(payload)) {
    return `${payload.length} item${payload.length === 1 ? '' : 's'}`;
  }
  if (isRecord(payload)) {
    return `1 object (${Object.keys(payload).length} fields)`;
  }
  return payload === undefined || payload === null ? 'no content' : 'a value';
}

export async function callOperation(
  client: AltegioClient,
  operationId: string,
  params: Record<string, unknown> = {}
): Promise<CallOutput> {
  const op = getOperation(operationId);
  if (!op) {
    throw new ExecutorRefusalError(
      `No operation \`${operationId}\` in the API catalog. ` +
        'Use `altegio_search_operations` to find the right operationId.',
      { operationId }
    );
  }

  assertCallable(op);
  const { path, query, warnings } = buildRequest(op, params);
  const { data, meta } = await client.request('GET', path, query);

  const projection = op.curation?.projection;
  const projected =
    projection && projection.length > 0
      ? applyProjection(data, projection)
      : data;

  const budgeted = enforceBudget(projected, PAYLOAD_BUDGET_CHARS);

  const structuredContent: Record<string, unknown> = {
    operation_id: op.operationId,
    method: op.method,
    path,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    data: budgeted.value,
    ...(budgeted.total !== undefined
      ? { returned: budgeted.returned, total: budgeted.total }
      : {}),
    ...(meta ? { meta } : {}),
    ...(projection && projection.length > 0
      ? { projection_applied: projection }
      : {}),
    ...(budgeted.truncated ? { truncated: true, hint: NARROW_HINT } : {}),
    ...(budgeted.omittedFields
      ? { omitted_fields: budgeted.omittedFields }
      : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    search.append(key, String(value));
  }
  const queryString = search.toString();

  const lines = [
    `${op.method} ${path}${queryString ? `?${queryString}` : ''}`,
    `${op.operationId} → ${summarize(budgeted.value)}` +
      (budgeted.truncated && budgeted.total !== undefined
        ? ` of ${budgeted.total}`
        : ''),
  ];
  if (projection && projection.length > 0) {
    lines.push(`Fields projected to: ${projection.join(', ')}.`);
  }
  if (budgeted.truncated) lines.push(NARROW_HINT);
  for (const warning of warnings) lines.push(warning);

  const preview = JSON.stringify(budgeted.value);
  lines.push(
    '',
    serializedSize(budgeted.value) <= TEXT_PREVIEW_CHARS
      ? preview
      : `${preview.slice(0, TEXT_PREVIEW_CHARS)}… (full payload in the structured result)`
  );

  return { text: lines.join('\n'), structuredContent };
}
