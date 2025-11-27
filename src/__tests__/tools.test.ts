import { describe, it, expect } from '@jest/globals';
import { createServer } from '../server.js';
import { registerTools } from '../tools/registry.js';
import { AltegioClient } from '../providers/altegio-client.js';
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

    const toolNames = registerTools(server, client);

    // Core tools (16)
    expect(toolNames).toContain('altegio_login');
    expect(toolNames).toContain('altegio_logout');
    expect(toolNames).toContain('list_companies');
    expect(toolNames).toContain('get_bookings');
    expect(toolNames).toContain('get_staff');
    expect(toolNames).toContain('get_services');
    expect(toolNames).toContain('get_service_categories');
    expect(toolNames).toContain('get_schedule');
    expect(toolNames).toContain('create_staff');
    expect(toolNames).toContain('update_staff');
    expect(toolNames).toContain('delete_staff');
    expect(toolNames).toContain('create_service');
    expect(toolNames).toContain('update_service');
    expect(toolNames).toContain('create_booking');
    expect(toolNames).toContain('update_booking');
    expect(toolNames).toContain('delete_booking');

    // Onboarding tools (10)
    expect(toolNames).toContain('onboarding_start');
    expect(toolNames).toContain('onboarding_resume');
    expect(toolNames).toContain('onboarding_status');
    expect(toolNames).toContain('onboarding_add_staff_batch');
    expect(toolNames).toContain('onboarding_add_services_batch');
    expect(toolNames).toContain('onboarding_add_categories');
    expect(toolNames).toContain('onboarding_import_clients');
    expect(toolNames).toContain('onboarding_create_test_bookings');
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

    // Total: 16 + 10 + 3 + 4 = 33 tools
    expect(toolNames.length).toBe(33);
  });

  it('should create server with tools', () => {
    const server = createServer();

    expect(server).toBeDefined();
    expect(server.name).toBe('@altegio/mcp-server-pro');
    expect(server.version).toBe('1.0.0');
  });
});
