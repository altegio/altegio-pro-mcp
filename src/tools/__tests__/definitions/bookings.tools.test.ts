import {
  getBookingsTool,
  createBookingTool,
  updateBookingTool,
  deleteBookingTool,
} from '../../definitions/bookings.tools.js';

describe('Bookings Tools', () => {
  const mockClient = {
    isAuthenticated: jest.fn(),
    getBookings: jest.fn(),
    createBooking: jest.fn(),
    updateBooking: jest.fn(),
    deleteBooking: jest.fn(),
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClient.isAuthenticated.mockReturnValue(true);
  });

  describe('getBookingsTool', () => {
    it('requires auth', () => {
      expect(getBookingsTool.meta.requiresAuth).toBe(true);
    });

    it('fetches and formats bookings list', async () => {
      mockClient.getBookings.mockResolvedValue([
        {
          id: 1,
          datetime: '2025-01-15 10:00:00',
          client: { name: 'Jane', phone: '+123' },
          staff: { name: 'John' },
          services: [{ title: 'Haircut' }],
          status: 'confirmed',
        },
      ]);

      const handler = getBookingsTool.createHandler(mockClient);
      const result = await handler({ company_id: 123 });

      expect(result.content[0]?.text).toContain('Jane');
      expect(result.content[0]?.text).toContain('Haircut');
      expect(mockClient.getBookings).toHaveBeenCalledWith(123, {});
    });
  });

  describe('createBookingTool', () => {
    it('requires auth', () => {
      expect(createBookingTool.meta.requiresAuth).toBe(true);
    });

    it('creates booking', async () => {
      mockClient.createBooking.mockResolvedValue({
        id: 99,
        staff_id: 1,
        datetime: '2025-01-15 10:00:00',
      });

      const handler = createBookingTool.createHandler(mockClient);
      const result = await handler({
        company_id: 123,
        staff_id: 1,
        services: [{ id: 10, amount: 1 }],
        datetime: '2025-01-15 10:00:00',
        client: { name: 'Test Client', phone: '+123456789' },
      });

      expect(result.content[0]?.text).toContain('Successfully created');
      expect(result.content[0]?.text).toContain('99');
    });
  });

  describe('updateBookingTool', () => {
    it('requires auth', () => {
      expect(updateBookingTool.meta.requiresAuth).toBe(true);
    });

    it('updates booking', async () => {
      mockClient.updateBooking.mockResolvedValue({
        id: 1,
        datetime: '2025-01-15 11:00:00',
      });

      const handler = updateBookingTool.createHandler(mockClient);
      const result = await handler({
        company_id: 123,
        record_id: 1,
        datetime: '2025-01-15 11:00:00',
      });

      expect(result.content[0]?.text).toContain('Successfully updated');
    });
  });

  describe('deleteBookingTool', () => {
    it('requires auth', () => {
      expect(deleteBookingTool.meta.requiresAuth).toBe(true);
    });

    it('deletes booking', async () => {
      mockClient.deleteBooking.mockResolvedValue(undefined);

      const handler = deleteBookingTool.createHandler(mockClient);
      const result = await handler({ company_id: 123, record_id: 1 });

      expect(result.content[0]?.text).toContain('Successfully deleted');
      expect(mockClient.deleteBooking).toHaveBeenCalledWith(123, 1);
    });
  });
});
