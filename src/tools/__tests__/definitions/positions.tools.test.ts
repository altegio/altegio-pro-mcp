import {
  getPositionsTool,
  createPositionTool,
} from '../../definitions/positions.tools.js';

describe('Positions Tools', () => {
  const mockClient = {
    isAuthenticated: jest.fn(),
    getPositions: jest.fn(),
    createPosition: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.isAuthenticated.mockReturnValue(true);
  });

  describe('getPositionsTool', () => {
    it('requires auth', () => {
      expect(getPositionsTool.meta.requiresAuth).toBe(true);
    });

    it('fetches and formats positions list', async () => {
      mockClient.getPositions.mockResolvedValue([
        { id: 1, title: 'Manager' },
        { id: 2, title: 'Stylist' },
      ]);

      const handler = getPositionsTool.createHandler(mockClient);
      const result = await handler({ company_id: 123 });

      expect(result.content[0]?.text).toContain('Manager');
      expect(result.content[0]?.text).toContain('Stylist');
      expect(mockClient.getPositions).toHaveBeenCalledWith(123);
    });

    it('handles empty positions list', async () => {
      mockClient.getPositions.mockResolvedValue([]);

      const handler = getPositionsTool.createHandler(mockClient);
      const result = await handler({ company_id: 123 });

      expect(result.content[0]?.text).toContain('No positions found');
    });
  });

  describe('createPositionTool', () => {
    it('requires auth', () => {
      expect(createPositionTool.meta.requiresAuth).toBe(true);
    });

    it('creates position', async () => {
      mockClient.createPosition.mockResolvedValue({
        id: 99,
        title: 'New Position',
      });

      const handler = createPositionTool.createHandler(mockClient);
      const result = await handler({
        company_id: 123,
        title: 'New Position',
        api_id: 'pos_123',
      });

      expect(result.content[0]?.text).toContain('Successfully created');
      expect(result.content[0]?.text).toContain('99');
      expect(result.content[0]?.text).toContain('New Position');
    });
  });

  // NOTE: updatePositionTool and deletePositionTool tests removed
  // API does not support PUT/DELETE for positions
  // PUT /company/{id}/positions/{id} returns "An error has occurred"
  // DELETE /company/{id}/positions/{id} returns "An error has occurred"
});
