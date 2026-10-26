/**
 * Catalog-driven execution — backs `api_call_operation`.
 *
 * Policy (ADR-001 D2): any documented **read** is callable; writes are not,
 * until the overlay's `write_allowed` allowlist is wired to a curated policy.
 * Everything else here is the contract work between the model and the API —
 * binding canonical parameter names to the spec's spelling, validating against
 * the catalog, building the path and query, then projecting the result into
 * the product glossary and fitting it to the size budget with an exact
 * continuation (D5, D8).
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import {
  AltegioApiError,
  AuthenticationError,
  ExecutorRefusalError,
} from '../../utils/errors.js';
import {
  curatedToolFor,
  fallbacksFor,
  isLiveSource,
  resolveOperation,
  type CatalogOperation,
  type CatalogParameter,
} from './catalog.js';
import { isLocationMetadataRead } from '../../providers/location-read-policy.js';
import { v2Path } from '../../api/altegio-http.js';
import { apiMessage } from '../../api/http-failure.js';
import {
  applyProjection,
  enforceBudget,
  fitCount,
  NARROW_HINT,
  serializedSize,
} from './budget.js';
import {
  sanitizeUntrustedDeep,
  untrustedBlock,
  UNTRUSTED_NOTE,
  upstreamDetail,
  type UntrustedField,
} from '../tool-result.js';
import { elsewhereClause } from '../serving-view.js';
import { CONTACTS_WITHHELD_NOTICE } from '../contacts.js';
import {
  QUERY_ALIASES,
  acceptedParamNames,
  exposedParamName,
  isArrayWireName,
  pagingParameters,
} from './params.js';
import { indexIncluded, projectToGlossary } from './glossary.js';
import { DEFAULT_PAGE_SIZE, planPage, type Pagination } from './paging.js';
import {
  assertChainAllowed,
  assertCompanyAllowed,
  getRequestCompanyIds,
  getRequestScopes,
  runWithRequiredScopes,
} from '../../request-context.js';
import { CONTACT_SCOPE, checkToolScopes, type ToolScope } from '../scopes.js';
import { executorScopeFor, isChainLevelOperation } from './scopes.js';

/** Characters of payload kept in `structuredContent`. */
export const PAYLOAD_BUDGET_CHARS = 9000;
/**
 * Characters of the same items rendered compactly into the text, for hosts
 * that read only `content`. A list is rendered as a header plus one row per
 * item, so the text carries every returned item without repeating its keys.
 */
export const TEXT_BUDGET_CHARS = 6000;

type QueryValue = string | number | boolean;

