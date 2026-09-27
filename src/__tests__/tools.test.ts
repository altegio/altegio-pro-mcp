import { PACKAGE_VERSION } from '../package-metadata.js';
import { describe, it, expect } from '@jest/globals';
import { createServer } from '../server.js';
import { registerTools } from '../tools/registry.js';
import { ALL_TOOLS_FACET } from '../tools/facets.js';
import { AltegioClient } from '../providers/altegio-client.js';
import { ToolHandlers } from '../tools/handlers.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { getRequestUserToken } from '../request-context.js';

describe('Tool Registration', () => {
  it('should register all tools and return tool names', () => {
    const server = new Server(
      {
        name: 'test-server',
        version: '1.0.0',
      },
      {
        capabilities: { tools: {} },
      }
    );

    const client = new AltegioClient({
      partnerToken: 'test-token',
    });

    const toolNames = registerTools(server, client, {
      facet: ALL_TOOLS_FACET,
    });

    // Core tools (16)
    expect(toolNames).toContain('auth_login');
    expect(toolNames).toContain('auth_logout');
    expect(toolNames).toContain('locations_list');
    expect(toolNames).toContain('appointments_list');
    expect(toolNames).toContain('team_members_list');
    expect(toolNames).toContain('services_list');
    expect(toolNames).toContain('service_categories_list');
    expect(toolNames).toContain('schedules_get');
    expect(toolNames).toContain('team_members_create');
    expect(toolNames).toContain('team_members_update');
    expect(toolNames).toContain('team_members_delete');
    expect(toolNames).toContain('services_create');
    expect(toolNames).toContain('services_update');
    expect(toolNames).toContain('appointments_create');
    expect(toolNames).toContain('appointments_update');
    expect(toolNames).toContain('appointments_delete');

    // Onboarding tools (12)
    expect(toolNames).toContain('onboarding_start');
    expect(toolNames).toContain('onboarding_resume');
    expect(toolNames).toContain('onboarding_status');
    expect(toolNames).toContain('onboarding_add_positions');
    expect(toolNames).toContain('onboarding_set_schedules');
    expect(toolNames).toContain('onboarding_add_team_members_batch');
    expect(toolNames).toContain('onboarding_add_services_batch');
    expect(toolNames).toContain('onboarding_add_categories');
    expect(toolNames).toContain('onboarding_import_clients');
    expect(toolNames).toContain('onboarding_create_test_appointments');
    expect(toolNames).toContain('onboarding_preview_data');
    expect(toolNames).toContain('onboarding_rollback_phase');

    // Schedule management tools
    expect(toolNames).toContain('schedules_create');
    expect(toolNames).toContain('schedules_update');
    expect(toolNames).toContain('schedules_delete');

    // Position management tools
    expect(toolNames).toContain('positions_list');
    expect(toolNames).toContain('positions_create');
    expect(toolNames).not.toContain('update_position');
    expect(toolNames).not.toContain('delete_position');

    // Location settings tools (6)
    expect(toolNames).toContain('settings_get_appointment_calendar');
    expect(toolNames).toContain('settings_update_appointment_calendar');
    expect(toolNames).toContain('settings_get_online_booking');
    expect(toolNames).toContain('settings_update_online_booking');
    expect(toolNames).toContain('booking_forms_list');
    expect(toolNames).toContain('booking_forms_create');
    expect(toolNames).toContain('booking_forms_delete');

    // Resources tool (1)
    expect(toolNames).toContain('resources_list');

    // Service delete + service ↔ team member links
    expect(toolNames).toContain('services_delete');
    expect(toolNames).toContain('service_categories_delete');
    expect(toolNames).toContain('services_link_team_member');
    expect(toolNames).toContain('services_update_team_member_link');
    expect(toolNames).toContain('services_unlink_team_member');
    expect(toolNames).toContain('team_members_link_services');

    // Location update
    expect(toolNames).toContain('locations_update');

    // Exact-ID demo cleanup tools
    expect(toolNames).toContain('clients_delete');
    expect(toolNames).toContain('locations_remove_user');

    // Universal executor over the generated API catalog (3, ADR-001 D2)
    expect(toolNames).toContain('api_search_operations');
    expect(toolNames).toContain('api_describe_operation');
    expect(toolNames).toContain('api_call_operation');

    // Analytics pack (9 served; the 6 report-builder tools are withheld,
    // see src/tools/disabled-tools.ts)
    expect(toolNames).toContain('analytics_get_overview');
    expect(toolNames).toContain('analytics_get_daily_series');
    expect(toolNames).toContain('analytics_get_appointments_breakdown');
    expect(toolNames).toContain('analytics_get_receptionist_performance');
    expect(toolNames).toContain('analytics_get_loyalty_program_results');
    expect(toolNames).toContain('analytics_get_forecast');
    expect(toolNames).toContain('analytics_get_day_end_report');
    expect(toolNames).toContain('analytics_get_team_member_occupancy');
    expect(toolNames).toContain('analytics_get_client_visit_stats');
    for (const withheld of [
      'analytics_list_report_templates',
      'analytics_list_report_fields',
      'analytics_run_report',
      'analytics_list_saved_reports',
      'analytics_run_saved_report',
      'analytics_delete_assistant_report',
    ]) {
      expect(toolNames).not.toContain(withheld);
    }

    // Total: 83 served factory-defined + 12 onboarding = 95 tools
    expect(toolNames.length).toBe(95);
  });

  it('should create server with tools', () => {
    const server = createServer();

    expect(server).toBeDefined();
    expect(server.name).toBe('@altegio/mcp-server-pro');
    expect(server.version).toBe(PACKAGE_VERSION);
  });

  it('rebinds direct-token headers at the SDK tool-handler boundary', async () => {
    type RegisteredHandler = (
      request: {
        params: { name: string; arguments: Record<string, unknown> };
      },
      extra: {
        requestInfo?: { headers: Record<string, string>; url: URL };
      }
    ) => Promise<unknown>;

    let callHandler: RegisteredHandler | undefined;
    const server = {
      setRequestHandler: (schema: unknown, handler: RegisteredHandler) => {
        if (schema === CallToolRequestSchema) callHandler = handler;
      },
    } as unknown as Server;
    let tokenSeenByClient: string | undefined;
    const client = {
      getCompanies: async () => {
        tokenSeenByClient = getRequestUserToken();
        return [];
      },
    } as unknown as AltegioClient;

    registerTools(server, client);
    expect(callHandler).toBeDefined();
    await callHandler!(
      {
        params: {
          name: 'locations_list',
          arguments: { my: 1, count: 1 },
        },
      },
      {
        requestInfo: {
          headers: { 'x-altegio-user-token': 'direct-user-token' },
          url: new URL('https://mcp.alteg.io/public/pro/mcp'),
        },
      }
    );

    expect(tokenSeenByClient).toBe('direct-user-token');
    expect(getRequestUserToken()).toBeUndefined();
  });
});

describe('schedules_get', () => {
  it('should format schedule entries', async () => {
    const mockClient = {
      getSchedule: jest.fn().mockResolvedValue([
        {
          date: '2025-10-27',
          time: '09:00',
          seance_length: 30,
          datetime: '2025-10-27T09:00:00',
        },
        {
          date: '2025-10-27',
          time: '10:00',
          seance_length: 60,
          datetime: '2025-10-27T10:00:00',
        },
      ]),
    } as unknown as jest.Mocked<AltegioClient>;

    const handlers = new ToolHandlers(mockClient);
    const result = await handlers.getSchedule({
      location_id: 123,
      team_member_id: 456,
      start_date: '2025-10-27',
      end_date: '2025-10-28',
    });

    expect(result.content[0]?.text).toContain('Found 2 schedule entries');
    expect(result.content[0]?.text).toContain('2025-10-27 at 09:00 (30 min)');
  });
});
