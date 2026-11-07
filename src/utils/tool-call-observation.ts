/**
 * What one `tools/call` did on its way to its result, for the `tool_call` log.
 *
 * Tool handlers turn their failures into `isError` results before the registry
 * sees them (`withErrorHandling`), which leaves the registry with a result and
 * no cause. This module is the side channel that keeps the cause: the upstream
 * HTTP layer notes the status of every Altegio response, and the shared error
 * base classes note themselves when they are constructed. The registry opens
 * one observation per call and reads it back only to classify a failure.
 *
 * It is a leaf module on purpose — no imports — so the error classes and the
 * HTTP client can depend on it without an import cycle. Nothing here is ever
 * logged as-is: the registry emits only fixed diagnostics and counts.
 *
 * One field travels the other way: `correlation`, the registry's own
 * value-free fields for the call (request, route, session, client), so a tool
 * that writes an event of its own — `feedback_submit` — writes it joinable to
 * the `tool_call` line of the same call.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** Why an upstream request failed during admission, transport or body reading. */
export type UpstreamFailure = 'timeout' | 'network' | 'cancelled';

export type UpstreamPhase = 'admission' | 'headers' | 'body' | 'retry_wait';

export interface UpstreamFailureDetail {
  phase: UpstreamPhase;
  method: string;
  route: string;
}

/**
 * Which argument failed validation and how, for the `tool_call` log: a schema
 * issue code and the argument path, plus the names of arguments the tool does
 * not take. Never a value.
 */
export interface ValidationIssue {
  code: string;
  /** Dotted argument path; empty for the arguments object itself. */
  path: string;
  /** Unrecognized argument names (sanitized), for `unrecognized_keys`. */
  keys?: string[];
}

export interface ToolCallObservation {
  /** Upstream requests that returned a response, whatever its status. */
  upstreamResponses: number;
  /** The most recent upstream status of 400 or above, if any. */
  upstreamErrorStatus?: number;
  /** The most recent upstream failure, including a failed response body. */
  upstreamFailure?: UpstreamFailure;
  upstreamFailureDetail?: UpstreamFailureDetail;
  upstreamRequests?: number;
  /** Fixed parser reason codes only; never report labels, cells or source text. */
  cashFlowParseReason?: string;
  /** The most recent typed error constructed during the call. */
  lastError?: Error;
  /** The issues of the most recent argument validation that failed. */
  validationIssues?: ValidationIssue[];
  /** The registry's correlation fields for this call, set before it runs. */
  correlation?: Readonly<Record<string, unknown>>;
  /** The call failed on an error no typed class describes: a likely defect. */
  unexpectedError?: boolean;
  /** The call was refused by a rate limit, before doing its work. */
  rateLimited?: boolean;
  /** The first page was served at the tool's page size ceiling, below the size asked. */
  pageSizeCapped?: boolean;
  /** Upstream requests sent again after a failed attempt. */
  upstreamRetries?: number;
}

/** Bounds on what one call may add to its log line. */
const MAX_ISSUES = 5;
const MAX_KEYS = 5;
const MAX_DEPTH = 6;
/** A code or a name a log line may carry; anything else is masked. */
const LOG_TOKEN = /^[A-Za-z0-9_]{1,64}$/;

function logToken(value: unknown): string {
  return typeof value === 'string' && LOG_TOKEN.test(value) ? value : '?';
}

/** `a.0.b`: names as tokens, indexes as numbers, anything else masked. */
function logPath(path: readonly unknown[]): string {
  const segments = path
    .slice(0, MAX_DEPTH)
    .map((segment) =>
      typeof segment === 'number' && Number.isInteger(segment)
        ? String(segment)
        : logToken(segment)
    );
  if (path.length > MAX_DEPTH) segments.push('…');
  return segments.join('.');
}

const storage = new AsyncLocalStorage<ToolCallObservation>();

/** A fresh, empty observation for one tool call. */
export function createToolCallObservation(): ToolCallObservation {
  return { upstreamResponses: 0 };
}

/**
 * Run `fn` with `observation` bound. The caller keeps the object, so it can
 * still read what happened when `fn` throws.
 */
export function runObservingToolCall<T>(
  observation: ToolCallObservation,
  fn: () => T
): T {
  return storage.run(observation, fn);
}

/** Note one upstream HTTP response. A no-op outside a tool call. */
export function noteUpstreamResponse(status: number, terminal = true): void {
  const observation = storage.getStore();
  if (!observation) return;
  observation.upstreamResponses += 1;
  if (terminal && status >= 400) observation.upstreamErrorStatus = status;
}

/** Note that a first page was served below the page size asked for. */
export function notePageSizeCapped(): void {
  const observation = storage.getStore();
  if (observation) observation.pageSizeCapped = true;
}

/** Note that an upstream request is sent again after a failed attempt. */
export function noteUpstreamRetry(): void {
  const observation = storage.getStore();
  if (observation) {
    observation.upstreamRetries = (observation.upstreamRetries ?? 0) + 1;
  }
}