interface BoundParameter {
  param: CatalogParameter;
  /** The name the model is shown, which the result echoes back. */
  exposed: string;
  value: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function has(params: Record<string, unknown>, name: string): boolean {
  return (
    Object.prototype.hasOwnProperty.call(params, name) &&
    params[name] !== undefined
  );
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

/**
 * A date where the spec wants a date-time: `date_from: "2026-10-01"` becomes
 * the start of that day and `date_to` its end, in whichever separator the
 * spec's pattern uses. Anything else is left for the API to judge.
 */
function normalizeDateTime(
  param: CatalogParameter,
  exposed: string,
  value: unknown
): unknown {
  const pattern = param.schema?.pattern;
  if (typeof pattern !== 'string' || typeof value !== 'string') return value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    return value;
  }
  const time = /(_to|_before|_end)$/.test(exposed) ? '23:59:59' : '00:00:00';
  for (const separator of ['T', ' ']) {
    const candidate = `${value.trim()}${separator}${time}`;
    if (regex.test(candidate)) return candidate;
  }
  return value;
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

function listValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [String(value)];
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

export interface BuiltRequest {
  path: string;
  /** Query parameters under the spec's spelling; a list is sent repeated. */
  query: Record<string, QueryValue | string[]>;
  /** The bound parameters under their canonical names, for the result. */
  params: Record<string, unknown>;
  /** Parameters forwarded although the spec does not document them. */
  warnings: string[];
}

/** The path and query parameters of one operation, by exposed name, for messages. */
function parameterList(op: CatalogOperation): string {
  return op.parameters
    .filter((p) => p.in === 'path' || p.in === 'query')
    .map((p) => {
      const name = exposedParamName(op, p.name, p.in);
      return p.required === true || p.in === 'path'
        ? `${name} (required)`
        : name;
    })
    .join(', ');
}

/** The canonical parameter list of an operation id, or a pointer to search. */
export function parameterNamesFor(operationId: string): string {
  const resolved = resolveOperation(operationId);
  return resolved
    ? parameterList(resolved.op) || 'none'
    : 'unknown operation — find the id with `api_search_operations`';
}

/** Which caller-supplied keys an operation would bind. */
function bindableKeys(
  op: CatalogOperation,
  params: Record<string, unknown>
): Set<string> {
  const names = new Set<string>();
  for (const param of op.parameters) {
    if (param.in !== 'path' && param.in !== 'query') continue;
    for (const name of acceptedParamNames(op, param.name, param.in)) {
      if (has(params, name)) names.add(name);
    }
  }
  for (const [, placeholder] of op.path.matchAll(/\{([^}]+)\}/g)) {
    if (placeholder === undefined) continue;
    for (const name of acceptedParamNames(op, placeholder, 'path')) {
      if (has(params, name)) names.add(name);
    }
  }
  return names;
}

export function buildRequest(
  op: CatalogOperation,
  params: Record<string, unknown>
): BuiltRequest {
  const consumed = new Set<string>();
  const bound: BoundParameter[] = [];
  const missing: string[] = [];
  const problems: string[] = [];

  const take = (names: string[]): string | undefined =>
    names.find((name) => has(params, name) && !consumed.has(name));

  for (const param of op.parameters) {
    // Only path and query parameters are the caller's business: headers and
    // cookies are transport, supplied by the client, so a spec that marks one
    // required must not block a read.
    if (param.in !== 'path' && param.in !== 'query') continue;

    const required = param.required === true || param.in === 'path';
    const exposed = exposedParamName(op, param.name, param.in);
    const usedName = take(acceptedParamNames(op, param.name, param.in));

    if (usedName === undefined) {
      if (required) missing.push(exposed);
      continue;
    }

    consumed.add(usedName);
    const value = normalizeDateTime(param, exposed, params[usedName]);
    const problem = validateValue(param, usedName, value);
    if (problem) problems.push(problem);
    bound.push({ param, exposed, value });
  }

  // Some V1 path items declare fewer parameters than their template uses; bind
  // whatever the template still needs so the call is not blocked by spec gaps.
  for (const [, placeholder] of op.path.matchAll(/\{([^}]+)\}/g)) {
    if (placeholder === undefined) continue;
    if (
      bound.some((b) => b.param.name === placeholder && b.param.in === 'path')
    ) {
      continue;
    }
    const exposed = exposedParamName(op, placeholder, 'path');
    const usedName = take(acceptedParamNames(op, placeholder, 'path'));
    if (usedName === undefined) {
      if (!missing.includes(exposed)) missing.push(exposed);
      continue;
    }
    consumed.add(usedName);
    bound.push({
      param: { name: placeholder, in: 'path', required: true },
      exposed,
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
      `Put them in \`params\`, e.g. {"operation_id": "${op.operationId}", "params": {${missing
        .map((name) => `"${name}": …`)
        .join(', ')}}}. Parameters: ${parameterList(op)}.`,
      'Call `api_describe_operation` for types and descriptions.'
    );
    throw new ExecutorRefusalError(lines.join('\n'), {
      operationId: op.operationId,
      missing,
      problems,
    });
  }

  // Path parameters carry only their value; query parameters go out under the
  // spec's own spelling, whatever name the caller used.
  const pathValues = new Map(
    bound
      .filter((b) => b.param.in === 'path')
      .map((b) => [b.param.name, String(toQueryValue(b.value))])
  );
  const path = op.path.replace(/\{([^}]+)\}/g, (match, name: string) => {
    const value = pathValues.get(name);
    return value === undefined ? match : encodeURIComponent(value);
  });

