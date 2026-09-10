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
        expect.stringContaining('/services/456/789'),
        expect.objectContaining({ method: 'PATCH' })
      );
    });
  });

  describe('deleteService', () => {
    it('should DELETE /services/{loc}/{service_id}', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await client.deleteService(456, 789);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/services/456/789'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });

    it('should throw when not authenticated', async () => {
      const unauth = new AltegioClient({ partnerToken: 'test' }, '/tmp/test');
      await expect(unauth.deleteService(456, 789)).rejects.toThrow(
        'Not authenticated'
      );
    });
  });

  describe('assignServiceToStaff', () => {
    it('should POST the link with master_id + seance_length + null tech card', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ success: true, data: { id: 1 }, meta: {} }),
      });

      await client.assignServiceToStaff(456, 789, {
        master_id: 123,
        seance_length: 3600,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/company/456/services/789/staff'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            technological_card_id: null,
            master_id: 123,
            seance_length: 3600,
          }),
        })
      );
    });
  });

  describe('updateServiceStaffAssignment', () => {
    it('should PUT the link at /staff/{team_member_id}', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { id: 1 }, meta: {} }),
      });

      await client.updateServiceStaffAssignment(456, 789, 123, {
        seance_length: 1800,
        technological_card_id: 42,
      });

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/company/456/services/789/staff/123'),
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            technological_card_id: 42,
            seance_length: 1800,
          }),
        })
      );
    });
  });

  describe('removeServiceFromStaff', () => {
    it('should DELETE the link at /staff/{team_member_id}', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await client.removeServiceFromStaff(456, 789, 123);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/company/456/services/789/staff/123'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });
});
