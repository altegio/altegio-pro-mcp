import {
  getServicesTool,
  createServiceTool,
  updateServiceTool,
} from '../../definitions/services.tools.js';

describe('Services Tools', () => {
  const mockClient = {
    isAuthenticated: jest.fn(),
    getServices: jest.fn(),
    createService: jest.fn(),
    updateService: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.isAuthenticated.mockReturnValue(true);
  });

  describe('getServicesTool', () => {
    it('requires auth', () => {
      expect(getServicesTool.meta.requiresAuth).toBe(true);
    });

    it('fetches and formats services list', async () => {
      mockClient.getServices.mockResolvedValue([
        { id: 1, title: 'Haircut', cost: 50, duration: 30, category_id: 5 },
      ]);

      const handler = getServicesTool.createHandler(mockClient);
      const result = await handler({ company_id: 123 });

      expect(result.content[0]?.text).toContain('Haircut');
      expect(result.content[0]?.text).toContain('50');
      expect(mockClient.getServices).toHaveBeenCalledWith(123, {});
    });
  });

  describe('createServiceTool', () => {
    it('requires auth', () => {
      expect(createServiceTool.meta.requiresAuth).toBe(true);
    });

    it('creates service', async () => {
      mockClient.createService.mockResolvedValue({
        id: 99,
        title: 'New Service',
        category_id: 5,
      });

      const handler = createServiceTool.createHandler(mockClient);
      const result = await handler({
        company_id: 123,
        title: 'New Service',
        category_id: 5,
        price_min: 100,
        price_max: 200,
        duration: 60,
      });

      expect(result.content[0]?.text).toContain('Successfully created');
      expect(result.content[0]?.text).toContain('99');
      expect(result.content[0]?.text).toContain('New Service');
    });
  });

  describe('updateServiceTool', () => {
    it('requires auth', () => {
      expect(updateServiceTool.meta.requiresAuth).toBe(true);
    });

    it('updates service', async () => {
      mockClient.updateService.mockResolvedValue({
        id: 1,
        title: 'Updated Service',
      });

      const handler = updateServiceTool.createHandler(mockClient);
      const result = await handler({
        company_id: 123,
        service_id: 1,
        title: 'Updated Service',
      });

      expect(result.content[0]?.text).toContain('Successfully updated');
      expect(result.content[0]?.text).toContain('Updated Service');
    });
  });
});
