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
      getBooking: jest.fn(),
      getAppointmentTags: jest.fn(),
      createAppointmentTag: jest.fn(),
      createBooking: jest.fn(),
      updateBooking: jest.fn(),
      deleteBooking: jest.fn(),
    } as unknown as jest.Mocked<AltegioClient>;
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
      ] as Awaited<ReturnType<AltegioClient['getBookings']>>);

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
      ] as Awaited<ReturnType<AltegioClient['getBookings']>>);

      const result = await handlers.getAppointments({
        location_id: 456,
        page: 1,
      });

      const text = result.content[0]?.text ?? '';
      expect(text).toContain('· waiting ·');
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
            // attendance=0 is waiting; confirmed=1 is the admin-default
            // verification flag, not the status.
            status: 'waiting',
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
      expect(mockClient.getBookings).toHaveBeenCalledWith(456, {
        page: 1,
        count: 25,
      });
    });

    it.each(['waiting', 'confirmed', 'arrived', 'no_show'] as const)(
      'reads back %s after appointments_create wrote it',
      async (status) => {
        const stored: Array<Record<string, unknown>> = [];
        mockClient.createBooking.mockImplementation(
          async (locationId, data) => {
            // V1 marks admin-created appointments confirmed=1 whatever the status.
            const row = {
              ...data,
              id: 1001,
              company_id: locationId,
              confirmed: 1,
            };
            stored.push(row);
            return row as unknown as Awaited<
              ReturnType<AltegioClient['createBooking']>
            >;
          }
        );
        mockClient.getBookings.mockImplementation(
          async () =>
            stored as unknown as Awaited<
              ReturnType<AltegioClient['getBookings']>
            >
        );

        await handlers.createAppointment({
          location_id: 456,
          team_member_id: 123,
          services: [{ id: 789 }],
          datetime: '2026-10-20T10:00:00',
          session_length: 3600,
          client: { name: 'Jane', phone: '9876543210' },
          status,
        });
        const result = await handlers.getAppointments({ location_id: 456 });

        expect(result.structuredContent).toMatchObject({
          items: [{ id: 1001, status }],
        });
      }
    );

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
      ] as Awaited<ReturnType<AltegioClient['getBookings']>>);

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
      mockClient.createBooking.mockResolvedValue(
        mockBooking as Awaited<ReturnType<AltegioClient['createBooking']>>
      );

      const result = await handlers.createAppointment({
        location_id: 456,
        team_member_id: 123,
        services: [{ id: 789 }],
        datetime: '2025-11-01T10:00:00',
        session_length: 3600,
        client: { name: 'Jane', phone: '9876543210' },
      });

      expect(result.content[0]?.text).toContain('Created appointment');
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
        new AuthenticationError('Not authenticated. Call auth_login first.')
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
    // As GET /locations/{id}/appointments/{id} returns it: a paid visit with
    // a manual price, tags and a color.
    const stored = {
      id: 999,
      company_id: 456,
      staff_id: 123,
      client: { id: 321, name: 'Jane', phone: '+420601500001' },
      services: [
        {
          id: 789,
          title: 'Haircut',
          amount: 1,
          first_cost: 500,
          discount: 10,
          cost: 450,
        },
      ],
      datetime: '2026-09-15T17:30:00+02:00',
      date: '2026-09-15 17:30:00',
      seance_length: 4800,
      attendance: 1,
      comment: 'Demo 2026-09',
      custom_color: 'f44336',
      record_labels: [{ id: 67345, title: 'VIP', color: '009800' }],
    } as unknown as Awaited<ReturnType<AltegioClient['getBooking']>>;

    beforeEach(() => {
      mockClient.getBooking.mockResolvedValue(stored);
      mockClient.updateBooking.mockImplementation(
        async (_location, id, data) =>
          ({ ...stored, ...data, id }) as unknown as Awaited<
            ReturnType<AltegioClient['updateBooking']>
          >
      );
    });

    it('moves an appointment and resends what the full update requires', async () => {
      const result = await handlers.updateAppointment({
        location_id: 456,
        appointment_id: 999,
        datetime: '2026-09-16T10:00:00',
      });

      expect(result.content[0]?.text).toContain('Updated appointment 999');
      expect(mockClient.getBooking).toHaveBeenCalledWith(456, 999);
      expect(mockClient.updateBooking).toHaveBeenCalledWith(456, 999, {
        staff_id: 123,
        services: [
          { id: 789, amount: 1, first_cost: 500, discount: 10, cost: 450 },
        ],
        datetime: '2026-09-16T10:00:00',
        seance_length: 4800,
        client: { id: 321 },
        comment: 'Demo 2026-09',
        attendance: 1,
      });
    });

    it('keeps tags, color and the slot when only the comment changes', async () => {
      await handlers.updateAppointment({
        location_id: 456,
        appointment_id: 999,
        comment: 'Rebooked by phone',
      });

      const body = mockClient.updateBooking.mock.calls[0]?.[2];
      // Omitted tags and color are left out: the API keeps them.
      expect(body).not.toHaveProperty('record_labels');
      expect(body).not.toHaveProperty('custom_color');
      expect(body).toMatchObject({
        comment: 'Rebooked by phone',
        datetime: '2026-09-15T17:30:00+02:00',
        save_if_busy: true,
      });
    });

    it('writes tags and a palette color in the wire format', async () => {
      await handlers.updateAppointment({
        location_id: 456,
        appointment_id: 999,
        tag_ids: [10105887],
        color: '#2196f3',
      });

      expect(mockClient.updateBooking.mock.calls[0]?.[2]).toMatchObject({
        record_labels: [10105887],
        custom_color: '2196f3',
        save_if_busy: true,
      });
    });

    it('removes the color with null and the tags with an empty list', async () => {
      await handlers.updateAppointment({
        location_id: 456,
        appointment_id: 999,
        tag_ids: [],
        color: null,
      });

      expect(mockClient.updateBooking.mock.calls[0]?.[2]).toMatchObject({
        record_labels: [],
        custom_color: '',
      });
    });

    it('refuses a color the digital schedule would silently drop', async () => {
      const result = await handlers.updateAppointment({
        location_id: 456,
        appointment_id: 999,
        color: '#8b5cf6',
      });

      expect(result.isError).toBe(true);
      expect(mockClient.updateBooking).not.toHaveBeenCalled();
    });

    it('merges partial client details with the stored client', async () => {
      await handlers.updateAppointment({
        location_id: 456,
        appointment_id: 999,
        client: { name: 'Jane Doe' },
        team_member_id: 124,
      });

      const body = mockClient.updateBooking.mock.calls[0]?.[2];
      expect(body).toMatchObject({
        staff_id: 124,
        client: { name: 'Jane Doe', phone: '+420601500001' },
      });
      // Moving to another team member is checked for conflicts.
      expect(body).not.toHaveProperty('save_if_busy');
    });
  });

  describe('appointment tags', () => {
    it('reads tags and color back on the appointment list', async () => {
      mockClient.getBookings.mockResolvedValue([
        {
          id: 999,
          company_id: 456,
          staff_id: 123,
          services: [],
          datetime: '2026-09-10T10:00:00+02:00',
          date: '2026-09-10 10:00:00',
          attendance: 0,
          custom_color: 'F44336',
          record_labels: [{ id: 7, title: 'VIP', color: '009800' }],
        },
        {
          id: 1000,
          company_id: 456,
          staff_id: 123,
          services: [],
          datetime: '2026-09-10T11:00:00+02:00',
          date: '2026-09-10 11:00:00',
          attendance: 0,
          custom_color: '',
          record_labels: [],
        },
      ] as Awaited<ReturnType<AltegioClient['getBookings']>>);

      const result = await handlers.getAppointments({ location_id: 456 });
      const text = result.content[0]?.text ?? '';
      const [ours, theirs] = text.split('\n\n');
      expect(ours).toContain('tag ids 7 · color #f44336');
      expect(ours).not.toContain('VIP');
      expect(theirs).toContain('appointment 999 tags: VIP');
      expect(result.structuredContent).toMatchObject({
        items: [
          {
            id: 999,
            tags: [{ id: 7, title: 'VIP', color: '#009800' }],
            color: '#f44336',
          },
          { id: 1000, tags: [], color: null },
        ],
      });
    });

    it('creates an appointment with tags and a color', async () => {
      mockClient.createBooking.mockResolvedValue({
        id: 1001,
        staff_id: 123,
        datetime: '2026-10-20T10:00:00',
      } as Awaited<ReturnType<AltegioClient['createBooking']>>);

      await handlers.createAppointment({
        location_id: 456,
        team_member_id: 123,
        services: [{ id: 789 }],
        datetime: '2026-10-20T10:00:00',
        session_length: 3600,
        client: { name: 'Jane', phone: '9876543210' },
        tag_ids: [7, 8],
        color: '#9c27b0',
      });

      expect(mockClient.createBooking).toHaveBeenCalledWith(
        456,
        expect.objectContaining({
          record_labels: [7, 8],
          custom_color: '9c27b0',
        })
      );
    });

    it('lists appointment tags filtered by title, paged', async () => {
      mockClient.getAppointmentTags.mockResolvedValue([
        { id: 3, title: 'amoCRM', color: '#2c9bc9' },
        { id: 1, title: 'Nový klient', color: '#22c55e' },
        { id: 2, title: 'VIP klient', color: '#a855f7' },
      ]);

      const result = await handlers.listAppointmentTags({
        location_id: 456,
        query: 'KLIENT',
        page_size: 1,
      });

      expect(result.structuredContent).toEqual({
        items: [{ id: 1, title: 'Nový klient', color: '#22c55e' }],
        pagination: {
          page: 1,
          page_size: 1,
          returned: 1,
          total: 2,
          has_more: true,
          next_page: 2,
        },
      });
    });

    it('creates an appointment tag', async () => {
      mockClient.createAppointmentTag.mockResolvedValue({
        id: 10105887,
        title: 'Nový klient',
        color: '#22c55e',
      });

      const result = await handlers.createAppointmentTag({
        location_id: 456,
        title: 'Nový klient',
        color: '#22C55E',
      });

      expect(mockClient.createAppointmentTag).toHaveBeenCalledWith(456, {
        title: 'Nový klient',
        color: '#22c55e',
      });
      expect(result.structuredContent).toEqual({
        id: 10105887,
        title: 'Nový klient',
        color: '#22c55e',
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
