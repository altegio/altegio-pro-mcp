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

    it('reads the list and maps each position', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: [
            {
              type: 'position',
              id: '1',
              attributes: {
                chain_id: 9,
                title: 'Manager',
                description: '',
                salon_ids: [123],
              },
            },
          ],
          meta: [],
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

      await expect(client.getPositions(123)).resolves.toEqual([
        { id: 1, title: 'Manager', description: null },
      ]);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/../v2/locations/123/positions',
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

    it('creates the position with its description', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          data: {
            type: 'position',
            id: '7',
            attributes: { title: 'Manager', description: 'Runs the floor' },
          },
          meta: [],
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

      await expect(
        client.createPosition(123, {
          title: 'Manager',
          description: 'Runs the floor',
        })
      ).resolves.toEqual({
        id: 7,
        title: 'Manager',
        description: 'Runs the floor',
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/../v2/locations/123/positions',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            title: 'Manager',
            description: 'Runs the floor',
          }),
        })
      );
    });
  });

  describe('deletePosition', () => {
    it('deletes by id', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });

      const testDir = join(tmpdir(), `altegio-test-${Date.now()}`);
      const client = new AltegioClient(
        {
          apiBase: 'https://api.alteg.io/api/v1',
          partnerToken: 'partner123',
          userToken: 'user456',
        },
        testDir
      );

      await client.deletePosition(123, 7);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/../v2/locations/123/positions/7',
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });
});