/** Count one HTTP attempt immediately before invoking fetch. */
export function noteUpstreamRequest(): void {
  const observation = storage.getStore();
  if (observation)
    observation.upstreamRequests = (observation.upstreamRequests ?? 0) + 1;
}

/** Capture the owning call: body callbacks can run in another async context. */
export function upstreamFailureRecorder(endpoint: string, method = 'GET') {
  const observation = storage.getStore();
  const verb = method.toUpperCase();
  const safeMethod = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(verb)
    ? verb
    : 'other';
  const path = endpoint.split('?')[0];
  // Emit literal templates only. Unrecognized paths never enter diagnostics.
  const route = /^\/locations\/\d+\/appointments\/\d+\/?$/.test(path ?? '')
    ? '/locations/{location_id}/appointments/{appointment_id}'
    : /^\/locations\/\d+\/appointments\/?$/.test(path ?? '')
      ? '/locations/{location_id}/appointments'
      : /^\/record\/\d+\/\d+\/?$/.test(path ?? '')
        ? '/record/{location_id}/{appointment_id}'
        : /^\/finances_reports\/account_period_search\/\d+\/$/.test(path ?? '')
          ? '/finances_reports/account_period_search/{location_id}/'
          : 'other';
  return (error: unknown, phase: UpstreamPhase, cancelled = false): void => {
    if (!observation) return;
    observation.upstreamFailure =
      cancelled ||
      ((error instanceof Error || error instanceof DOMException) &&
        error.name === 'AbortError')
        ? 'cancelled'
        : isTimeout(error)
          ? 'timeout'
          : 'network';
    observation.upstreamFailureDetail = { phase, method: safeMethod, route };
  };
}

const CASH_FLOW_PARSE_REASONS: Readonly<Record<string, string>> = {
  'authentication was required': 'authentication_required',
  'expected a JSON search envelope': 'invalid_json_envelope',
  'empty search envelope': 'empty_envelope',
  'the report rejected its filters': 'filters_rejected',
  'missing HTML content': 'missing_html',
  'invalid result count': 'invalid_count',
  'headers missing': 'headers_missing',
  'inconsistent account columns': 'account_column_count',
  'account-type columns changed': 'account_type_columns',
  'account ordering changed': 'account_order',
  'unexpected or partial continuation row': 'continuation_row',
  'unexpected aggregate': 'unexpected_aggregate',
  'partial data row': 'partial_data_row',
  'partial single-type row': 'partial_single_type_row',
  'total missing': 'total_missing',
  'aggregates missing': 'aggregates_missing',
};

export function noteCashFlowParseFailure(detail: string): void {
  const observation = storage.getStore();
  if (observation)
    observation.cashFlowParseReason = Object.hasOwn(
      CASH_FLOW_PARSE_REASONS,
      detail
    )
      ? CASH_FLOW_PARSE_REASONS[detail]
      : 'other';
}

/**
 * Note why arguments failed validation, reduced to codes, paths and argument
 * names (`ValidationIssue`). Takes the structural shape of a schema issue, so
 * this module stays free of the schema library. A no-op outside a tool call.
 */
export function noteValidationIssues(issues: readonly SchemaIssue[]): void {
  const observation = storage.getStore();
  if (observation) observation.validationIssues = summarizeIssues(issues);
}

/** The structural shape of a schema issue that the log reduces. */
export interface SchemaIssue {
  code?: unknown;
  path?: readonly unknown[];
  keys?: readonly unknown[];
}

/** Schema issues as the log may carry them: bounded, value-free. */
export function summarizeIssues(
  issues: readonly SchemaIssue[]
): ValidationIssue[] {
  return issues.slice(0, MAX_ISSUES).map((issue) => {
    const keys = Array.isArray(issue.keys)
      ? issue.keys.slice(0, MAX_KEYS).map(logToken)
      : undefined;
    return {
      code: logToken(issue.code),
      path: logPath(issue.path ?? []),
      ...(keys && keys.length > 0 ? { keys } : {}),
    };
  });
}

/**
 * The correlation fields of the tool call in progress: the same request,
 * route, transport, session and client fields its `tool_call` line carries.
 * Empty outside a tool call.
 */
export function currentCallCorrelation(): Readonly<Record<string, unknown>> {
  return storage.getStore()?.correlation ?? {};
}

/** Note that an untyped error ended the call. A no-op outside a tool call. */
export function noteUnexpectedError(): void {
  const observation = storage.getStore();
  if (observation) observation.unexpectedError = true;
}

/** Note that a rate limit refused the call. A no-op outside a tool call. */
export function noteRateLimited(): void {
  const observation = storage.getStore();
  if (observation) observation.rateLimited = true;
}

/** Note a typed error at construction. A no-op outside a tool call. */
export function noteError(error: Error): void {
  const observation = storage.getStore();
  if (observation) observation.lastError = error;
}

/** A fetch or abort timeout, by error name or undici's cause code. */
export function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error || error instanceof DOMException)) return false;
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return true;
  const cause = (error as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === 'string' && cause.code.includes('TIMEOUT');
}