  const query: Record<string, QueryValue | string[]> = {};
  const canonical: Record<string, unknown> = {};
  for (const b of bound) {
    canonical[b.exposed] = b.value;
    if (b.param.in !== 'query') continue;
    const type = b.param.schema?.type;
    if (isArrayWireName(b.param.name)) {
      query[b.param.name] = listValues(b.value);
    } else if (op.source === 'v2' && type === 'array') {
      // V2 validates a list only in the repeated `name[]` form.
      query[`${b.param.name}[]`] = listValues(b.value);
    } else {
      query[b.param.name] = toQueryValue(b.value);
    }
  }

  // The V1 spec under-documents pagination (`page`, `count`) on many list
  // endpoints, so an undocumented argument is forwarded rather than refused —
  // a read is harmless, and refusing would block legitimate paging. The
  // canonical page size goes out under the spec family's own spelling.
  const warnings: string[] = [];
  const extras = Object.keys(params)
    .filter((key) => !consumed.has(key) && params[key] !== undefined)
    .sort();
  for (const key of extras) {
    const wire =
      key === 'page_size' ? (op.source === 'v2' ? 'limit' : 'count') : key;
    query[wire] = toQueryValue(params[key]);
    canonical[key] = params[key];
  }
  if (extras.length > 0) {
    warnings.push(
      `Forwarded although this operation does not document them: ${extras.join(', ')}.`
    );
  }

  // The executor obeys the same B2B location policy as curated tools. Keep
  // its reported query consistent with the filter enforced by the transport.
  if (op.source === 'v1' && isLocationMetadataRead(path, op.method)) {
    query.my = 1;
    canonical.my = 1;
  }

  return { path, query, params: canonical, warnings };
}

function queryString(query: BuiltRequest['query']): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.append(key, String(value));
    }
  }
  return search.toString();
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/**
 * Pick the route that serves a call. The canonical operation serves it unless
 * the caller needs a filter only a retired twin documents — then the twin does
 * (V2 first, V1 only as a fallback; the model never sees which). A twin at
 * another path qualifies only when the call fills its path.
 */
function chooseRoute(
  op: CatalogOperation,
  params: Record<string, unknown>
): CatalogOperation {
  const fallbacks = fallbacksFor(op);
  if (fallbacks.length === 0) return op;
  // Paging goes to every route — an undocumented page size is forwarded in
  // the route's own spelling (`buildRequest`) — so it never decides one.
  const supplied = Object.keys(params).filter(
    (key) =>
      has(params, key) &&
      key !== 'page' &&
      key !== 'page_size' &&
      QUERY_ALIASES[key] !== 'page_size'
  );
  const unknownTo = (route: CatalogOperation): number => {
    const bindable = bindableKeys(route, params);
    return supplied.filter((key) => !bindable.has(key)).length;
  };
  const fillsPath = (route: CatalogOperation): boolean =>
    [...route.path.matchAll(/\{([^}]+)\}/g)].every(([, placeholder]) =>
      acceptedParamNames(route, placeholder ?? '', 'path').some((name) =>
        has(params, name)
      )
    );
  let best = op;
  let bestUnknown = unknownTo(op);
  for (const fallback of fallbacks) {
    if (!fillsPath(fallback)) continue;
    const unknown = unknownTo(fallback);
    if (unknown < bestUnknown) {
      best = fallback;
      bestUnknown = unknown;
    }
  }
  return best;
}

/**
 * The address a result reports when a retired twin at another path served the
 * call: the canonical operation's, filled from the same canonical parameters,
 * so the model sees one capability at one address. `undefined` when the
 * canonical route served it, or its path cannot be filled.
 */
function reportedPath(
  op: CatalogOperation,
  route: CatalogOperation,
  params: Record<string, unknown>
): string | undefined {
  if (route === op) return undefined;
  let filled = true;
  const path = op.displayPath.replace(/\{([^}]+)\}/g, (match, name: string) => {
    const value = params[name];
    if (typeof value !== 'string' && typeof value !== 'number') {
      filled = false;
      return match;
    }
    return encodeURIComponent(String(value));
  });
  return filled ? path : undefined;
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

  if (!isLiveSource(op.source)) {
    throw new ExecutorRefusalError(
      `\`${op.operationId}\` comes from the ${op.source} preview contract ` +
        `(status: ${op.status ?? 'preview'}) and is not served by the live API yet. ` +
        'Search again without `include_preview` to find a callable equivalent.',
      { operationId: op.operationId, source: op.source }
    );
  }
}

