import { AltegioClient } from '../providers/altegio-client';
import { tmpdir } from 'os';
import { join } from 'path';

describe('AltegioClient Schedule Operations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getSchedule', () => {
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
        client.getSchedule(123, 456, '2025-10-27', '2025-10-28')
      ).rejects.toThrow('Not authenticated');
    });

    it('should call schedule endpoint with correct parameters', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [] }),
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

      await client.getSchedule(123, 456, '2025-10-27', '2025-10-28');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/schedule/123/456/2025-10-27/2025-10-28',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer partner123, User user456',
          }),
        })
      );
    });
  });

  describe('createSchedule', () => {
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
        client.createSchedule(123, {
          staff_id: 456,
          date: '2025-10-30',
          time_from: '09:00',
          time_to: '18:00',
        })
      ).rejects.toThrow('Not authenticated');
    });

    it('should call PUT /schedule endpoint with correct data', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [] }),
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

      const scheduleData = {
        staff_id: 456,
        date: '2025-10-30',
        time_from: '09:00',
        time_to: '18:00',
        seance_length: 30,
      };

      await client.createSchedule(123, scheduleData);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/schedule/123',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer partner123, User user456',
          }),
          body: JSON.stringify(scheduleData),
        })
      );
    });
  });

  describe('updateSchedule', () => {
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
        client.updateSchedule(123, {
          staff_id: 456,
          date: '2025-10-30',
          time_from: '10:00',
        })
      ).rejects.toThrow('Not authenticated');
    });

    it('should call PUT /schedule endpoint with update data', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ success: true, data: [] }),
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

      const updateData = {
        staff_id: 456,
        date: '2025-10-30',
        time_from: '10:00',
        time_to: '17:00',
      };

      await client.updateSchedule(123, updateData);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/schedule/123',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify(updateData),
        })
      );
    });
  });

  describe('deleteSchedule', () => {
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
        client.deleteSchedule(123, 456, '2025-10-30')
      ).rejects.toThrow('Not authenticated');
    });

    it('should call DELETE endpoint with correct parameters', async () => {
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

      await client.deleteSchedule(123, 456, '2025-10-30');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/schedule/123/456/2025-10-30',
        expect.objectContaining({
          method: 'DELETE',
          headers: expect.objectContaining({
            Authorization: 'Bearer partner123, User user456',
          }),
        })
      );
    });
  });
});
