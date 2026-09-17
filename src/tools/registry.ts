import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
  type ElicitRequestFormParams,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import { AltegioClient } from '../providers/altegio-client.js';
import { OnboardingHandlers } from './onboarding-handlers.js';
import { OnboardingStateManager } from '../providers/onboarding-state-manager.js';
import * as definitions from './definitions/index.js';
import { isToolDisabled } from './disabled-tools.js';
import {
  buildFacetIndex,
  DEFAULT_FACET,
  type FacetKey,
  type FacetIndex,
} from './facets.js';
import type { DefinedTool, McpToolSpec } from './factory.js';
import type { ToolResult } from './tool-result.js';
import {
  requireConfirmation,
  type ConfirmationAnswer,
  type ConfirmationRuntime,
  type PreparedConfirmation,
} from './confirmation.js';
import {
  onboardingConfirmations,
  onboardingTools,
} from './onboarding-registry.js';
import {
  requestContextFromHeaders,
  runWithContext,
} from '../request-context.js';

type CallHandler = (args: unknown) => Promise<ToolResult>;

/** A tool's confirmation spec bound to raw arguments (see `./confirmation.ts`). */
type PrepareConfirmation = (args: unknown) => PreparedConfirmation | undefined;

/** A tool spec plus the category that orders it in `tools/list`. */
interface ToolEntry {
  readonly spec: McpToolSpec;
  readonly category: string;
}

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
}

/**
 * Auto-discover every `DefinedTool` exported from the definitions barrel, minus
 * the ones withheld from every view (see `./disabled-tools.ts`).
 */
function collectDefinedTools(): DefinedTool[] {
  return (Object.values(definitions) as unknown[])
    .filter(
      (v): v is DefinedTool =>
        !!v &&
        typeof v === 'object' &&
        'toMcpTool' in v &&
        'createHandler' in v &&
        'meta' in v
    )
    .filter((tool) => !isToolDisabled(tool.meta.name));
}

/**
 * Total order over tools: category first, then name — both compared as plain
 * code-unit strings so the result never depends on the host's locale. A
 * deterministic `tools/list` is required by MCP 2026-07-28 (ADR-001 D7) and
 * makes tool-surface changes readable in a diff.
 */
function compareToolEntries(a: ToolEntry, b: ToolEntry): number {
  if (a.category !== b.category) {
    return a.category < b.category ? -1 : 1;
  }
  if (a.spec.name !== b.spec.name) {
    return a.spec.name < b.spec.name ? -1 : 1;
  }
  return 0;
}

/** Build the ordered tool list exactly as `tools/list` returns it. */
export function orderedToolEntries(): ToolEntry[] {
  const factoryTools = collectDefinedTools().map((tool) => ({
    spec: tool.toMcpTool(),
    category: tool.meta.category,
  }));
  // The onboarding wizard keeps hand-written specs; they all share one category.
  const onboardingEntries = onboardingTools.map((spec) => ({
    spec,
    category: 'Onboarding',
  }));
  return [...factoryTools, ...onboardingEntries].sort(compareToolEntries);
}

function outOfFacetError(
  name: string,
  facet: FacetKey,
  index: FacetIndex
): McpError {
  const elsewhere = index.facetsProviding(name);
  const paths = [
    ...elsewhere.map((f) => `/mcp/${f}`),
    // Only offer /mcp when /mcp actually serves it: a tool withheld from the
    // default view (access management, password login) must not be advertised
    // back to the caller as available one path up.
    ...(index.includes(DEFAULT_FACET, name) ? ['/mcp'] : []),
  ];
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
 * The elicitation form the operator sees. A single required enum, with no
 * default, so nothing can be auto-filled into an approval: the server treats
 * only an explicit `accept` carrying `decision: "confirm"` as consent.
 */
function confirmationSchema(
  title: string
): ElicitRequestFormParams['requestedSchema'] {
  return {
    type: 'object',
    properties: {
      decision: {
        type: 'string',
        title,
        description: 'Perform this destructive operation?',
        enum: ['confirm', 'cancel'],
        enumNames: ['Yes, perform it', 'No, cancel'],
      },
    },
    required: ['decision'],
  };
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

    elicit: async (message, title): Promise<ConfirmationAnswer> => {
      const result = await server.elicitInput(
        {
          mode: 'form',
          message,
          requestedSchema: confirmationSchema(title),
        },
        { relatedRequestId }
      );
      if (result.action !== 'accept') return result.action;
      return result.content?.decision === 'confirm' ? 'accept' : 'decline';
    },
  };
}

export function registerTools(
  server: Server,
  client: AltegioClient,
  options: RegisterToolsOptions = {}
): string[] {
  // Factory-defined CRUD tools (auth, location, team members, positions,
  // services, categories, schedules, appointments) — discovered from
  // ./definitions.
  const factoryTools = collectDefinedTools();
  const handlers = new Map<string, CallHandler>(
    factoryTools.map((tool) => [tool.meta.name, tool.createHandler(client)])
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

  // Onboarding wizard — stateful subsystem kept in its own registry/handlers.
  const stateManager = new OnboardingStateManager();
  const onboarding = new OnboardingHandlers(client, stateManager);
  const onboardingDispatch: Record<string, CallHandler> = {
    onboarding_start: (args) => onboarding.start(args),
    onboarding_resume: (args) => onboarding.resume(args),
    onboarding_status: (args) => onboarding.status(args),
    onboarding_add_positions: (args) => onboarding.addPositions(args),
    onboarding_set_schedules: (args) => onboarding.setSchedules(args),
    onboarding_add_staff_batch: (args) => onboarding.addStaffBatch(args),
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
    entries.map((entry) => entry.spec.name),
    {
      excludeOnboardingFromDefault: options.excludeOnboardingFromDefault,
      exposePasswordLogin: options.exposePasswordLogin,
    }
  );
  const facet = options.facet ?? DEFAULT_FACET;
  const visible = new Set(facetIndex.members(facet));
  const visibleToolDefs = entries
    .filter((entry) => visible.has(entry.spec.name))
    .map((entry) => entry.spec);

  // list handler — the same list for every connection to this facet
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleToolDefs,
  }));

  // call handler
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const execute = async (): Promise<ToolResult> => {
      const { name, arguments: args } = request.params;

      const handler = handlers.get(name) ?? onboardingDispatch[name];
      if (!handler) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
      if (!visible.has(name)) {
        throw outOfFacetError(name, facet, facetIndex);
      }

      // Destructive operations stop here until a human says yes. `undefined`
      // means "already confirmed, or nothing to confirm"; anything else is the
      // result the caller gets instead of the operation being performed.
      const prepared = confirmations.get(name)?.(args);
      if (prepared) {
        const gate = await requireConfirmation({
          toolName: name,
          args,
          prepared,
          client,
          runtime: confirmationRuntime(server, extra.requestId),
        });
        if (gate) return gate;
      }

      return handler(args);
    };

    // The SDK deliberately schedules protocol handlers on a later promise turn.
    // In the compiled ESM server that turn is outside the AsyncLocalStorage
    // scope surrounding transport.handleRequest(), even though the source-level
    // Jest transform happens to retain it. Re-bind from the SDK's immutable copy
    // of the original HTTP headers at the actual tool-handler boundary. Stdio
    // has no requestInfo and keeps its existing single-user context.
    const headers = extra.requestInfo?.headers;
    return headers
      ? runWithContext(requestContextFromHeaders(headers), execute)
      : execute();
  });

  return visibleToolDefs.map((tool) => tool.name);
}
