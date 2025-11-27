import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { AltegioClient } from '../providers/altegio-client.js';
import { OnboardingStateManager } from '../providers/onboarding-state-manager.js';
import * as allToolsExports from './definitions/index.js';
import type { DefinedTool } from './factory.js';
import { createOnboardingHandlers, getOnboardingToolDefinitions } from './onboarding-wrapper.js';

export function registerTools(server: Server, client: AltegioClient): string[] {
  // Collect all factory-defined tools (excluding onboardingTools array)
  const factoryTools = Object.entries(allToolsExports)
    .filter(([key, value]) => key !== 'onboardingTools' && value && typeof value === 'object' && 'toMcpTool' in value)
    .map(([, value]) => value) as DefinedTool<any>[];

  // Build handlers map for factory tools
  const handlers = new Map(
    factoryTools.map((t) => [t.meta.name, t.createHandler(client)])
  );

  // Add onboarding tools (special case - need stateManager)
  const stateManager = new OnboardingStateManager();
  const onboardingHandlers = createOnboardingHandlers(client, stateManager);
  const onboardingToolDefs = getOnboardingToolDefinitions();

  // Add onboarding handlers to map (except preview_data which uses factory)
  onboardingHandlers.forEach((handler, name) => {
    handlers.set(name, handler);
  });

  // Add onboarding_preview_data which uses factory handler
  if (allToolsExports.onboardingPreviewDataTool) {
    handlers.set('onboarding_preview_data', allToolsExports.onboardingPreviewDataTool.createHandler(client));
  }

  // Combine all tool definitions
  const allToolDefs = [
    ...factoryTools.map((t) => t.toMcpTool()),
    ...onboardingToolDefs
  ];

  // Register list handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allToolDefs,
  }));

  // Register call handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = handlers.get(name);

    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    try {
      const result = await handler(args);
      return result as any; // McpToolResponse is compatible with SDK response
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      throw new McpError(
        ErrorCode.InternalError,
        error instanceof Error ? error.message : 'Unknown error'
      );
    }
  });

  return allToolDefs.map((t) => t.name);
}
