import { ToolHandlers } from '../handlers.js';
import { AltegioClient } from '../../providers/altegio-client.js';
import { AuthenticationError } from '../../utils/errors.js';

jest.mock('../../providers/altegio-client.js');

describe('ToolHandlers - Services CRUD', () => {
  let handlers: ToolHandlers;
  let mockClient: jest.Mocked<AltegioClient>;

  beforeEach(() => {
    mockClient = {
      getServices: jest.fn(),
      createService: jest.fn(),
      updateService: jest.fn(),
    } as any;
    handlers = new ToolHandlers(mockClient);
  });

  describe('getServices', () => {
    it('projects V1 prices, active state, duration and team-member links without undefined text', async () => {
      mockClient.getServices.mockResolvedValue([
        {
          id: 789,
          title: 'Haircut',
          category_id: 10,
          price_min: 100,
          price_max: 150,
          duration: 3600,
          active: 1,
          staff: [{ id: 123, seance_length: 3600 }],
        },
      ] as any);

      const result = await handlers.getServices({ location_id: 456, page: 1 });

      expect(result.content[0]?.text).toContain('Price: 100–150');
      expect(result.content[0]?.text).toContain('Active: true');
      expect(result.content[0]?.text).not.toContain('undefined');
      expect(result.structuredContent).toMatchObject({
        items: [
          {
            id: 789,
            price_min: 100,
            price_max: 150,
            duration_seconds: 3600,
            active: true,
            team_members: [
              { team_member_id: 123, session_length_seconds: 3600 },
            ],
          },
        ],
      });
      expect(mockClient.getServices).toHaveBeenCalledWith(456, { page: 1 });
    });
  });

  describe('createService', () => {
    it('should create service successfully', async () => {
      const mockService = { id: 789, title: 'Haircut', category_id: 10 };
      mockClient.createService.mockResolvedValue(mockService as any);

      const result = await handlers.createService({
        location_id: 456,
        title: 'Haircut',
        category_id: 10,
      });

      expect((result.content[0] as any).text).toContain(
        'Successfully created service'
      );
      expect((result.content[0] as any).text).toContain('Haircut');
      expect(mockClient.createService).toHaveBeenCalledWith(456, {
        title: 'Haircut',
        category_id: 10,
        active: 1,
      });
    });

    it('should handle errors', async () => {
      mockClient.createService.mockRejectedValue(
        new AuthenticationError('Not authenticated. Call altegio_login first.')
      );

      const result = await handlers.createService({
        location_id: 456,
        title: 'Test',
        category_id: 1,
      });

      expect((result.content[0] as any).text).toContain(
        'Authentication required'
      );
    });
  });

  describe('updateService', () => {
    it('should update service successfully', async () => {
      const mockService = { id: 789, title: 'New Haircut' };
      mockClient.updateService.mockResolvedValue(mockService as any);

      const result = await handlers.updateService({
        location_id: 456,
        service_id: 789,
        title: 'New Haircut',
      });

      expect((result.content[0] as any).text).toContain(
        'Successfully updated service'
      );
      expect(mockClient.updateService).toHaveBeenCalledWith(456, 789, {
        title: 'New Haircut',
      });
    });
  });
});
