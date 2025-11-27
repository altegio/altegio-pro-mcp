import { ToolHandlers } from '../handlers.js';
import { AltegioClient } from '../../providers/altegio-client.js';

jest.mock('../../providers/altegio-client.js');

describe('ToolHandlers - Bookings CRUD', () => {
  let handlers: ToolHandlers;
  let mockClient: jest.Mocked<AltegioClient>;

  beforeEach(() => {
    mockClient = {
      createBooking: jest.fn(),
      updateBooking: jest.fn(),
      deleteBooking: jest.fn(),
    } as any;
    handlers = new ToolHandlers(mockClient);
  });

  describe('createBooking', () => {
    it('should create booking successfully', async () => {
      const mockBooking = {
        id: 999,
        staff_id: 123,
        datetime: '2025-11-01T10:00:00',
      };
      mockClient.createBooking.mockResolvedValue(mockBooking as any);

      const result = await handlers.createBooking({
        company_id: 456,
        staff_id: 123,
        services: [{ id: 789 }],
        datetime: '2025-11-01T10:00:00',
        client: { name: 'Jane', phone: '9876543210' },
      });

      expect(result.content[0]?.text).toContain('Successfully created booking');
      expect(result.content[0]?.text).toContain('999');
      expect(mockClient.createBooking).toHaveBeenCalledWith(456, {
        staff_id: 123,
        services: [{ id: 789 }],
        datetime: '2025-11-01T10:00:00',
        client: { name: 'Jane', phone: '9876543210' },
      });
    });

    it('should handle errors', async () => {
      mockClient.createBooking.mockRejectedValue(
        new Error('Not authenticated')
      );

      const result = await handlers.createBooking({
        company_id: 456,
        staff_id: 123,
        services: [{ id: 789 }],
        datetime: '2025-11-01T10:00:00',
        client: { name: 'Jane', phone: '123' },
      });

      expect(result.content[0]?.text).toContain('Failed to create booking');
    });
  });

  describe('updateBooking', () => {
    it('should update booking successfully', async () => {
      const mockBooking = { id: 999, datetime: '2025-11-02T10:00:00' };
      mockClient.updateBooking.mockResolvedValue(mockBooking as any);

      const result = await handlers.updateBooking({
        company_id: 456,
        record_id: 999,
        datetime: '2025-11-02T10:00:00',
      });

      expect(result.content[0]?.text).toContain('Successfully updated booking');
      expect(mockClient.updateBooking).toHaveBeenCalledWith(456, 999, {
        datetime: '2025-11-02T10:00:00',
      });
    });
  });

  describe('deleteBooking', () => {
    it('should delete booking successfully', async () => {
      mockClient.deleteBooking.mockResolvedValue(undefined);

      const result = await handlers.deleteBooking({
        company_id: 456,
        record_id: 999,
      });

      expect(result.content[0]?.text).toContain('Successfully deleted booking');
      expect(mockClient.deleteBooking).toHaveBeenCalledWith(456, 999);
    });
  });
});
