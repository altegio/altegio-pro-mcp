import * as defs from '../definitions/index.js';
import type { DefinedTool } from '../factory.js';

const tools = (Object.values(defs) as unknown[]).filter(
  (t): t is DefinedTool =>
    !!t && typeof t === 'object' && 'toMcpTool' in t && 'meta' in t
);

describe('factory tool definitions', () => {
  it('exposes all 23 CRUD tools', () => {
    expect(tools.length).toBe(23);
  });

  it('every tool produces a valid MCP spec', () => {
    for (const tool of tools) {
      const spec = tool.toMcpTool();
      expect(typeof spec.name).toBe('string');
      expect(spec.name.length).toBeGreaterThan(0);
      expect(spec.description.length).toBeGreaterThan(0);
      expect(spec.inputSchema).toMatchObject({ type: 'object' });
      // $schema is stripped so the shape matches hand-written MCP schemas
      expect(spec.inputSchema.$schema).toBeUndefined();
    }
  });

  it('read tools are marked readOnlyHint and delete tools destructiveHint', () => {
    expect(defs.getStaffTool.toMcpTool().annotations?.readOnlyHint).toBe(true);
    expect(defs.deleteStaffTool.toMcpTool().annotations?.destructiveHint).toBe(
      true
    );
    expect(
      defs.deleteBookingTool.toMcpTool().annotations?.destructiveHint
    ).toBe(true);
  });

  it('get_staff preserves required company_id and outputSchema', () => {
    const spec = defs.getStaffTool.toMcpTool();
    expect(spec.inputSchema.properties).toHaveProperty('company_id');
    expect(spec.inputSchema.required).toContain('company_id');
    expect(spec.outputSchema).toBeDefined();
  });

  it('tool names are unique', () => {
    const names = tools.map((t) => t.meta.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
