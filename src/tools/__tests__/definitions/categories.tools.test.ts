import { getServiceCategoriesTool } from '../../definitions/categories.tools.js';

describe('Categories Tools', () => {
  const mockClient = {
    isAuthenticated: jest.fn(),
    getServiceCategories: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.isAuthenticated.mockReturnValue(false);
  });

  describe('getServiceCategoriesTool', () => {
    it('does not require auth (public endpoint)', () => {
      expect(getServiceCategoriesTool.meta.requiresAuth).toBe(false);
    });

    it('fetches and formats categories list', async () => {
      mockClient.getServiceCategories.mockResolvedValue([
        { id: 1, title: 'Haircuts', services: [{ id: 10, title: 'Basic Cut' }] },
        { id: 2, title: 'Coloring', services: [] },
      ]);

      const handler = getServiceCategoriesTool.createHandler(mockClient);
      const result = await handler({ company_id: 123 });

      expect(result.content[0]?.text).toContain('Haircuts');
      expect(result.content[0]?.text).toContain('Coloring');
      expect(mockClient.getServiceCategories).toHaveBeenCalledWith(123, {});
    });
  });
});
