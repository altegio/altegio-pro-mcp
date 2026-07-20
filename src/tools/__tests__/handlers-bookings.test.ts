import { ToolHandlers } from '../handlers.js';
import { AltegioClient } from '../../providers/altegio-client.js';
import { AuthenticationError } from '../../utils/errors.js';

jest.mock('../../providers/altegio-client.js');

describe('ToolHandlers - Appointments CRUD', () => {
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

  describe('createAppointment', () => {
    it('should create appointment successfully', async () => {
      const mockBooking = {
        id: 999,
        staff_id: 123,
        datetime: '2025-11-01T10:00:00',
      };
      mockClient.createBooking.mockResolvedValue(mockBooking as any);

      const result = await handlers.createAppointment({
        location_id: 456,
        team_member_id: 123,
        services: [{ id: 789 }],
        datetime: '2025-11-01T10:00:00',
        client: { name: 'Jane', phone: '9876543210' },
      });

      expect(result.content[0]?.text).toContain(
        'Successfully created appointment'
      );
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
        new AuthenticationError('Not authenticated. Call altegio_login first.')
      );

      const result = await handlers.createAppointment({
        location_id: 456,
        team_member_id: 123,
        services: [{ id: 789 }],
        datetime: '2025-11-01T10:00:00',
        client: { name: 'Jane', phone: '123' },
      });

      expect(result.content[0]?.text).toContain('Authentication required');
    });
  });

  describe('updateAppointment', () => {
    it('should update appointment successfully', async () => {
      const mockBooking = { id: 999, datetime: '2025-11-02T10:00:00' };
      mockClient.updateBooking.mockResolvedValue(mockBooking as any);

      const result = await handlers.updateAppointment({
        location_id: 456,
        record_id: 999,
        datetime: '2025-11-02T10:00:00',
      });

      expect(result.content[0]?.text).toContain(
        'Successfully updated appointment'
      );
      expect(mockClient.updateBooking).toHaveBeenCalledWith(456, 999, {
        datetime: '2025-11-02T10:00:00',
      });
    });
  });

  describe('deleteAppointment', () => {
    it('should delete appointment successfully', async () => {
      mockClient.deleteBooking.mockResolvedValue(undefined);

      const result = await handlers.deleteAppointment({
        location_id: 456,
        record_id: 999,
      });

      expect(result.content[0]?.text).toContain(
        'Successfully deleted appointment'
      );
      expect(mockClient.deleteBooking).toHaveBeenCalledWith(456, 999);
    });
  });
});
