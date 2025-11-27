import { ToolHandlers } from '../handlers.js';
import { AltegioClient } from '../../providers/altegio-client.js';

jest.mock('../../providers/altegio-client.js');

describe('ToolHandlers - Services CRUD', () => {
  let handlers: ToolHandlers;
  let mockClient: jest.Mocked<AltegioClient>;

  beforeEach(() => {
    mockClient = {
      createService: jest.fn(),
      updateService: jest.fn(),
    } as any;
    handlers = new ToolHandlers(mockClient);
  });

  describe('createService', () => {
    it('should create service successfully', async () => {
      const mockService = { id: 789, title: 'Haircut', category_id: 10 };
      mockClient.createService.mockResolvedValue(mockService as any);

      const result = await handlers.createService({
        company_id: 456,
        title: 'Haircut',
        category_id: 10,
      });

      expect((result.content[0] as any).text).toContain('Successfully created service');
      expect((result.content[0] as any).text).toContain('Haircut');
      expect(mockClient.createService).toHaveBeenCalledWith(456, {
        title: 'Haircut',
        category_id: 10,
      });
    });

    it('should handle errors', async () => {
      mockClient.createService.mockRejectedValue(
        new Error('Not authenticated')
      );

      const result = await handlers.createService({
        company_id: 456,
        title: 'Test',
        category_id: 1,
      });

      expect((result.content[0] as any).text).toContain('Failed to create service');
    });
  });

  describe('updateService', () => {
    it('should update service successfully', async () => {
      const mockService = { id: 789, title: 'New Haircut' };
      mockClient.updateService.mockResolvedValue(mockService as any);

      const result = await handlers.updateService({
        company_id: 456,
        service_id: 789,
        title: 'New Haircut',
      });

      expect((result.content[0] as any).text).toContain('Successfully updated service');
      expect(mockClient.updateService).toHaveBeenCalledWith(456, 789, {
        title: 'New Haircut',
      });
    });
  });
});
