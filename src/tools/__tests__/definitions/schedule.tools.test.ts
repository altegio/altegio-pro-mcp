import {
  getScheduleTool,
  createScheduleTool,
  updateScheduleTool,
  deleteScheduleTool,
} from '../../definitions/schedule.tools.js';

describe('Schedule Tools', () => {
  const mockClient = {
    isAuthenticated: jest.fn(),
    getSchedule: jest.fn(),
    createSchedule: jest.fn(),
    updateSchedule: jest.fn(),
    deleteSchedule: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.isAuthenticated.mockReturnValue(true);
  });

  describe('getScheduleTool', () => {
    it('requires auth', () => {
      expect(getScheduleTool.meta.requiresAuth).toBe(true);
    });

    it('fetches and formats schedule', async () => {
      mockClient.getSchedule.mockResolvedValue([
        {
          date: '2025-01-15',
          time: '09:00',
          seance_length: 60,
          datetime: '2025-01-15 09:00:00',
        },
      ]);

      const handler = getScheduleTool.createHandler(mockClient);
      const result = await handler({
        company_id: 123,
        staff_id: 1,
        start_date: '2025-01-15',
        end_date: '2025-01-20',
      });

      expect(result.content[0]?.text).toContain('2025-01-15');
      expect(result.content[0]?.text).toContain('09:00');
      expect(mockClient.getSchedule).toHaveBeenCalledWith(
        123,
        1,
        '2025-01-15',
        '2025-01-20'
      );
    });
  });

  describe('createScheduleTool', () => {
    it('requires auth', () => {
      expect(createScheduleTool.meta.requiresAuth).toBe(true);
    });

    it('creates schedule', async () => {
      mockClient.createSchedule.mockResolvedValue([
        { date: '2025-01-15', time: '09:00' },
      ]);

      const handler = createScheduleTool.createHandler(mockClient);
      const result = await handler({
        company_id: 123,
        staff_id: 1,
        date: '2025-01-15',
        time_from: '09:00',
        time_to: '17:00',
        seance_length: 30,
      });

      expect(result.content[0]?.text).toContain('Successfully created');
      expect(result.content[0]?.text).toContain('2025-01-15');
    });
  });

  describe('updateScheduleTool', () => {
    it('requires auth', () => {
      expect(updateScheduleTool.meta.requiresAuth).toBe(true);
    });

    it('updates schedule', async () => {
      mockClient.updateSchedule.mockResolvedValue([
        { date: '2025-01-15', time: '10:00' },
      ]);

      const handler = updateScheduleTool.createHandler(mockClient);
      const result = await handler({
        company_id: 123,
        staff_id: 1,
        date: '2025-01-15',
        time_from: '10:00',
        time_to: '18:00',
      });

      expect(result.content[0]?.text).toContain('Successfully updated');
      expect(result.content[0]?.text).toContain('2025-01-15');
    });
  });

  describe('deleteScheduleTool', () => {
    it('requires auth', () => {
      expect(deleteScheduleTool.meta.requiresAuth).toBe(true);
    });

    it('deletes schedule', async () => {
      mockClient.deleteSchedule.mockResolvedValue(undefined);

      const handler = deleteScheduleTool.createHandler(mockClient);
      const result = await handler({
        company_id: 123,
        staff_id: 1,
        date: '2025-01-15',
      });

      expect(result.content[0]?.text).toContain('Successfully deleted');
      expect(mockClient.deleteSchedule).toHaveBeenCalledWith(
        123,
        1,
        '2025-01-15'
      );
    });
  });
});
