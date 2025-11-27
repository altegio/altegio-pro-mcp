import { AltegioClient } from '../altegio-client.js';
import type { AltegioConfig } from '../../types/altegio.types.js';

describe('AltegioClient - Bookings CRUD', () => {
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

  describe('createBooking', () => {
    it('should create booking successfully', async () => {
      const mockResponse = {
        success: true,
        data: { id: 999, staff_id: 123 },
        meta: {},
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => mockResponse,
      });

      const result = await client.createBooking(456, {
        staff_id: 123,
        services: [{ id: 789 }],
        datetime: '2025-11-01T10:00:00',
        client: { name: 'Jane', phone: '9876543210' },
      });

      expect(result.id).toBe(999);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/records/456'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should throw error when not authenticated', async () => {
      const unauthClient = new AltegioClient(
        { partnerToken: 'test' },
        '/tmp/test'
      );

      await expect(
        unauthClient.createBooking(456, {
          staff_id: 123,
          services: [{ id: 789 }],
          datetime: '2025-11-01T10:00:00',
          client: { name: 'Jane', phone: '123' },
        })
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('updateBooking', () => {
    it('should update booking successfully', async () => {
      const mockResponse = {
        success: true,
        data: { id: 999, datetime: '2025-11-02T10:00:00' },
        meta: {},
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const result = await client.updateBooking(456, 999, {
        datetime: '2025-11-02T10:00:00',
      });

      expect(result.datetime).toContain('2025-11-02');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/record/456/999'),
        expect.objectContaining({ method: 'PUT' })
      );
    });
  });

  describe('deleteBooking', () => {
    it('should delete booking successfully', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await client.deleteBooking(456, 999);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/record/456/999'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });
});
