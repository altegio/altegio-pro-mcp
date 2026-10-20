import { ZodError } from 'zod';
import { createLogger, logSafeToken, sessionLogId } from '../utils/logger.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import { AltegioClient } from '../providers/altegio-client.js';
import { OnboardingHandlers } from './onboarding-handlers.js';
import { OnboardingStateManager } from '../providers/onboarding-state-manager.js';
import { orderedToolEntries, servedDefinedTools } from './inventory.js';
import {
  buildFacetIndex,
  facetToolsFromSpecs,
  readOnlyRefusalMessage,
  viewUrl,
  DEFAULT_FACET,
  READONLY_VIEW,
  type FacetKey,
  type FacetIndex,
} from './facets.js';
import type { ToolResult } from './tool-result.js';
import {
  requireConfirmation,
  type ConfirmationAnswer,
  type ConfirmationRuntime,
  type ConfirmedCall,
  type PreparedConfirmation,
} from './confirmation.js';
import {
  onboardingConfirmations,
  onboardingTools,
} from './onboarding-registry.js';
import {
  getRequestScopes,
  requestContextFromHeaders,
  runWithContext,
} from '../request-context.js';
import { DEFAULT_PUBLIC_BASE_URL } from '../config/schema.js';
import {
  checkToolScopes,
  requiredScopesFor,
  type ToolScope,
} from './scopes.js';
import { listedOnView, runOnView, type ServingView } from './serving-view.js';
import {
  legacyAliasTargets,
  translateLegacyArguments,
} from './legacy-aliases.js';
import { getOperation } from './executor/catalog.js';
import {
  FEEDBACK_NUDGE,
  submitFeedbackTool,
} from './definitions/feedback.tools.js';
import {
  AltegioApiError,
  AuthenticationError,
  ExecutorRefusalError,
  InvalidParamsError,
} from '../utils/errors.js';
import {
  createToolCallObservation,
  isTimeout,
  runObservingToolCall,
  summarizeIssues,
  type ToolCallObservation,
  type ValidationIssue,
} from '../utils/tool-call-observation.js';

type CallHandler = (
  args: unknown,
  confirmation?: ConfirmedCall
) => Promise<ToolResult>;

/** A tool's confirmation spec bound to raw arguments (see `./confirmation.ts`). */
type PrepareConfirmation = (args: unknown) => PreparedConfirmation | undefined;

export interface RegisterToolsOptions {
  /** Which static view to serve. Defaults to the full default view. */
  readonly facet?: FacetKey;
  /** Drop the onboarding walkthrough from the default view (config switch). */
  readonly excludeOnboardingFromDefault?: boolean;
  /**
   * Admit the email + password login tools to the HTTP views (config switch).
   * Off by default; the unfiltered `all` view stdio uses always has them.
   */
  readonly exposePasswordLogin?: boolean;
  /**
   * Public base URL this deployment is reached at, used to name the complete
   * surface in the read-only view's refusal. Defaults to the published public
   * endpoint (`MCP_PUBLIC_BASE_URL`).
   */
  readonly publicBaseUrl?: string;
}

/**
 * The tool inventory and its `tools/list` order live in `./inventory.ts`, the
 * one module that enumerates the surface; re-exported here because that is
 * where callers have always imported it from.
 */
export { orderedToolEntries, type ToolEntry } from './inventory.js';

/**
 * Absolute addresses of this endpoint's views that serve a tool the current
 * view does not: the named facets first, then the complete surface. Absolute,
 * because a relative /mcp/<view> is wrong on the short customer address, where
 * /pro/mcp/… is the internal lane.
 */
function addressesServing(
  name: string,
  index: FacetIndex,
  publicBaseUrl: string
): string[] {
  return [
    ...index.facetsProviding(name).map((f) => viewUrl(publicBaseUrl, f)),
    // Only offer the complete surface when it actually serves the tool: a tool
    // withheld from the default view (access management, password login) must
    // not be advertised back to the caller as available one path up.
    ...(index.includes(DEFAULT_FACET, name)
      ? [viewUrl(publicBaseUrl, DEFAULT_FACET)]
      : []),
  ];
}

