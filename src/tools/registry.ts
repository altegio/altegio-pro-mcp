import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { AltegioClient } from '../providers/altegio-client.js';
import { OnboardingHandlers } from './onboarding-handlers.js';
import { OnboardingStateManager } from '../providers/onboarding-state-manager.js';
import { onboardingTools } from './onboarding-registry.js';
import * as definitions from './definitions/index.js';
import {
  buildFacetIndex,
  DEFAULT_FACET,
  type FacetKey,
  type FacetIndex,
} from './facets.js';
import type { DefinedTool, McpToolSpec } from './factory.js';
import type { ToolResult } from './tool-result.js';

type CallHandler = (args: unknown) => Promise<ToolResult>;

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
}

/** Auto-discover every `DefinedTool` exported from the definitions barrel. */
function collectDefinedTools(): DefinedTool[] {
  return (Object.values(definitions) as unknown[]).filter(
    (v): v is DefinedTool =>
      !!v &&
      typeof v === 'object' &&
      'toMcpTool' in v &&
      'createHandler' in v &&
      'meta' in v
  );
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
  const where =
    elsewhere.length > 0
      ? ` Reach it on ${elsewhere.map((f) => `/mcp/${f}`).join(' or ')}, or on /mcp.`
      : ' Reach it on /mcp.';
  return new McpError(
    ErrorCode.MethodNotFound,
    `Tool "${name}" is not served by the "${facet}" view of this endpoint.${where}`
  );
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
    { excludeOnboardingFromDefault: options.excludeOnboardingFromDefault }
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
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const handler = handlers.get(name) ?? onboardingDispatch[name];
    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    if (!visible.has(name)) {
      throw outOfFacetError(name, facet, facetIndex);
    }

    return handler(args);
  });

  return visibleToolDefs.map((tool) => tool.name);
}
