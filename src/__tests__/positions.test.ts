import { AltegioClient } from '../providers/altegio-client';
import { tmpdir } from 'os';
import { join } from 'path';

describe('AltegioClient Position Operations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getPositions', () => {
    it('should require user token', async () => {
      const testDir = join(tmpdir(), `altegio-test-${Date.now()}`);
      const client = new AltegioClient(
        {
          apiBase: 'https://api.altegio.com',
          partnerToken: 'partner123',
          userToken: undefined,
        },
        testDir
      );

      await expect(client.getPositions(123)).rejects.toThrow(
        'Not authenticated'
      );
    });

    it('should call positions endpoint with correct parameters', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: [{ id: 1, title: 'Manager' }],
        }),
      });

      const testDir = join(tmpdir(), `altegio-test-${Date.now()}`);
      const client = new AltegioClient(
        {
          apiBase: 'https://api.alteg.io/api/v1',
          partnerToken: 'partner123',
          userToken: 'user456',
        },
        testDir
      );

      await client.getPositions(123);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/positions/123',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer partner123, User user456',
          }),
        })
      );
    });
  });

  describe('createPosition', () => {
    it('should require user token', async () => {
      const testDir = join(tmpdir(), `altegio-test-${Date.now()}`);
      const client = new AltegioClient(
        {
          apiBase: 'https://api.altegio.com',
          partnerToken: 'partner123',
          userToken: undefined,
        },
        testDir
      );

      await expect(
        client.createPosition(123, { title: 'Manager' })
      ).rejects.toThrow('Not authenticated');
    });

    it('should call POST /positions endpoint', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: { id: 1, title: 'Manager' },
        }),
      });

      const testDir = join(tmpdir(), `altegio-test-${Date.now()}`);
      const client = new AltegioClient(
        {
          apiBase: 'https://api.alteg.io/api/v1',
          partnerToken: 'partner123',
          userToken: 'user456',
        },
        testDir
      );

      await client.createPosition(123, { title: 'Manager' });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/positions/123',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({ title: 'Manager' }),
        })
      );
    });
  });

  describe('updatePosition', () => {
    it('should call PUT endpoint', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          data: { id: 1, title: 'Senior Manager' },
        }),
      });

      const testDir = join(tmpdir(), `altegio-test-${Date.now()}`);
      const client = new AltegioClient(
        {
          apiBase: 'https://api.alteg.io/api/v1',
          partnerToken: 'partner123',
          userToken: 'user456',
        },
        testDir
      );

      await client.updatePosition(123, 1, { title: 'Senior Manager' });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/positions/123/1',
        expect.objectContaining({
          method: 'PUT',
        })
      );
    });
  });

  describe('deletePosition', () => {
    it('should call DELETE endpoint', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
      });

      const testDir = join(tmpdir(), `altegio-test-${Date.now()}`);
      const client = new AltegioClient(
        {
          apiBase: 'https://api.alteg.io/api/v1',
          partnerToken: 'partner123',
          userToken: 'user456',
        },
        testDir
      );

      await client.deletePosition(123, 1);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/positions/123/1',
        expect.objectContaining({
          method: 'DELETE',
        })
      );
    });
  });
});
