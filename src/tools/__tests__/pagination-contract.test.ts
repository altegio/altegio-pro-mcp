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
      expect(schema.properties.page_size?.maximum).toBe(300);
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

describe('reference collection traversal', () => {
  it.each([
    ['team members', getStaffTool, 'getStaff'],
    ['services', getServicesTool, 'getServices'],
    ['categories', getServiceCategoriesTool, 'getServiceCategories'],
  ] as const)('%s pages every ID exactly once', async (_name, tool, method) => {
    const rows = Array.from({ length: 57 }, (_, i) => ({
      id: 57 - i,
      title: `Item ${i}`,
      name: `Member ${i}`,
    }));
    const client = { [method]: jest.fn().mockResolvedValue(rows) };
    const ids: number[] = [];
    let page: number | null = 1;
    while (page !== null) {
      const result = await tool.createHandler(client as never)({
        location_id: 1,
        page,
      });
      expect(result.isError).toBeUndefined();
      const data = result.structuredContent as {
        items: { id: number }[];
        pagination: {
          returned: number;
          page_size: number;
          total: number;
          next_page: number | null;
        };
      };
      expect(data.pagination.returned).toBe(data.items.length);
      expect(data.pagination.returned).toBeLessThanOrEqual(25);
      expect(data.pagination.page_size).toBe(25);
      expect(data.pagination.total).toBe(57);
      ids.push(...data.items.map((row) => row.id));
      page = data.pagination.next_page;
      expect(ids.length).toBeLessThanOrEqual(57);
    }
    expect(ids).toEqual(Array.from({ length: 57 }, (_, i) => i + 1));
    expect(rows[0]?.id).toBe(57);
  });

  it('returns an empty terminal page beyond the collection', async () => {
    const client = { getStaff: jest.fn().mockResolvedValue([{ id: 1 }]) };
    const result = await getStaffTool.createHandler(client as never)({
      location_id: 1,
      page: 2,
    });
    expect(result.structuredContent).toMatchObject({
      items: [],
      pagination: { returned: 0, total: 1, next_page: null, page: 2 },
    });
  });

  it('sends a bounded default page upstream for appointments', async () => {
    const client = { getBookings: jest.fn().mockResolvedValue([]) };
    const result = await getAppointmentsTool.createHandler(client as never)({
      location_id: 1,
    });
    expect(client.getBookings).toHaveBeenCalledWith(1, { page: 1, count: 25 });
    expect(result.structuredContent).toMatchObject({
      pagination: {
        returned: 0,
        next_page: null,
        page: 1,
        page_size: 25,
        total: null,
      },
    });
  });
});

it('rejects misspelled arguments before any upstream read', async () => {
  const client = { getStaff: jest.fn() };
  const result = await getStaffTool.createHandler(client as never)({
    location_id: 1,
    count: 10,
  });
  expect(result.isError).toBe(true);
  expect(result.content[0]?.text).toContain('count');
  expect(client.getStaff).not.toHaveBeenCalled();
  expect(getStaffTool.toMcpTool().inputSchema.additionalProperties).toBe(false);
});
