import { onboardingTools, onboardingPreviewDataTool } from '../../definitions/onboarding.tools.js';

describe('Onboarding Tool Definitions', () => {
  describe('Tool Exports', () => {
    it('exports all 10 onboarding tools', () => {
      expect(onboardingTools).toHaveLength(10);
    });

    it('all tools have required metadata', () => {
      onboardingTools.forEach((tool) => {
        expect(tool.meta).toBeDefined();
        expect(tool.meta.name).toBeTruthy();
        expect(tool.meta.category).toBe('Onboarding');
        expect(tool.meta.description).toBeTruthy();
        expect(typeof tool.meta.requiresAuth).toBe('boolean');
      });
    });

    it('all tools can generate MCP definitions', () => {
      onboardingTools.forEach((tool) => {
        const mcpTool = tool.toMcpTool();
        expect(mcpTool.name).toBeTruthy();
        expect(mcpTool.description).toBeTruthy();
        expect(mcpTool.inputSchema).toBeDefined();
        expect(mcpTool.inputSchema.type).toBe('object');
      });
    });
  });

  describe('Tool Names', () => {
    it('includes all expected onboarding tools', () => {
      const toolNames = onboardingTools.map((t) => t.meta.name);
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
    });
  });

  describe('Authentication Requirements', () => {
    it('most tools require authentication', () => {
      const requiresAuthTools = onboardingTools.filter((t) => t.meta.requiresAuth);
      expect(requiresAuthTools.length).toBe(9); // All except preview_data
    });

    it('preview_data does not require authentication', () => {
      expect(onboardingPreviewDataTool.meta.requiresAuth).toBe(false);
    });
  });

  describe('Input Schemas', () => {
    it('onboarding_start requires company_id', () => {
      const tool = onboardingTools.find((t) => t.meta.name === 'onboarding_start');
      const mcpTool = tool?.toMcpTool();
      expect(mcpTool?.inputSchema.properties).toHaveProperty('company_id');
      expect(mcpTool?.inputSchema.required).toContain('company_id');
    });

    it('onboarding_add_staff_batch requires company_id and staff_data', () => {
      const tool = onboardingTools.find((t) => t.meta.name === 'onboarding_add_staff_batch');
      const mcpTool = tool?.toMcpTool();
      expect(mcpTool?.inputSchema.properties).toHaveProperty('company_id');
      expect(mcpTool?.inputSchema.properties).toHaveProperty('staff_data');
      expect(mcpTool?.inputSchema.required).toEqual(['company_id', 'staff_data']);
    });

    it('onboarding_preview_data requires data_type and raw_input', () => {
      const tool = onboardingTools.find((t) => t.meta.name === 'onboarding_preview_data');
      const mcpTool = tool?.toMcpTool();
      expect(mcpTool?.inputSchema.properties).toHaveProperty('data_type');
      expect(mcpTool?.inputSchema.properties).toHaveProperty('raw_input');
      expect(mcpTool?.inputSchema.required).toEqual(['data_type', 'raw_input']);
    });

    it('onboarding_create_test_bookings has optional count with default', () => {
      const tool = onboardingTools.find(
        (t) => t.meta.name === 'onboarding_create_test_bookings'
      );
      const mcpTool = tool?.toMcpTool();
      expect(mcpTool?.inputSchema.properties).toHaveProperty('count');
      expect(mcpTool?.inputSchema.required).toEqual(['company_id']);
    });
  });

  describe('onboarding_preview_data Handler', () => {
    const mockClient = {
      isAuthenticated: jest.fn().mockReturnValue(false),
    } as any;

    it('can parse CSV data', async () => {
      const handler = onboardingPreviewDataTool.createHandler(mockClient);
      const csvInput = 'name,phone\nJohn Doe,+1234567890\nJane Smith,+0987654321';

      const result = await handler({
        data_type: 'staff',
        raw_input: csvInput,
      });

      expect(result.content[0]?.text).toContain('Total rows: 2');
      expect(result.content[0]?.text).toContain('John Doe');
    });

    it('can parse JSON data', async () => {
      const handler = onboardingPreviewDataTool.createHandler(mockClient);
      const jsonInput = JSON.stringify([
        { name: 'Test Service', price_min: 100 },
        { name: 'Another Service', price_min: 200 },
      ]);

      const result = await handler({
        data_type: 'services',
        raw_input: jsonInput,
      });

      expect(result.content[0]?.text).toContain('Total rows: 2');
      expect(result.content[0]?.text).toContain('Test Service');
    });

    it('handles empty data', async () => {
      const handler = onboardingPreviewDataTool.createHandler(mockClient);

      const result = await handler({
        data_type: 'clients',
        raw_input: '',
      });

      expect(result.content[0]?.text).toContain('No data parsed');
    });

    it('limits preview to 5 rows', async () => {
      const handler = onboardingPreviewDataTool.createHandler(mockClient);
      const csvInput = Array.from({ length: 10 }, (_, i) => `Row ${i + 1},value${i + 1}`)
        .join('\n');
      const csvWithHeader = `name,value\n${csvInput}`;

      const result = await handler({
        data_type: 'staff',
        raw_input: csvWithHeader,
      });

      expect(result.content[0]?.text).toContain('Total rows: 10');
      expect(result.content[0]?.text).toContain('First 5 rows');
      expect(result.content[0]?.text).toContain('Row 5'); // 5th row shown
      expect(result.content[0]?.text).not.toContain('Row 6'); // 6th row not shown
    });
  });

  describe('Tool Handler Stubs', () => {
    const mockClient = {
      isAuthenticated: jest.fn().mockReturnValue(true),
    } as any;

    it('tools requiring stateManager throw appropriate error', async () => {
      const tool = onboardingTools.find((t) => t.meta.name === 'onboarding_start');
      const handler = tool!.createHandler(mockClient);

      const result = await handler({ company_id: 123 });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('stateManager');
    });
  });
});
