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

  describe('setSchedule', () => {
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
        client.setSchedule(123, {
          schedules_to_set: [
            {
              team_member_id: 456,
              dates: ['2025-10-30'],
              slots: [{ from: '09:00', to: '18:00' }],
            },
          ],
        })
      ).rejects.toThrow('Not authenticated');
    });

    it('should call PUT /company/{id}/staff/schedule with schedules_to_set', async () => {
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
        schedules_to_set: [
          {
            team_member_id: 456,
            dates: ['2025-10-30', '2025-10-31'],
            slots: [
              { from: '09:00', to: '13:00' },
              { from: '14:00', to: '18:00' },
            ],
          },
        ],
      };

      await client.setSchedule(123, scheduleData);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/company/123/staff/schedule',
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

    it('should call PUT /company/{id}/staff/schedule with schedules_to_delete', async () => {
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
        schedules_to_delete: [
          {
            team_member_id: 456,
            dates: ['2025-10-30'],
          },
        ],
      };

      await client.setSchedule(123, scheduleData);

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/company/123/staff/schedule',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify(scheduleData),
        })
      );
    });
  });
});