const LOCATION_PARAMETER_NAMES = new Set([
  'location_id',
  'company_id',
  'salon_id',
]);

/**
 * Resolve and enforce the location dimension from catalog metadata.
 *
 * A URL-number heuristic cannot distinguish a location id from a visit,
 * chain, document or category id. Scoped executor calls therefore need an
 * explicit location/company/salon parameter; entity-only and chain-level reads
 * are refused because their result cannot be proven to stay inside the scope.
 */
function enforceCatalogCompanyScope(
  op: CatalogOperation,
  params: Record<string, unknown>
): number | null {
  const declaredScope = getRequestCompanyIds();
  const locationParameters = op.parameters.filter((parameter) =>
    LOCATION_PARAMETER_NAMES.has(parameter.name.toLowerCase())
  );

  for (const parameter of locationParameters) {
    const usedName = acceptedParamNames(op, parameter.name, parameter.in).find(
      (name) => has(params, name)
    );
    if (usedName === undefined) continue;
    const value = Number(params[usedName]);
    assertCompanyAllowed(value);
    return value;
  }

  // A chain-level read is confined by the chain grant (RFC decision 13):
  // its scope was resolved at the chain level (`./scopes.ts`), and the
  // transport must not read the chain id as a location.
  if (isChainLevelOperation(op)) {
    const chainParameter = op.parameters.find(
      (parameter) =>
        parameter.in === 'path' && parameter.name.toLowerCase() === 'chain_id'
    );
    const usedName =
      chainParameter &&
      acceptedParamNames(op, chainParameter.name, chainParameter.in).find(
        (name) => has(params, name)
      );
    if (usedName !== undefined) {
      assertChainAllowed(Number(params[usedName]));
      return null;
    }
  }

  if (declaredScope !== undefined) {
    throw new ExecutorRefusalError(
      `\`${op.operationId}\` cannot be confined to the declared location scope of ` +
        'this connection: the operation names neither a location nor a chain. ' +
        'Use a curated tool that takes a location_id or chain_id for this data.',
      { operationId: op.operationId, reason: 'unscoped_catalog_operation' }
    );
  }

  return null;
}

/**
 * The scope gate the registry runs per tool, run here per operation: one
 * tool name reaches every documented read, so the requirement is the read
 * scope of the operation's catalog domain (`./scopes.ts`), plus
 * `clients:read_contact` when contacts were asked for. A caller that
 * declared no scopes (local stdio) passes, as everywhere; a declared grant
 * that cannot be mapped to the operation's domain is refused rather than
 * waved through.
 */
