import { z } from 'zod';
import { defineTool } from '../factory.js';
import { AuthenticationError } from '../../utils/errors.js';

const mockClient = () => ({ isAuthenticated: () => true }) as never;

describe('defineTool factory', () => {
  const tool = defineTool({
    name: 'demo_tool',
    category: 'Demo',
    description: 'demo',
    annotations: { readOnlyHint: true },
    input: z.object({ x: z.number().int().describe('x value') }),
    outputSchema: { type: 'object', properties: { y: { type: 'number' } } },
    handler: async ({ input }) => ({
      text: `x=${input.x}`,
      structuredContent: { y: input.x * 2 },
    }),
  });

  it('emits inputSchema, outputSchema and annotations (no $schema key)', () => {
    const spec = tool.toMcpTool();
    expect(spec.name).toBe('demo_tool');
    expect(spec.inputSchema).toMatchObject({ type: 'object' });
    expect(spec.inputSchema.$schema).toBeUndefined();
    expect(spec.inputSchema.properties).toHaveProperty('x');
    expect(spec.outputSchema).toEqual({
      type: 'object',
      properties: { y: { type: 'number' } },
    });
    expect(spec.annotations).toEqual({ readOnlyHint: true });
  });

  it('returns content + structuredContent on success', async () => {
    const res = await tool.createHandler(mockClient())({ x: 5 });
    expect(res.content[0]?.text).toBe('x=5');
    expect(res.structuredContent).toEqual({ y: 10 });
    expect(res.isError).toBeUndefined();
  });

  it('maps invalid input to an isError result (ZodError)', async () => {
    const res = await tool.createHandler(mockClient())({ x: 'nope' });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain('Invalid parameters for demo_tool');
  });

  it('maps a thrown AuthenticationError to a friendly isError result', async () => {
    const authTool = defineTool({
      name: 'auth_demo',
      category: 'Demo',
      description: 'd',
      input: z.object({}),
      handler: async () => {
        throw new AuthenticationError();
      },
    });
    const res = await authTool.createHandler(mockClient())({});
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text).toContain(
      'Authentication required. Call altegio_login before using auth_demo'
    );
  });

  it('omits structuredContent when the handler returns text only', async () => {
    const textOnly = defineTool({
      name: 'text_only',
      category: 'Demo',
      description: 'd',
      input: z.object({}),
      handler: async () => ({ text: 'ok' }),
    });
    const res = await textOnly.createHandler(mockClient())({});
    expect(res.content[0]?.text).toBe('ok');
    expect(res.structuredContent).toBeUndefined();
  });
});
