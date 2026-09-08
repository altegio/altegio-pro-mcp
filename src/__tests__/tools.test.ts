import { describe, it, expect } from '@jest/globals';
import { createServer } from '../server.js';
import { registerTools } from '../tools/registry.js';
import { ALL_TOOLS_FACET } from '../tools/facets.js';
import { AltegioClient } from '../providers/altegio-client.js';
import { ToolHandlers } from '../tools/handlers.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';

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
    expect(toolNames).toContain('altegio_login');
    expect(toolNames).toContain('altegio_logout');
    expect(toolNames).toContain('list_locations');
    expect(toolNames).toContain('get_appointments');
    expect(toolNames).toContain('get_staff');
    expect(toolNames).toContain('get_services');
    expect(toolNames).toContain('get_service_categories');
    expect(toolNames).toContain('get_schedule');
    expect(toolNames).toContain('create_staff');
    expect(toolNames).toContain('update_staff');
    expect(toolNames).toContain('delete_staff');
    expect(toolNames).toContain('create_service');
    expect(toolNames).toContain('update_service');
    expect(toolNames).toContain('create_appointment');
    expect(toolNames).toContain('update_appointment');
    expect(toolNames).toContain('delete_appointment');

    // Onboarding tools (12)
    expect(toolNames).toContain('onboarding_start');
    expect(toolNames).toContain('onboarding_resume');
    expect(toolNames).toContain('onboarding_status');
    expect(toolNames).toContain('onboarding_add_positions');
    expect(toolNames).toContain('onboarding_set_schedules');
    expect(toolNames).toContain('onboarding_add_staff_batch');
    expect(toolNames).toContain('onboarding_add_services_batch');
    expect(toolNames).toContain('onboarding_add_categories');
    expect(toolNames).toContain('onboarding_import_clients');
    expect(toolNames).toContain('onboarding_create_test_appointments');
    expect(toolNames).toContain('onboarding_preview_data');
    expect(toolNames).toContain('onboarding_rollback_phase');

    // Schedule management tools
    expect(toolNames).toContain('create_schedule');
    expect(toolNames).toContain('update_schedule');
    expect(toolNames).toContain('delete_schedule');

    // Position management tools
    expect(toolNames).toContain('get_positions');
    expect(toolNames).toContain('create_position');
    expect(toolNames).toContain('update_position');
    expect(toolNames).toContain('delete_position');

    // Location settings tools (6)
    expect(toolNames).toContain('get_appointment_settings');
    expect(toolNames).toContain('update_appointment_settings');
    expect(toolNames).toContain('get_online_booking_settings');
    expect(toolNames).toContain('update_online_booking_settings');
    expect(toolNames).toContain('get_booking_forms');
    expect(toolNames).toContain('create_booking_form');

    // Resources tool (1)
    expect(toolNames).toContain('get_resources');

    // Universal executor over the generated API catalog (3, ADR-001 D2)
    expect(toolNames).toContain('altegio_search_operations');
    expect(toolNames).toContain('altegio_describe_operation');
    expect(toolNames).toContain('altegio_call_operation');

    // Analytics pack (14)
    expect(toolNames).toContain('analytics_get_overview');
    expect(toolNames).toContain('analytics_get_daily_series');
    expect(toolNames).toContain('analytics_get_appointments_breakdown');
    expect(toolNames).toContain('analytics_get_receptionist_performance');
    expect(toolNames).toContain('analytics_get_loyalty_program_results');
    expect(toolNames).toContain('analytics_get_forecast');
    expect(toolNames).toContain('analytics_get_day_end_report');
    expect(toolNames).toContain('analytics_get_team_member_occupancy');
    expect(toolNames).toContain('analytics_get_client_visit_stats');
    expect(toolNames).toContain('analytics_list_report_templates');
    expect(toolNames).toContain('analytics_list_report_fields');
    expect(toolNames).toContain('analytics_run_report');
    expect(toolNames).toContain('analytics_list_saved_reports');
    expect(toolNames).toContain('analytics_run_saved_report');

    // Total: 30 CRUD + 3 executor + 14 analytics + 4 clients + 12 onboarding = 63 tools
    expect(toolNames.length).toBe(63);
  });

  it('should create server with tools', () => {
    const server = createServer();

    expect(server).toBeDefined();
    expect(server.name).toBe('@altegio/mcp-server-pro');
    expect(server.version).toBe('1.0.0');
  });
});

describe('get_schedule', () => {
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
    } as any;

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
