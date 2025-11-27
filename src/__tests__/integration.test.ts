import { describe, it, expect } from '@jest/globals';
import { createServer } from '../server.js';
import { AltegioClient } from '../providers/altegio-client.js';
import { ToolHandlers } from '../tools/handlers.js';

describe('Tool Integration', () => {
  it('should create server with tools registered', () => {
    const server = createServer();
    expect(server).toBeDefined();
    expect(server.name).toBe('@altegio/mcp-server-pro');
  });

  it('should create ToolHandlers with AltegioClient', () => {
    const client = new AltegioClient({
      partnerToken: 'test-token',
    });
    const handlers = new ToolHandlers(client);

    expect(handlers).toBeDefined();
    expect(typeof handlers.login).toBe('function');
    expect(typeof handlers.logout).toBe('function');
    expect(typeof handlers.listCompanies).toBe('function');
    expect(typeof handlers.getBookings).toBe('function');
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

    const client = new AltegioClient({
      partnerToken: 'test-token',
    });
    const handlers = new ToolHandlers(client);

    const result = await handlers.login({
      email: 'test@example.com',
      password: 'password123',
    });

    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]?.type).toBe('text');
    expect((result.content[0] as any)?.text).toContain('logged in');
  });

  it('should handle logout', async () => {
    const client = new AltegioClient({
      partnerToken: 'test-token',
    });
    const handlers = new ToolHandlers(client);

    const result = await handlers.logout();

    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.content[0]?.type).toBe('text');
    expect((result.content[0] as any)?.text).toContain('logged out');
  });

  it('should validate email format with zod schema', async () => {
    const client = new AltegioClient({
      partnerToken: 'test-token',
    });
    const handlers = new ToolHandlers(client);

    await expect(
      handlers.login({
        email: 'invalid-email',
        password: 'test',
      })
    ).rejects.toThrow();
  });

  it('should validate company_id is a number', async () => {
    const client = new AltegioClient({
      partnerToken: 'test-token',
      userToken: 'user-token',
    });
    const handlers = new ToolHandlers(client);

    await expect(
      handlers.getBookings({
        company_id: 'not-a-number',
      })
    ).rejects.toThrow();
  });
});