function requiredScopesForOperation(
  op: CatalogOperation,
  includeContacts: boolean
): readonly ToolScope[] {
  const granted = getRequestScopes();
  const scope = executorScopeFor(op);
  const required: ToolScope[] = scope === undefined ? [] : [scope];
  if (includeContacts) required.push(CONTACT_SCOPE);
  if (granted === undefined) return required;
  if (scope === undefined) {
    throw new ExecutorRefusalError(
      `\`${op.operationId}\` belongs to the \`${op.domain}\` domain, which this build ` +
        'cannot map to a permission of the connected token, so it is not run on a scoped connection. ' +
        'Use a curated tool for this data.',
      { operationId: op.operationId, reason: 'unmapped_operation_scope' }
    );
  }
  const denial = checkToolScopes({
    toolName: 'api_call_operation',
    required,
    granted,
  });
  if (denial) {
    throw new ExecutorRefusalError(
      denial.content
        .map((part) => ('text' in part ? part.text : ''))
        .join('\n'),
      { operationId: op.operationId, reason: 'scope_denied', required }
    );
  }
  return required;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface CallOptions {
  /** Keep phone and email in the result (`include_contacts: true`). */
  includeContacts?: boolean;
  /** Notes from argument folding, echoed so the caller fixes its shape. */
  notes?: string[];
}

export interface CallOutput {
  text: string;
  structuredContent: Record<string, unknown>;
}

/**
 * Unwrap a V2 JSON:API document (`{data, meta, included}`) the way the client
 * unwraps the V1 `{success, data, meta}` envelope; side-loads are returned for
 * the glossary projection to inline where the data links to them. A document
 * with anything else at the top level (`links`, `errors`) is returned whole so
 * nothing is lost. V2 sends an empty `meta` as `[]`, which carries nothing and
 * is dropped.
 */
function unwrapJsonApi(body: unknown): {
  data: unknown;
  meta?: Record<string, unknown>;
  included?: unknown;
} {
  if (
    !isRecord(body) ||
    !('data' in body) ||
    Object.keys(body).some(
      (key) => key !== 'data' && key !== 'meta' && key !== 'included'
    )
  ) {
    return { data: body };
  }
  const meta = body.meta;
  return {
    data: body.data,
    ...(isRecord(meta) && Object.keys(meta).length > 0 ? { meta } : {}),
    ...(body.included !== undefined ? { included: body.included } : {}),
  };
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

/**
 * The payload as fenced text lines. A list of objects becomes a column header
 * plus one JSON row per item — the same items as the structured result, without
 * repeating every key — so a host that reads only text loses nothing.
 */
function textRows(label: string, payload: unknown): UntrustedField[] {
  if (
    Array.isArray(payload) &&
    payload.length > 1 &&
    payload.every((item) => isRecord(item))
  ) {
    const columns: string[] = [];
    for (const item of payload as Record<string, unknown>[]) {
      for (const key of Object.keys(item)) {
        if (!columns.includes(key)) columns.push(key);
      }
    }
    return [
      { label: `${label} columns`, value: JSON.stringify(columns) },
      ...(payload as Record<string, unknown>[]).map((item, index) => ({
        label: `${index + 1}`,
        value: JSON.stringify(columns.map((column) => item[column] ?? null)),
      })),
    ];
  }
  return [{ label, value: JSON.stringify(payload ?? null) }];
}

function textSize(fields: readonly UntrustedField[]): number {
  return fields.reduce(
    (total, field) =>
      total + field.label.length + String(field.value).length + 3,
    0
  );
}

/** A V1 list reports its size as `meta.total_count`. */
function reportedTotal(
  meta: Record<string, unknown> | undefined
): number | undefined {
  const total = meta?.total_count;
  return typeof total === 'number' && Number.isFinite(total)
    ? total
    : undefined;
}

/** Meta that the pagination block already says, dropped from `meta`. */
const PAGING_META_KEYS = new Set([
  'page',
  'total_count',
  'count',
  'pagination',
]);

function pageNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * Say what a failed call means for this operation before the API's own words
 * (ADR-001 D8). A status the overlay explains under `failures` gets its
 * sentence, then the curated tool that covers the operation — or where that
 * tool is served, when this view does not serve it — then the API's message,
 * quoted as data. The bare number sends a caller after the wrong fix: 416 from
 * a payroll read means no payroll scheme applies, not a bad argument.
 */
export function explainedFailure(
  op: CatalogOperation,
  endpoint: string,
  error: unknown
): unknown {
  if (
    !(error instanceof AltegioApiError) ||
    error instanceof AuthenticationError ||
    error.statusCode === undefined
  ) {
    return error;
  }
  const meaning = op.curation?.failures?.[String(error.statusCode)];
  if (!meaning) return error;
  const curated = curatedToolFor(op);
  const elsewhere = curated ? elsewhereClause(curated) : undefined;
  const pointer = !curated
    ? ''
    : elsewhere === undefined
      ? ` The curated tool \`${curated}\` covers this operation: prefer it.`
      : ` The curated tool \`${curated}\` covers this operation, but this address does not serve it; ${elsewhere}.`;
  const detail = upstreamDetail(apiMessage(error.response));
  return new AltegioApiError(
    `Failed to call ${op.method} ${endpoint} (HTTP ${error.statusCode}). ${meaning}${pointer}` +
      (detail ? ` ${detail}` : ''),
    error.statusCode,
    error.response
  );
}

export async function callOperation(
  client: AltegioClient,
  operationId: string,
  params: Record<string, unknown> = {},
  options: CallOptions = {}
): Promise<CallOutput> {
  const resolved = resolveOperation(operationId);
  if (!resolved) {
    throw new ExecutorRefusalError(
      `No operation \`${operationId}\` in the API catalog. ` +
        'Use `api_search_operations` to find the right operationId.',
      { operationId }
    );
  }
  const { op, retiredId } = resolved;
  assertCallable(op);

  // `include_contacts` is the executor's own switch, wherever the caller put it.
  const { include_contacts: contactsParam, ...callParams } = params;
  const includeContacts =
    options.includeContacts === true ||
    contactsParam === true ||
    contactsParam === 'true';

  const required = requiredScopesForOperation(op, includeContacts);

  const route = chooseRoute(op, callParams);

  // Ask for a bounded page when the caller names no size: the result keeps
  // what fits anyway, and an unbounded default can be hundreds of items.
  const paging = pagingParameters(route);
  let requestParams = callParams;
  if (
    paging.size &&
    !acceptedParamNames(route, paging.size.name, 'query').some((name) =>
      has(callParams, name)
    )
  ) {
    const maximum = Number(paging.size.schema?.maximum);
    requestParams = {
      ...callParams,
      page_size: Number.isFinite(maximum)
        ? Math.min(DEFAULT_PAGE_SIZE, maximum)
        : DEFAULT_PAGE_SIZE,
    };
  }

  const built = buildRequest(route, requestParams);
  const scopedCompany = enforceCatalogCompanyScope(route, requestParams);
  const search = queryString(built.query);
  // The transport is bound to `/api/v1` and already sends the V2 media type.
  const endpoint =
    (route.source === 'v2' ? v2Path(built.path) : built.path) +
    (search ? `?${search}` : '');
  const response = await runWithRequiredScopes(required, () =>
    client.request('GET', endpoint, undefined, scopedCompany)
  ).catch((error: unknown) => {
    throw explainedFailure(op, endpoint, error);
  });
  const {
    data,
    meta,
    included,
  }: {
    data: unknown;
    meta?: Record<string, unknown>;
    included?: unknown;
  } = route.source === 'v2' ? unwrapJsonApi(response.data) : response;

  const glossary = projectToGlossary(data, {
    includeContacts,
    keepRootContacts: op.domain === 'locations',
    included: indexIncluded(included),
  });

  // The overlay names projected fields as the glossary spells them, after
  // JSON:API resources are flattened, so one allowlist fits whichever route —
  // the canonical operation or its retired twin — served the call.
  const projection = op.curation?.projection;
  const projected =
    projection && projection.length > 0
      ? applyProjection(glossary.value, projection)
      : glossary.value;

  // One tool reaches every documented GET, so the response schema is not known
  // until it arrives and there is no field list to guard by name. The whole
  // payload is other people's text — client comments, names, service titles,
  // whatever an endpoint nobody curated happens to carry — so it is cleaned as
  // a whole and, below, echoed only inside the fence.
  const cleaned = sanitizeUntrustedDeep(projected, {
    maxChars: PAYLOAD_BUDGET_CHARS,
  });

  const label = `${op.operationId} payload`;
  let value: unknown = cleaned;
  let truncated = false;
  let omittedFields: string[] | undefined;
  let pagination: Pagination | undefined;
  let listCounts: { returned: number; received: number } | undefined;

  if (Array.isArray(cleaned)) {
    const fits = fitCount(
      cleaned,
      (slice) =>
        serializedSize(slice) <= PAYLOAD_BUDGET_CHARS &&
        textSize(textRows(label, slice)) <= TEXT_BUDGET_CHARS
    );
    const pageBinding = paging.page
      ? exposedParamName(route, paging.page.name, 'query')
      : undefined;
    if (paging.size) {
      const plan = planPage({
        page:
          pageNumber(pageBinding ? built.params[pageBinding] : undefined) ?? 1,
        pageSize: pageNumber(built.params.page_size),
        received: cleaned.length,
        fits,
        total: reportedTotal(meta),
      });
      value = cleaned.slice(0, plan.keep);
      pagination = plan.pagination;
      truncated = plan.keep < cleaned.length;
    } else {
      value = cleaned.slice(0, fits);
      truncated = fits < cleaned.length;
      listCounts = { returned: fits, received: cleaned.length };
    }
    // A single item can still be over budget; prune it like any object.
    const items = value as unknown[];
    if (items.length === 1 && serializedSize(items) > TEXT_BUDGET_CHARS) {
      const pruned = enforceBudget(items[0], TEXT_BUDGET_CHARS);
      value = [pruned.value];
      omittedFields = pruned.omittedFields;
      truncated = truncated || pruned.truncated;
    }
  } else {
    const budgeted = enforceBudget(cleaned, TEXT_BUDGET_CHARS);
    value = budgeted.value;
    truncated = budgeted.truncated;
    omittedFields = budgeted.omittedFields;
  }

  const notices: string[] = [];
  if (retiredId) {
    notices.push(
      `\`${retiredId}\` is an older id of \`${op.operationId}\`; it was served as \`${op.operationId}\`. Use \`${op.operationId}\` from now on.`
    );
  }
  if (glossary.contactsWithheld) notices.push(CONTACTS_WITHHELD_NOTICE);
  const warnings = [...(options.notes ?? []), ...built.warnings];

  const nextParams =
    pagination?.next_page != null
      ? {
          ...Object.fromEntries(
            Object.entries(built.params).filter(
              ([key]) => key !== 'page' && key !== 'page_size'
            )
          ),
          page: pagination.next_page,
          page_size: pagination.next_page_size,
        }
      : undefined;
  const otherMeta = meta
    ? Object.fromEntries(
        Object.entries(meta).filter(
          ([key]) => !(pagination && PAGING_META_KEYS.has(key))
        )
      )
    : undefined;
  const hint = truncated && !nextParams ? NARROW_HINT : undefined;

  const path = reportedPath(op, route, built.params) ?? built.path;
  const structuredContent: Record<string, unknown> = {
    operation_id: op.operationId,
    method: op.method,
    path,
    params: built.params,
    data: value,
    data_note: UNTRUSTED_NOTE,
    ...(pagination ? { pagination } : {}),
    ...(nextParams ? { next_params: nextParams } : {}),
    ...(listCounts && listCounts.returned < listCounts.received
      ? listCounts
      : {}),
    ...(otherMeta && Object.keys(otherMeta).length > 0
      ? { meta: otherMeta }
      : {}),
    ...(projection && projection.length > 0
      ? { projection_applied: projection }
      : {}),
    ...(truncated ? { truncated: true } : {}),
    ...(hint ? { hint } : {}),
    ...(omittedFields ? { omitted_fields: omittedFields } : {}),
    ...(notices.length > 0 ? { notices } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  const lines = [
    `${op.method} ${path} · ${op.operationId} ${JSON.stringify(built.params)}`,
    `→ ${summarize(value)}` +
      (pagination
        ? ` (page ${pagination.page}` +
          (pagination.total !== null ? ` of ${pagination.total} in all` : '') +
          ')'
        : listCounts && listCounts.returned < listCounts.received
          ? ` of ${listCounts.received}`
          : ''),
  ];
  if (nextParams) {
    lines.push(
      `More: call \`${op.operationId}\` again with params ${JSON.stringify(nextParams)}.`
    );
  } else if (pagination && !pagination.has_more) {
    lines.push('Last page.');
  }
  if (projection && projection.length > 0) {
    lines.push(`Fields projected to: ${projection.join(', ')}.`);
  }
  if (hint) lines.push(hint);
  if (omittedFields) {
    lines.push(
      `Fields left out to fit the budget: ${omittedFields.join(', ')}.`
    );
  }
  for (const notice of notices) lines.push(notice);
  for (const warning of warnings) lines.push(warning);

  // The payload is echoed inside the fence, never as a line of our own summary.
  // `untrustedBlock` cleans it a second time, which is what makes the fence
  // hold: a value that forged `<<<END UNTRUSTED>>>` cannot close it.
  const block =
    untrustedBlock(textRows(label, value), {
      maxChars: PAYLOAD_BUDGET_CHARS,
    }) ?? '(the API returned no content)';
  lines.push('', block);

  return { text: lines.join('\n'), structuredContent };
}
