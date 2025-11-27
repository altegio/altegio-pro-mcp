import type { AltegioClient } from '../providers/altegio-client.js';
import type { OnboardingStateManager } from '../providers/onboarding-state-manager.js';
import { OnboardingHandlers } from './onboarding-handlers.js';
import { onboardingTools } from './definitions/onboarding.tools.js';
import type { McpToolResponse } from './factory.js';
import { errorResponse } from './factory.js';

/**
 * Creates MCP-compatible handlers for onboarding tools that require stateManager.
 * The tools are defined in definitions/onboarding.tools.ts but need custom handlers
 * because they require OnboardingStateManager context.
 */
export function createOnboardingHandlers(
  client: AltegioClient,
  stateManager: OnboardingStateManager
): Map<string, (args: unknown) => Promise<McpToolResponse>> {
  const handlers = new OnboardingHandlers(client, stateManager);
  const handlerMap = new Map<string, (args: unknown) => Promise<McpToolResponse>>();

  // Map each tool to its handler
  handlerMap.set('onboarding_start', async (args: unknown) => {
    try {
      return await handlers.start(args);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Unknown error');
    }
  });

  handlerMap.set('onboarding_resume', async (args: unknown) => {
    try {
      return await handlers.resume(args);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Unknown error');
    }
  });

  handlerMap.set('onboarding_status', async (args: unknown) => {
    try {
      return await handlers.status(args);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Unknown error');
    }
  });

  handlerMap.set('onboarding_add_staff_batch', async (args: unknown) => {
    try {
      return await handlers.addStaffBatch(args);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Unknown error');
    }
  });

  handlerMap.set('onboarding_add_services_batch', async (args: unknown) => {
    try {
      return await handlers.addServicesBatch(args);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Unknown error');
    }
  });

  handlerMap.set('onboarding_add_categories', async (args: unknown) => {
    try {
      return await handlers.addCategories(args);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Unknown error');
    }
  });

  handlerMap.set('onboarding_import_clients', async (args: unknown) => {
    try {
      return await handlers.importClients(args);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Unknown error');
    }
  });

  handlerMap.set('onboarding_create_test_bookings', async (args: unknown) => {
    try {
      return await handlers.createTestBookings(args);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Unknown error');
    }
  });

  handlerMap.set('onboarding_rollback_phase', async (args: unknown) => {
    try {
      return await handlers.rollbackPhase(args);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Unknown error');
    }
  });

  // onboarding_preview_data uses the factory handler (doesn't need stateManager)

  return handlerMap;
}

/**
 * Get MCP tool definitions for onboarding tools.
 * These use the factory pattern but have custom handlers.
 */
export function getOnboardingToolDefinitions() {
  return onboardingTools.map(tool => tool.toMcpTool());
}
