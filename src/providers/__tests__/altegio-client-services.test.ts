import { AltegioClient } from '../altegio-client.js';
import type { AltegioConfig } from '../../types/altegio.types.js';

describe('AltegioClient - Services CRUD', () => {
  let client: AltegioClient;
  const mockConfig: AltegioConfig = {
    partnerToken: 'test-token',
    userToken: 'test-user-token',
  };

  beforeEach(() => {
    client = new AltegioClient(mockConfig, '/tmp/test-credentials');
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createService', () => {
    it('should create service successfully', async () => {
      const mockResponse = {
        success: true,
        data: { id: 789, title: 'Haircut' },
        meta: {},
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => mockResponse,
      });

      const result = await client.createService(456, {
        title: 'Haircut',
        category_id: 10,
      });

      expect(result.id).toBe(789);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/services/456'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should throw error when not authenticated', async () => {
      const unauthClient = new AltegioClient(
        { partnerToken: 'test' },
        '/tmp/test'
      );

      await expect(
        unauthClient.createService(456, { title: 'Test', category_id: 1 })
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('updateService', () => {
    it('should update service successfully', async () => {
      const mockResponse = {
        success: true,
        data: { id: 789, title: 'New Haircut' },
        meta: {},
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const result = await client.updateService(456, 789, {
        title: 'New Haircut',
      });

      expect(result.title).toBe('New Haircut');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/services/456/services/789'),
        expect.objectContaining({ method: 'PATCH' })
      );
    });
  });
});
