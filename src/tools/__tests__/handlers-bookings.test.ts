import { ToolHandlers } from '../handlers.js';
import { AltegioClient } from '../../providers/altegio-client.js';
import { AuthenticationError } from '../../utils/errors.js';

jest.mock('../../providers/altegio-client.js');

describe('ToolHandlers - Appointments CRUD', () => {
  let handlers: ToolHandlers;
  let mockClient: jest.Mocked<AltegioClient>;

  beforeEach(() => {
    mockClient = {
      getBookings: jest.fn(),
      createBooking: jest.fn(),
      updateBooking: jest.fn(),
      deleteBooking: jest.fn(),
    } as any;
    handlers = new ToolHandlers(mockClient);
  });

  describe('getAppointments', () => {
    it('derives a canonical visit status and useful fields without undefined text', async () => {
      mockClient.getBookings.mockResolvedValue([
        {
          id: 999,
          company_id: 456,
          staff_id: 123,
          staff: { id: 123, name: 'Alex' },
          client: { id: 321, name: 'Jane', phone: '555' },
          services: [{ id: 789, title: 'Haircut', cost: 100, amount: 2 }],
          datetime: '2026-09-10T10:00:00+02:00',
          date: '2026-09-10T10:00:00+02:00',
          attendance: 0,
          confirmed: 1,
          seance_length: 3600,
          visit_id: 42,
          paid_full: 1,
          online: true,
          deleted: false,
        },
      ] as any);

      const result = await handlers.getAppointments({
        location_id: 456,
        page: 1,
      });

      expect(result.content[0]?.text).toContain('Visit status: confirmed');
      expect(result.content[0]?.text).toContain('Total cost: 200');
      expect(result.content[0]?.text).not.toContain('undefined');
      expect(result.structuredContent).toMatchObject({
        items: [
          {
            id: 999,
            location_id: 456,
            status: 'confirmed',
            client_id: 321,
            total_cost: 200,
            duration_seconds: 3600,
            visit_id: 42,
            paid_in_full: true,
            online: true,
            deleted: false,
          },
        ],
      });
      expect(mockClient.getBookings).toHaveBeenCalledWith(456, { page: 1 });
    });

    it('reports an unknown status explicitly when V1 omits it', async () => {
      mockClient.getBookings.mockResolvedValue([
        {
          id: 1000,
          company_id: 456,
          staff_id: 123,
          services: [],
          datetime: '2026-09-10T10:00:00+02:00',
          date: '2026-09-10T10:00:00+02:00',
        },
      ] as any);

      const result = await handlers.getAppointments({ location_id: 456 });
      expect(result.content[0]?.text).toContain('Visit status: unknown');
      expect(result.content[0]?.text).not.toContain('undefined');
    });
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
        session_length: 3600,
        client: { name: 'Jane', phone: '9876543210' },
      });

      expect(result.content[0]?.text).toContain(
        'Successfully created appointment'
      );
      expect(result.content[0]?.text).toContain('999');
      expect(mockClient.createBooking).toHaveBeenCalledWith(456, {
        staff_id: 123,
        seance_length: 3600,
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
        session_length: 3600,
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
        appointment_id: 999,
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
        appointment_id: 999,
      });

      expect(result.content[0]?.text).toContain(
        'Successfully deleted appointment'
      );
      expect(mockClient.deleteBooking).toHaveBeenCalledWith(456, 999);
    });
  });
});