function outOfFacetError(
  name: string,
  facet: FacetKey,
  index: FacetIndex,
  publicBaseUrl: string
): McpError {
  // The read-only view refuses on policy, not on context budget, so it gets a
  // message a model can act on rather than a pointer to a sibling facet.
  if (facet === READONLY_VIEW) {
    return new McpError(
      ErrorCode.MethodNotFound,
      readOnlyRefusalMessage(name, publicBaseUrl)
    );
  }

  const paths = addressesServing(name, index, publicBaseUrl);
  const where =
    paths.length > 0
      ? ` Reach it on ${paths.join(' or ')}.`
      : ' This deployment does not serve it.';
  return new McpError(
    ErrorCode.MethodNotFound,
    `Tool "${name}" is not served by the "${facet}" view of this endpoint.${where}`
  );
}

/**
 * Bind the confirmation gate to one MCP request.
 *
 * `relatedRequestId` ties the prompt to the tool call that triggered it, which
 * is what routes it back to the right session on Streamable HTTP.
 *
 * The capability check is the point of this function: `elicitInput` throws
 * synchronously on a client that never declared elicitation, and a host that
 * silently ignores the request would otherwise leave the tool call hanging.
 */
function confirmationRuntime(
  server: Server,
  relatedRequestId: RequestId
): ConfirmationRuntime {
  return {
    supportsElicitation: () =>
      Boolean(server.getClientCapabilities()?.elicitation?.form),

    elicit: async (message): Promise<ConfirmationAnswer> => {
      const result = await server.elicitInput(
        {
          mode: 'form',
          message,
          // This is a confirmation, with no data to collect. MCP's action
          // already expresses consent; a second decision field makes hosts
          // reject an otherwise explicit accept or display two choices.
          requestedSchema: { type: 'object', properties: {} },
        },
        { relatedRequestId }
      );
      return result.action;
    },
  };
}

/** Why a tool call did not succeed, as the `tool_call` log reports it. */
export type ToolErrorClass =
  | 'validation'
  | 'upstream_4xx'
  | 'upstream_5xx'
  | 'auth'
  | 'scope_denied'
  | 'out_of_view'
  | 'confirmation_required'
  | 'unknown_tool'
  | 'timeout'
  | 'rate_limited'
  | 'internal';

