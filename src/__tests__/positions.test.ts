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

      // Correct endpoint: /company/{company_id}/staff/positions/
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/company/123/staff/positions/',
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

    it('should call POST /company/{id}/positions/quick/ endpoint', async () => {
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
        'https://api.alteg.io/api/v1/company/123/positions/quick/',
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

  // NOTE: updatePosition and deletePosition tests removed
  // API does not support PUT/DELETE for positions
  // PUT /company/{id}/positions/{id} returns "An error has occurred"
  // DELETE /company/{id}/positions/{id} returns "An error has occurred"
});
