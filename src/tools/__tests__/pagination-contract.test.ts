import {
  getAppointmentsTool,
  getServiceCategoriesTool,
  getServicesTool,
  getStaffTool,
  listLocationsTool,
} from '../definitions/index.js';

describe('legacy list pagination contract', () => {
  const tools = [
    listLocationsTool,
    getAppointmentsTool,
    getStaffTool,
    getServicesTool,
    getServiceCategoriesTool,
  ];

  it.each(tools.map((tool) => [tool.meta.name, tool] as const))(
    '%s is consistently 1-based and capped at 300 rows',
    (_name, tool) => {
      const schema = tool.toMcpTool().inputSchema as {
        properties: Record<
          string,
          {
            minimum?: number;
            exclusiveMinimum?: number;
            maximum?: number;
            description?: string;
          }
        >;
      };
      expect(schema.properties.page?.exclusiveMinimum).toBe(0);
      expect(schema.properties.page?.description).toContain('1-based');
      expect(schema.properties.count?.maximum).toBe(300);
    }
  );

  it.each(tools.map((tool) => [tool.meta.name, tool] as const))(
    '%s rejects page 0 before calling the API',
    async (_name, tool) => {
      const client = new Proxy(
        {},
        {
          get: () => jest.fn(),
        }
      );
      const result = await tool.createHandler(client as never)({
        location_id: 456,
        page: 0,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('Invalid parameters');
    }
  );
});
