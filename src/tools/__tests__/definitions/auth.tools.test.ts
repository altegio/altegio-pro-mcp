import { loginTool, logoutTool } from '../../definitions/auth.tools.js';

describe('Auth Tools', () => {
  describe('loginTool', () => {
    it('has correct metadata', () => {
      expect(loginTool.meta.name).toBe('altegio_login');
      expect(loginTool.meta.requiresAuth).toBe(false);
    });

    it('generates valid MCP schema', () => {
      const mcp = loginTool.toMcpTool();
      expect(mcp.inputSchema.properties).toHaveProperty('email');
      expect(mcp.inputSchema.properties).toHaveProperty('password');
      expect(mcp.inputSchema.required).toContain('email');
      expect(mcp.inputSchema.required).toContain('password');
    });

    it('handles successful login', async () => {
      const mockClient = {
        isAuthenticated: () => false,
        login: jest.fn().mockResolvedValue({ success: true, user_token: 'token123' }),
      } as any;

      const handler = loginTool.createHandler(mockClient);
      const result = await handler({ email: 'test@test.com', password: 'pass' });

      expect(result.content[0]?.text).toContain('Successfully logged in');
      expect(mockClient.login).toHaveBeenCalledWith('test@test.com', 'pass');
    });

    it('handles failed login', async () => {
      const mockClient = {
        isAuthenticated: () => false,
        login: jest.fn().mockResolvedValue({ success: false, error: 'Invalid credentials' }),
      } as any;

      const handler = loginTool.createHandler(mockClient);
      const result = await handler({ email: 'test@test.com', password: 'wrong' });

      expect(result.content[0]?.text).toContain('Login failed');
      expect(result.content[0]?.text).toContain('Invalid credentials');
    });
  });

  describe('logoutTool', () => {
    it('has correct metadata', () => {
      expect(logoutTool.meta.name).toBe('altegio_logout');
      expect(logoutTool.meta.requiresAuth).toBe(false);
    });

    it('calls client logout', async () => {
      const mockClient = {
        isAuthenticated: () => true,
        logout: jest.fn().mockResolvedValue({ success: true }),
      } as any;

      const handler = logoutTool.createHandler(mockClient);
      const result = await handler({});

      expect(result.content[0]?.text).toContain('Successfully logged out');
      expect(mockClient.logout).toHaveBeenCalled();
    });
  });
});
