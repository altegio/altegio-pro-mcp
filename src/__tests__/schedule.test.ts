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

    // Root cause of the 422: the backend expects the per-entry key `staff_id`,
    // but the public OpenAPI documents `team_member_id`, and the controller
    // validates with a strict Symfony Collection (no missing/extra keys). The
    // MCP keeps the canonical `team_member_id` and maps it to `staff_id` on the
    // wire. These tests pin that mapping.
    it('should PUT /company/{id}/staff/schedule mapping team_member_id → staff_id (set)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: [
            {
              staff_id: 456,
              date: '2025-10-30',
              slots: [
                { from: '09:00', to: '13:00' },
                { from: '14:00', to: '18:00' },
              ],
            },
          ],
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

      await client.setSchedule(123, {
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
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/company/123/staff/schedule',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer partner123, User user456',
          }),
          body: JSON.stringify({
            schedules_to_set: [
              {
                staff_id: 456,
                dates: ['2025-10-30', '2025-10-31'],
                slots: [
                  { from: '09:00', to: '13:00' },
                  { from: '14:00', to: '18:00' },
                ],
              },
            ],
          }),
        })
      );

      // No `team_member_id` key must reach the wire (it would fail validation).
      const sentBody = JSON.parse(
        (global.fetch as jest.Mock).mock.calls[0][1].body as string
      );
      expect(sentBody.schedules_to_set[0]).toHaveProperty('staff_id', 456);
      expect(sentBody.schedules_to_set[0]).not.toHaveProperty('team_member_id');
    });

    it('should PUT schedules_to_delete mapping team_member_id → staff_id (no slots)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
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

      await client.setSchedule(123, {
        schedules_to_delete: [
          {
            team_member_id: 456,
            dates: ['2025-10-30'],
          },
        ],
      });

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.alteg.io/api/v1/company/123/staff/schedule',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({
            schedules_to_delete: [{ staff_id: 456, dates: ['2025-10-30'] }],
          }),
        })
      );
    });

    it('should batch multiple team members in ONE request', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [] }),
      });
      global.fetch = fetchMock;

      const testDir = join(tmpdir(), `altegio-test-${Date.now()}`);
      const client = new AltegioClient(
        {
          apiBase: 'https://api.alteg.io/api/v1',
          partnerToken: 'partner123',
          userToken: 'user456',
        },
        testDir
      );

      await client.setSchedule(123, {
        schedules_to_set: [
          {
            team_member_id: 456,
            dates: ['2025-10-30'],
            slots: [{ from: '10:00', to: '18:00' }],
          },
          {
            team_member_id: 789,
            dates: ['2025-10-30'],
            slots: [{ from: '11:00', to: '19:00' }],
          },
        ],
      });

      // Modern endpoint accepts all team members in a single call.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sentBody = JSON.parse(fetchMock.mock.calls[0][1].body as string);
      expect(
        sentBody.schedules_to_set.map((s: { staff_id: number }) => s.staff_id)
      ).toEqual([456, 789]);
    });

    // Regression for the schedule-422 bug: setting a schedule then reading it
    // back must yield working slots for the dates that were set.
    it('sets a schedule and reads it back with slots', async () => {
      const fetchMock = jest
        .fn()
        // 1) PUT set — modern endpoint returns the resulting schedules.
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: [
              {
                staff_id: 447367,
                date: '2026-09-14',
                slots: [{ from: '10:00', to: '18:00' }],
              },
            ],
          }),
        })
        // 2) GET read-back — returns the working days with their slots.
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: [
              {
                date: '2026-09-14',
                is_working: true,
                slots: [{ from: '10:00', to: '18:00' }],
              },
            ],
          }),
        });
      global.fetch = fetchMock;

      const testDir = join(tmpdir(), `altegio-test-${Date.now()}`);
      const client = new AltegioClient(
        {
          apiBase: 'https://api.alteg.io/api/v1',
          partnerToken: 'partner123',
          userToken: 'user456',
        },
        testDir
      );

      const setResult = await client.setSchedule(4564, {
        schedules_to_set: [
          {
            team_member_id: 447367,
            dates: ['2026-09-14'],
            slots: [{ from: '10:00', to: '18:00' }],
          },
        ],
      });
      expect(setResult[0]?.slots).toEqual([{ from: '10:00', to: '18:00' }]);

      const readBack = await client.getSchedule(
        4564,
        447367,
        '2026-09-14',
        '2026-09-14'
      );

      expect(readBack).toHaveLength(1);
      expect(readBack[0]?.slots).toEqual([{ from: '10:00', to: '18:00' }]);
      expect(readBack[0]?.date).toBe('2026-09-14');
    });
  });
});
