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
import type { DefinedTool } from './factory.js';
import type { ToolResult } from './tool-result.js';

type CallHandler = (args: unknown) => Promise<ToolResult>;

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

export function registerTools(server: Server, client: AltegioClient): string[] {
  // Factory-defined CRUD tools (auth, company, staff, positions, services,
  // categories, schedule, bookings) — discovered from ./definitions.
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

  const allToolDefs = [
    ...factoryTools.map((tool) => tool.toMcpTool()),
    ...onboardingTools,
  ];

  // list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allToolDefs,
  }));

  // call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const handler = handlers.get(name) ?? onboardingDispatch[name];
    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return handler(args);
  });

  return allToolDefs.map((tool) => tool.name);
}