/** A name a reply or a log line may repeat: nothing else a caller sent is. */
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/** The answer to a tool name this server does not define. */
function unknownToolResult(
  requested: string,
  targets: readonly string[] | undefined,
  servingView: ServingView
): ToolResult {
  let text: string;
  if (targets) {
    const named = targets.map((target) => {
      if (servingView.serves(target)) return `\`${target}\``;
      const where = servingView.addressesServing(target);
      return where.length > 0
        ? `\`${target}\` (served on ${where.join(' or ')})`
        : `\`${target}\``;
    });
    text =
      `\`${requested}\` is a former tool name. Call ${named.join(' or ')} ` +
      'instead, with the arguments its current input schema defines ' +
      '(refresh the tool list with tools/list).';
  } else {
    const name = SAFE_TOOL_NAME.test(requested) ? ` "${requested}"` : '';
    text =
      `This server has no tool${name}. Refresh the tool list with ` +
      'tools/list and call one of the tools it returns.';
  }
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * The answer to a former tool name whose arguments, translated to its
 * replacement's names, still do not fit: what to change, in the replacement's
 * argument names only. An argument the replacement does not take is counted,
 * never named — it is caller text, not one of our fixed strings.
 */
function legacyArgumentsResult(
  requested: string,
  target: string,
  issues: ZodError['issues']
): ToolResult {
  const problems: string[] = [];
  let unknown = 0;
  for (const issue of issues) {
    if (issue.code === 'unrecognized_keys') {
      unknown += issue.keys.length;
    } else if (
      issue.code === 'too_big' &&
      issue.path.length === 1 &&
      issue.path[0] === 'page_size' &&
      typeof issue.maximum === 'number'
    ) {
      problems.push(
        `page_size is at most ${issue.maximum}; follow pagination.next_page with pagination.page_size to read the rest`
      );
    } else {
      const [key] = issue.path;
      problems.push(
        typeof key === 'string' && SAFE_TOOL_NAME.test(key)
          ? `\`${key}\`: ${issue.message}`
          : issue.message
      );
    }
  }
  if (unknown > 0) {
    problems.push(
      `${unknown} argument${unknown === 1 ? '' : 's'} it does not take`
    );
  }
  const text =
    `\`${requested}\` is a former tool name for \`${target}\`, and its ` +
    `arguments do not fit \`${target}\`: ${problems.slice(0, 5).join('; ')}. ` +
    `Call \`${target}\` with the arguments its current input schema defines ` +
    '(refresh the tool list with tools/list).';
  return { content: [{ type: 'text', text }], isError: true };
}

/**
 * Whether a failed call should point the agent at `feedback_submit`: the API
 * answered 5xx, or an error no typed class describes ended it — the failures
 * that look like a defect. Validation, access and transient failures do not:
 * the agent recovers from those itself, and a nudge on every error would
 * flood the reports with its own mistakes.
 */
function invitesFeedback(
  tool: string,
  observation: ToolCallObservation,
  failed: { error_class: ToolErrorClass; upstream_status?: number }
): boolean {
  if (tool === submitFeedbackTool.meta.name) return false;
  if (failed.error_class === 'upstream_5xx') {
    return failed.upstream_status !== undefined;
  }
  return (
    failed.error_class === 'internal' && observation.unexpectedError === true
  );
}

/** UTF-8 bytes of what a result carries: text blocks plus structured content. */
function resultBytes(result: ToolResult): number {
  let bytes = 0;
  try {
    for (const block of result.content ?? []) {
      bytes += Buffer.byteLength(
        block.type === 'text' ? block.text : JSON.stringify(block)
      );
    }
    if (result.structuredContent !== undefined) {
      bytes += Buffer.byteLength(
        JSON.stringify(result.structuredContent) ?? ''
      );
    }
  } catch {
    // A result that cannot be serialized fails in the SDK, not in the log.
  }
  return bytes;
}

/**
 * Classify a failed call from what it did: the upstream statuses and the
 * typed errors noted while it ran (`../utils/tool-call-observation.ts`), the
 * thrown error if there was one, and — only when nothing upstream explains
 * it — whether the arguments validate and whether the caller is signed in.
 */
function classifyFailure(
  observation: ToolCallObservation,
  thrown: unknown,
  argsInvalid: () => boolean,
  unauthenticated: () => boolean
): { error_class: ToolErrorClass; upstream_status?: number } {
  if (observation.rateLimited) return { error_class: 'rate_limited' };
  const cause = thrown ?? observation.lastError;
  const status = observation.upstreamErrorStatus;
  if (observation.upstreamFailure === 'timeout' || isTimeout(cause)) {
    return { error_class: 'timeout' };
  }
  if (status !== undefined) {
    return {
      error_class:
        status === 401
          ? 'auth'
          : status >= 500
            ? 'upstream_5xx'
            : 'upstream_4xx',
      upstream_status: status,
    };
  }
  if (cause instanceof AuthenticationError) return { error_class: 'auth' };
  // The API was unreachable: no status, but the failure is upstream's.
  if (observation.upstreamFailure === 'network') {
    return { error_class: 'upstream_5xx' };
  }
  if (
    cause instanceof ZodError ||
    cause instanceof ExecutorRefusalError ||
    cause instanceof InvalidParamsError ||
    (cause instanceof McpError && cause.code === ErrorCode.InvalidParams) ||
    argsInvalid()
  ) {
    return { error_class: 'validation' };
  }
  // Raised locally, before any request: the declared company scope (403), or
  // a precondition the arguments did not meet.
  if (cause instanceof AltegioApiError && cause.statusCode !== undefined) {
    if (cause.statusCode === 403) return { error_class: 'scope_denied' };
    if (cause.statusCode >= 400 && cause.statusCode < 500) {
      return { error_class: 'validation' };
    }
  }
  if (unauthenticated()) return { error_class: 'auth' };
  return { error_class: 'internal' };
}

/**
 * Which arguments failed validation, for the `tool_call` log: the issues the
 * handler noted, the thrown schema error's, an executor refusal's reason and
 * parameter names, or — when nothing was noted — the tool's own validation
 * re-run. Codes, paths and argument names only, never values.
 */
function validationIssuesOf(
  observation: ToolCallObservation,
  thrown: unknown,
  inputIssues: () => ZodError['issues'] | undefined
): ValidationIssue[] | undefined {
  if (observation.validationIssues) return observation.validationIssues;
  if (thrown instanceof ZodError) return summarizeIssues(thrown.issues);
  const cause = thrown ?? observation.lastError;
  if (cause instanceof ExecutorRefusalError) {
    const data = (cause.data ?? {}) as Record<string, unknown>;
    const keys = [data.fields, data.missing].find(Array.isArray);
    return summarizeIssues([
      {
        code: typeof data.reason === 'string' ? data.reason : 'refused',
        path: [],
        ...(keys ? { keys } : {}),
      },
    ]);
  }
  const issues = inputIssues();
  return issues ? summarizeIssues(issues) : undefined;
}

/** `name/version` from the first product of a User-Agent header. */
function userAgentProduct(value: unknown): {
  name?: string;
  version?: string;
} {
  if (typeof value !== 'string') return {};
  const [product = ''] = value.trim().split(/\s+/, 1);
  const [name, version] = product.split('/', 2);
  return { name: logSafeToken(name), version: logSafeToken(version) };
}

export function registerTools(
  server: Server,
  client: AltegioClient,
  options: RegisterToolsOptions = {}
): string[] {
  // Factory-defined CRUD tools (auth, location, team members, positions,
  // services, categories, schedules, appointments) — discovered from
  // ./definitions.
  const factoryTools = servedDefinedTools();
  const handlers = new Map<string, CallHandler>(
    factoryTools.map((tool) => [tool.meta.name, tool.createHandler(client)])
  );
  // Input validation as each handler runs it, for resolving a legacy alias and
  // for telling a validation failure from other failures in the tool_call log.
  const inputIssuesOf = new Map(
    factoryTools.map((tool) => [tool.meta.name, tool.inputIssues])
  );

  // Destructive tools that require a human confirmation before they run. The
  // gate is enforced here and nowhere else: this is the only code path that
  // has both the MCP `Server` (to send `elicitation/create`) and the id of the
  // request the prompt has to be related to. Factory tools declare it as
  // `confirm` on the definition; the onboarding wizard keeps hand-written
  // specs and declares it alongside them.
  const confirmations = new Map<string, PrepareConfirmation>(
    Object.entries(onboardingConfirmations)
  );
  for (const tool of factoryTools) {
    if (tool.prepareConfirmation) {
      confirmations.set(tool.meta.name, tool.prepareConfirmation);
    }
  }

  // What each tool's execution requires of the caller's token (ADR-001 D7
  // keeps this out of `tools/list` — see ./scopes.ts). Factory tools carry the
  // requirement on their definition, where the factory filled it in from the
  // map; the hand-written onboarding specs are looked up by name in the same
  // map, so both come from one source.
  const requiredScopes = new Map<string, readonly ToolScope[]>(
    onboardingTools.map((spec) => [spec.name, requiredScopesFor(spec.name)])
  );
  for (const tool of factoryTools) {
    requiredScopes.set(tool.meta.name, tool.meta.requiredScopes ?? []);
  }

  // Onboarding wizard — stateful subsystem kept in its own registry/handlers.
  const stateManager = new OnboardingStateManager();
  const onboarding = new OnboardingHandlers(client, stateManager);
  const onboardingDispatch: Record<string, CallHandler> = {
    onboarding_start: (args) => onboarding.start(args),
    onboarding_resume: (args) => onboarding.resume(args),
    onboarding_status: (args) => onboarding.status(args),
    onboarding_add_positions: (args) => onboarding.addPositions(args),
    onboarding_set_schedules: (args) => onboarding.setSchedules(args),
    onboarding_add_team_members_batch: (args) => onboarding.addStaffBatch(args),
    onboarding_add_services_batch: (args) => onboarding.addServicesBatch(args),
    onboarding_add_categories: (args) => onboarding.addCategories(args),
    onboarding_import_clients: (args) => onboarding.importClients(args),
    onboarding_create_test_appointments: (args) =>
      onboarding.createTestBookings(args),
    onboarding_preview_data: (args) => onboarding.previewData(args),
    onboarding_rollback_phase: (args) => onboarding.rollbackPhase(args),
  };

  // One deterministic order for every view, computed once at startup.
  const entries = orderedToolEntries();
  const facetIndex = buildFacetIndex(
    facetToolsFromSpecs(entries.map((entry) => entry.spec)),
    {
      excludeOnboardingFromDefault: options.excludeOnboardingFromDefault,
      exposePasswordLogin: options.exposePasswordLogin,
    }
  );
  const facet = options.facet ?? DEFAULT_FACET;
  const publicBaseUrl = options.publicBaseUrl ?? DEFAULT_PUBLIC_BASE_URL;
  const visible = new Set(facetIndex.members(facet));
  // What a reply or a description may name as callable here
  // (`./serving-view.ts`).
  const servingView: ServingView = {
    serves: (name) => visible.has(name),
    addressesServing: (name) =>
      addressesServing(name, facetIndex, publicBaseUrl),
  };
  const toolNames = entries.map((entry) => entry.spec.name);
  const visibleToolDefs = entries
    .filter((entry) => visible.has(entry.spec.name))
    .map((entry) => listedOnView(entry.spec, servingView, toolNames));

  // list handler — the same list for every connection to this facet
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleToolDefs,
  }));

  // Own keys only: a name such as `constructor` is not a tool.
  const handlerFor = (name: string): CallHandler | undefined =>
    handlers.get(name) ??
    (Object.hasOwn(onboardingDispatch, name)
      ? onboardingDispatch[name]
      : undefined);

  // call handler
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name: requested, arguments: args } = request.params;
    // What the tool_call log reports about this call, filled in as it runs.
    const call: {
      tool: string;
      alias?: string;
      errorClass?: ToolErrorClass;
      validation?: ValidationIssue[];
      confirmation?: boolean;
    } = { tool: 'unknown' };
    // The arguments the tool runs with: a former name's, translated.
    let callArgs = args;

    const execute = async (): Promise<ToolResult> => {
      let name = requested;
      let handler = handlerFor(name);
      let aliasIssues: ZodError['issues'] | undefined;
      if (!handler) {
        // A former name (`./legacy-aliases.ts`) runs as its one replacement,
        // with its former argument names translated; anything else is
        // answered in band, so the model reads which tool to call instead of
        // a protocol error.
        const targets = legacyAliasTargets(requested);
        if (targets) call.alias = requested;
        const target = targets?.length === 1 ? targets[0] : undefined;
        handler = target === undefined ? undefined : handlerFor(target);
        if (target === undefined || !handler) {
          call.errorClass = 'unknown_tool';
          return unknownToolResult(requested, targets, servingView);
        }
        name = target;
        callArgs = translateLegacyArguments(requested, args) as typeof args;
        aliasIssues = inputIssuesOf.get(target)?.(callArgs);
      }
      call.tool = name;
      if (!visible.has(name)) {
        call.errorClass = 'out_of_view';
        throw outOfFacetError(name, facet, facetIndex, publicBaseUrl);
      }
      if (aliasIssues) {
        call.errorClass = 'validation';
        call.validation = summarizeIssues(aliasIssues);
        return legacyArgumentsResult(requested, name, aliasIssues);
      }

      // Scope check before anything else the call does. It precedes the
      // confirmation gate on purpose: a call the token cannot authorise must
      // not prompt a human, and must not make the API read that resolves the
      // prompt's target. A caller with no declared scopes — every deployment
      // today — passes straight through.
      const denial = checkToolScopes({
        toolName: name,
        required: requiredScopes.get(name) ?? [],
        granted: getRequestScopes(),
      });
      if (denial) {
        call.errorClass = 'scope_denied';
        return denial;
      }

      // Destructive operations stop here until a human says yes. `stop` is
      // the result the caller gets instead of the operation being performed —
      // logged as `confirmation_required` whatever shape that result takes;
      // `proceed` carries the confirmation into the handler (the version the
      // person was shown, the idempotency key).
      const prepared = confirmations.get(name)?.(callArgs);
      let confirmed: ConfirmedCall | undefined;
      if (prepared) {
        const gate = await requireConfirmation({
          toolName: name,
          args: callArgs,
          prepared,
          client,
          runtime: confirmationRuntime(server, extra.requestId),
        });
        if ('stop' in gate) {
          call.confirmation = true;
          return gate.stop;
        }
        confirmed = gate.proceed;
      }

      return handler(callArgs, confirmed);
    };

    // The SDK deliberately schedules protocol handlers on a later promise turn.
    // In the compiled ESM server that turn is outside the AsyncLocalStorage
    // scope surrounding transport.handleRequest(), even though the source-level
    // Jest transform happens to retain it. Re-bind from the SDK's immutable copy
    // of the original HTTP headers at the actual tool-handler boundary. Stdio
    // has no requestInfo and keeps its existing single-user context.
    const headers = extra.requestInfo?.headers;
    const onView = async () => {
      const started = performance.now();
      const observation = createToolCallObservation();
      // `clientInfo` from initialize; a stateless request has none.
      const clientInfo =
        typeof server.getClientVersion === 'function'
          ? server.getClientVersion()
          : undefined;
      const agent = clientInfo ? {} : userAgentProduct(headers?.['user-agent']);
      // What ties this call's log lines together, and to the proxy's: also
      // handed to a tool that writes an event of its own (`feedback_submit`).
      observation.correlation = {
        request_id: headers?.['x-request-id'],
        route: `/mcp${facet === DEFAULT_FACET ? '' : '/' + facet}`,
        transport: headers
          ? extra.sessionId
            ? 'session'
            : 'stateless'
          : 'stdio',
        ...(extra.sessionId ? { session: sessionLogId(extra.sessionId) } : {}),
        client_name: logSafeToken(clientInfo?.name) ?? agent.name,
        client_version: logSafeToken(clientInfo?.version) ?? agent.version,
      };
      // Counts, classes and validated names only: never arguments or text.
      const fields = () => {
        const operationId =
          call.tool === 'api_call_operation' &&
          callArgs &&
          typeof callArgs.operation_id === 'string' &&
          getOperation(callArgs.operation_id)
            ? callArgs.operation_id
            : undefined;
        return {
          event: 'tool_call',
          ...observation.correlation,
          rpc_method: 'tools/call',
          tool: call.tool,
          ...(call.alias ? { alias: call.alias } : {}),
          ...(call.tool === 'unknown' &&
          !call.alias &&
          SAFE_TOOL_NAME.test(requested)
            ? { requested_tool: requested }
            : {}),
          ...(operationId ? { operation_id: operationId } : {}),
        };
      };
      const inputIssues = () => inputIssuesOf.get(call.tool)?.(callArgs);
      const failure = (thrown?: unknown) => {
        const classified = call.errorClass
          ? { error_class: call.errorClass }
          : classifyFailure(
              observation,
              thrown,
              () => inputIssues() !== undefined,
              () => {
                try {
                  return client.isAuthenticated?.() === false;
                } catch {
                  return false;
                }
              }
            );
        if (classified.error_class !== 'validation') return classified;
        const issues =
          call.validation ??
          validationIssuesOf(observation, thrown, inputIssues);
        return issues && issues.length > 0
          ? { ...classified, validation_issues: issues }
          : classified;
      };
      const log = createLogger('tool-calls');
      try {
        const completed = await runObservingToolCall(observation, () =>
          runOnView(servingView, execute)
        );
        const outcome = call.confirmation
          ? 'confirmation_required'
          : completed.isError
            ? 'error'
            : 'success';
        const failed = outcome === 'error' ? failure() : undefined;
        const result =
          failed && invitesFeedback(call.tool, observation, failed)
            ? {
                ...completed,
                content: [
                  ...completed.content,
                  { type: 'text' as const, text: FEEDBACK_NUDGE },
                ],
              }
            : completed;
        log.info(
          {
            ...fields(),
            outcome,
            ...(outcome === 'confirmation_required'
              ? { error_class: 'confirmation_required' }
              : {}),
            ...(failed ? { error_type: 'tool_result', ...failed } : {}),
            ...(result !== completed ? { feedback_nudge: true } : {}),
            response_bytes: resultBytes(result),
            latency_ms: Math.round(performance.now() - started),
          },
          'Tool completed'
        );
        return result;
      } catch (error) {
        log.error(
          {
            ...fields(),
            outcome: 'error',
            error_type: error instanceof Error ? error.name : 'unknown',
            ...failure(error),
            latency_ms: Math.round(performance.now() - started),
          },
          'Tool failed'
        );
        throw error;
      }
    };
    return headers
      ? runWithContext(requestContextFromHeaders(headers), onView)
      : onView();
  });

  return visibleToolDefs.map((tool) => tool.name);
}
