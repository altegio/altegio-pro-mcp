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
    it('defaults to an active service and supports an active read-back', async () => {
      const mockResponse = {
        success: true,
        data: { id: 789, title: 'Haircut', active: 1 },
        meta: {},
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => mockResponse,
      });
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [{ id: 789, title: 'Haircut', active: 1, staff: [] }],
          meta: {},
        }),
      });

      const result = await client.createService(456, {
        title: 'Haircut',
        category_id: 10,
      });

      expect(result.id).toBe(789);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/services/456'),
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            title: 'Haircut',
            category_id: 10,
            active: 1,
          }),
        })
      );
      const readBack = await client.getService(456, result.id);
      expect(readBack.active).toBe(1);
      expect(global.fetch).toHaveBeenLastCalledWith(
        expect.stringContaining('/services/456/789'),
        expect.any(Object)
      );
    });

    it('honors an explicit inactive draft', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          success: true,
          data: { id: 789, title: 'Draft', active: 0 },
          meta: {},
        }),
      });

      await client.createService(456, {
        title: 'Draft',
        category_id: 10,
        active: 0,
      });

      const [, options] = (global.fetch as jest.Mock).mock.calls[0]!;
      expect(JSON.parse(String(options.body))).toMatchObject({ active: 0 });
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
    it('uses read-merge-PUT and preserves unchanged fields and staff links', async () => {
      const current = {
        id: 789,
        title: 'Haircut',
        category_id: 10,
        price_min: 100,
        price_max: 150,
        duration: 3600,
        discount: 0,
        comment: 'Original',
        weight: 3,
        active: 1,
        api_id: 'svc-789',
        staff: [
          {
            id: 123,
            seance_length: 3600,
            technological_card_id: 42,
          },
        ],
      };
      const mockResponse = {
        success: true,
        data: { ...current, title: 'New Haircut' },
        meta: {},
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [current], meta: {} }),
      });
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const result = await client.updateService(456, 789, {
        title: 'New Haircut',
      });

      expect(result.title).toBe('New Haircut');
      expect(global.fetch).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('/services/456/789'),
        expect.objectContaining({ headers: expect.any(Object) })
      );
      expect(global.fetch).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('/services/456/789'),
        expect.objectContaining({ method: 'PUT' })
      );
      const [, putOptions] = (global.fetch as jest.Mock).mock.calls[1]!;
      expect(JSON.parse(String(putOptions.body))).toEqual({
        title: 'New Haircut',
        category_id: 10,
        price_min: 100,
        price_max: 150,
        duration: 3600,
        discount: 0,
        comment: 'Original',
        weight: 3,
        active: 1,
        api_id: 'svc-789',
        staff: [
          {
            id: 123,
            seance_length: 3600,
            technological_card_id: 42,
          },
        ],
      });
    });

    it('refuses a replacement update when the read omits staff links', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [{ id: 789, title: 'Haircut' }],
          meta: {},
        }),
      });

      await expect(
        client.updateService(456, 789, { title: 'Unsafe' })
      ).rejects.toThrow(/did not include its team-member links/);
      expect(global.fetch).toHaveBeenCalledTimes(1);
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
