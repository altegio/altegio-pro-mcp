import { describe, it, expect, beforeAll } from '@jest/globals';
import { createServer } from '../server.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { AltegioClient } from '../providers/altegio-client.js';
import { ToolHandlers } from '../tools/handlers.js';

describe('End-to-End Tests', () => {
  let server: Server;
  let client: AltegioClient;
  let handlers: ToolHandlers;

  beforeAll(() => {
    server = createServer();
    client = new AltegioClient({
      partnerToken: 'test-partner-token',
    });
    handlers = new ToolHandlers(client);
  });

  it('should create server with correct metadata', () => {
    expect(server).toBeDefined();
    expect((server as any).name).toBe('@altegio/mcp-server-pro');
    expect((server as any).version).toBe('1.0.0');
  });

  it('should have all required tools registered', async () => {
    // Test that handlers exist for all tools
    expect(typeof handlers.login).toBe('function');
    expect(typeof handlers.logout).toBe('function');
    expect(typeof handlers.listCompanies).toBe('function');
    expect(typeof handlers.getBookings).toBe('function');
  });

  it('should handle logout tool successfully', async () => {
    const result = await handlers.logout();

    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]?.type).toBe('text');
    expect((result.content[0] as any)?.text).toContain('logged out');
  });

  it('should validate email format for login', async () => {
    // Test with invalid email format
    await expect(
      handlers.login({
        email: 'not-an-email',
        password: 'test123',
      })
    ).rejects.toThrow();
  });

  it('should validate company_id is a number', async () => {
    await expect(
      handlers.getBookings({
        company_id: 'not-a-number',
      })
    ).rejects.toThrow();
  });

  it('should handle login with proper response structure', async () => {
    // Mock fetch for login
    global.fetch = jest.fn(() =>
      Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            success: true,
            data: { user_token: 'test-token-123' },
          }),
      } as Response)
    ) as any;

    const result = await handlers.login({
      email: 'test@example.com',
      password: 'password123',
    });

    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]?.type).toBe('text');
    expect((result.content[0] as any)?.text).toContain('logged in');
  });
});
