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

    // The modern PUT /company/{id}/staff/schedule ({schedules_to_set}) returns
    // 422 for spec-correct input; setSchedule instead calls the deprecated
    // per-team-member endpoint with a [{date,is_working,slots}] body — the shape
    // the API accepts (docs/api-monitoring.arazzo.yaml). These assert that shape.
    it('should PUT /schedule/{loc}/{staff} with an is_working day array (set)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({}),
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

      const result = await client.setSchedule(123, {
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
        'https://api.alteg.io/api/v1/schedule/123/456',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            Authorization: 'Bearer partner123, User user456',
          }),
          body: JSON.stringify([
            {
              date: '2025-10-30',
              is_working: true,
              slots: [
                { from: '09:00', to: '13:00' },
                { from: '14:00', to: '18:00' },
              ],
            },
            {
              date: '2025-10-31',
              is_working: true,
              slots: [
                { from: '09:00', to: '13:00' },
                { from: '14:00', to: '18:00' },
              ],
            },
          ]),
        })
      );

      // Returns synthesized entries carrying the slots that were set.
      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        staff_id: 456,
        date: '2025-10-30',
        slots: [
          { from: '09:00', to: '13:00' },
          { from: '14:00', to: '18:00' },
        ],
      });
    });

    it('should PUT is_working:false days for schedules_to_delete', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({}),
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
        'https://api.alteg.io/api/v1/schedule/123/456',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify([
            { date: '2025-10-30', is_working: false, slots: [] },
          ]),
        })
      );
    });

    it('should issue one PUT per team member for a multi-staff request', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({}),
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

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const urls = fetchMock.mock.calls.map((c) => c[0]);
      expect(urls).toContain('https://api.alteg.io/api/v1/schedule/123/456');
      expect(urls).toContain('https://api.alteg.io/api/v1/schedule/123/789');
    });

    // Regression for the schedule-422 bug: setting a schedule then reading it
    // back must yield working slots for the dates that were set.
    it('sets a schedule and reads it back with slots', async () => {
      const fetchMock = jest
        .fn()
        // 1) PUT set — deprecated endpoint responds 201 with an empty body.
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          json: async () => ({}),
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

      await client.setSchedule(4564, {
        schedules_to_set: [
          {
            team_member_id: 447367,
            dates: ['2026-09-14'],
            slots: [{ from: '10:00', to: '18:00' }],
          },
        ],
      });

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
