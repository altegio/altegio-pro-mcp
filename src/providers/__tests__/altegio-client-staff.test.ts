import { AltegioClient } from '../altegio-client.js';
import type { AltegioConfig } from '../../types/altegio.types.js';

describe('AltegioClient - Staff CRUD', () => {
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

  describe('createStaff', () => {
    it('should create staff successfully', async () => {
      const mockResponse = {
        success: true,
        data: { id: 123, name: 'John Doe' },
        meta: {},
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => mockResponse,
      });

      const result = await client.createStaff(456, {
        name: 'John Doe',
        specialization: 'Stylist',
        position_id: 1,
        phone_number: '1234567890',
        user_email: 'john@example.com',
        user_phone: '1234567890',
        is_user_invite: true,
      });

      expect(result.id).toBe(123);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/company/456/staff/quick'),
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        })
      );
    });

    it('should throw error when not authenticated', async () => {
      const unauthClient = new AltegioClient(
        { partnerToken: 'test' },
        '/tmp/test'
      );

      await expect(
        unauthClient.createStaff(456, {
          name: 'John',
          specialization: 'Stylist',
          position_id: 1,
          phone_number: '123',
          user_email: 'john@example.com',
          user_phone: '1234567890',
          is_user_invite: true,
        })
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('updateStaff', () => {
    it('should update staff successfully', async () => {
      const mockResponse = {
        success: true,
        data: { id: 123, name: 'John Smith' },
        meta: {},
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const result = await client.updateStaff(456, 123, { name: 'John Smith' });

      expect(result.name).toBe('John Smith');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/staff/456/123'),
        expect.objectContaining({ method: 'PUT' })
      );
    });
  });

  describe('deleteStaff', () => {
    it('should delete staff successfully', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await client.deleteStaff(456, 123);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/staff/456/123'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });
});
