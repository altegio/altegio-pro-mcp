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
    it('returns client phones when the call asks for them', async () => {
      mockClient.getBookings.mockResolvedValue([
        {
          id: 999,
          company_id: 456,
          staff_id: 123,
          staff: { id: 123, name: 'Alex' },
          client: { id: 321, name: 'Jane', phone: '555' },
          services: [{ id: 789, title: 'Haircut', cost: 100, amount: 2 }],
          datetime: '2026-09-10T10:00:00+02:00',
          attendance: 3,
          deleted: false,
        },
      ] as any);

      const result = await handlers.getAppointments({
        location_id: 456,
        include_contacts: true,
      });

      const text = result.content[0]?.text ?? '';
      // Present, but still inside the fence: a phone is free input too.
      expect(text).toContain('appointment 999 client phone: 555');
      expect(text.split('\n\n')[0]).not.toContain('555');
      expect(result.structuredContent).toMatchObject({
        contacts_included: true,
        items: [{ client_phone: '555' }],
      });
    });

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

      const text = result.content[0]?.text ?? '';
      expect(text).toContain('confirmed');
      expect(text).toContain('total 200');
      expect(text).not.toContain('undefined');
      // Names and service titles are free input: fenced, not in our own row.
      const [ours, theirs] = text.split('\n\n');
      expect(ours).toContain('Appointment 999');
      expect(ours).not.toContain('Jane');
      expect(ours).not.toContain('Haircut');
      expect(theirs).toContain('appointment 999 client: Jane');
      expect(theirs).toContain('appointment 999 services: Haircut');
      // A phone is a contact: withheld unless the call asked for it.
      expect(text).not.toContain('555');
      expect(result.structuredContent).toMatchObject({
        contacts_included: false,
      });
      expect(
        (result.structuredContent as { items: object[] }).items[0]
      ).not.toHaveProperty('client_phone');
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
      expect(result.content[0]?.text).toContain('unknown');
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
