import { z } from 'zod';
import { defineTool, textResponse } from '../factory.js';

describe('Tool Factory', () => {
  describe('textResponse', () => {
    it('creates MCP text response format', () => {
      const result = textResponse('Hello');
      expect(result).toEqual({
        content: [{ type: 'text', text: 'Hello' }],
      });
    });
  });

  describe('defineTool', () => {
    const mockClient = {
      isAuthenticated: jest.fn(),
    } as any;

    const testTool = defineTool({
      name: 'test_tool',
      category: 'Test',
      description: 'A test tool',
      requiresAuth: true,
      input: z.object({
        value: z.number().describe('A number value'),
      }),
      handler: async ({ input }) => `Received: ${input.value}`,
    });

    it('generates MCP tool definition with JSON schema', () => {
      const mcpTool = testTool.toMcpTool();

      expect(mcpTool.name).toBe('test_tool');
      expect(mcpTool.description).toBe('A test tool');
      expect(mcpTool.inputSchema).toHaveProperty('type', 'object');
      expect(mcpTool.inputSchema.properties).toHaveProperty('value');
    });

    it('creates handler that checks auth when required', async () => {
      mockClient.isAuthenticated.mockReturnValue(false);
      const handler = testTool.createHandler(mockClient);

      await expect(handler({ value: 42 })).rejects.toThrow('Authentication required');
    });

    it('creates handler that executes when authenticated', async () => {
      mockClient.isAuthenticated.mockReturnValue(true);
      const handler = testTool.createHandler(mockClient);

      const result = await handler({ value: 42 });
      expect(result.content[0]?.text).toBe('Received: 42');
    });

    it('creates handler that validates input with Zod', async () => {
      mockClient.isAuthenticated.mockReturnValue(true);
      const handler = testTool.createHandler(mockClient);

      const result = await handler({ value: 'not a number' });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Failed');
    });
  });

  describe('defineTool without auth', () => {
    const mockClient = {
      isAuthenticated: jest.fn().mockReturnValue(false),
    } as any;

    const publicTool = defineTool({
      name: 'public_tool',
      category: 'Public',
      description: 'No auth needed',
      requiresAuth: false,
      input: z.object({}),
      handler: async () => 'Public response',
    });

    it('executes without auth check when requiresAuth is false', async () => {
      const handler = publicTool.createHandler(mockClient);
      const result = await handler({});

      expect(result.content[0]?.text).toBe('Public response');
    });
  });
});
