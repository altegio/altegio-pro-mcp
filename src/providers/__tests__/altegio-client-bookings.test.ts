import { AltegioClient } from '../altegio-client.js';
import type { AltegioConfig } from '../../types/altegio.types.js';

describe('AltegioClient - Bookings CRUD', () => {
  let client: AltegioClient;
  const mockConfig: AltegioConfig = {
    partnerToken: 'test-token',
    userToken: 'test-user-token',
  };

  beforeEach(() => {
    client = new AltegioClient(mockConfig, '/tmp/test-credentials');
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('createBooking', () => {
    it('should create booking successfully', async () => {
      const mockResponse = {
        success: true,
        data: { id: 999, staff_id: 123 },
        meta: {},
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => mockResponse,
      });

      const result = await client.createBooking(456, {
        staff_id: 123,
        services: [{ id: 789 }],
        datetime: '2025-11-01T10:00:00',
        client: { name: 'Jane', phone: '9876543210' },
      });

      expect(result.id).toBe(999);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/locations/456/appointments'),
        expect.objectContaining({ method: 'POST' })
      );
    });

    it('should forward seance_length and save_if_busy in the body', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({ success: true, data: { id: 1 }, meta: {} }),
      });

      await client.createBooking(456, {
        staff_id: 123,
        services: [{ id: 789 }],
        datetime: '2025-11-01T10:00:00',
        seance_length: 3600,
        save_if_busy: true,
        client: { name: 'Jane', phone: '9876543210' },
      });

      const body = JSON.parse(
        (global.fetch as jest.Mock).mock.calls[0][1].body as string
      );
      expect(body.seance_length).toBe(3600);
      expect(body.save_if_busy).toBe(true);
    });

    it('should throw error when not authenticated', async () => {
      const unauthClient = new AltegioClient(
        { partnerToken: 'test' },
        '/tmp/test'
      );

      await expect(
        unauthClient.createBooking(456, {
          staff_id: 123,
          services: [{ id: 789 }],
          datetime: '2025-11-01T10:00:00',
          client: { name: 'Jane', phone: '123' },
        })
      ).rejects.toThrow('Not authenticated');
    });
  });

  describe('updateBooking', () => {
    it('should update booking successfully', async () => {
      const mockResponse = {
        success: true,
        data: { id: 999, datetime: '2025-11-02T10:00:00' },
        meta: {},
      };

      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

      const result = await client.updateBooking(456, 999, {
        staff_id: 123,
        services: [{ id: 789, amount: 1 }],
        datetime: '2025-11-02T10:00:00',
        seance_length: 3600,
        client: { id: 321 },
      });

      expect(result.datetime).toContain('2025-11-02');
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/locations/456/appointments/999'),
        expect.objectContaining({ method: 'PUT' })
      );
    });
  });

  describe('deleteBooking', () => {
    it('should delete booking successfully', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 204,
      });

      await client.deleteBooking(456, 999);

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/../v2/locations/456/appointments/999'),
        expect.objectContaining({ method: 'DELETE' })
      );
    });
  });

  describe('appointment tags', () => {
    it('lists the live appointment tags of the location in #rrggbb', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              type: 'tag',
              id: '67345',
              attributes: { title: 'VIP', color: '#009800', is_deleted: false },
            },
            {
              type: 'tag',
              id: '67346',
              attributes: { title: 'Old', color: '#ff0000', is_deleted: true },
            },
            {
              type: 'tag',
              id: '67347',
              attributes: { title: 'Upper', color: 'F44336' },
            },
          ],
        }),
      });

      const tags = await client.getAppointmentTags(456);

      expect(tags).toEqual([
        { id: 67345, title: 'VIP', color: '#009800' },
        { id: 67347, title: 'Upper', color: '#f44336' },
      ]);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/v2\/locations\/456\/tags\?entity=record$/),
        expect.anything()
      );
    });

    it('creates an appointment tag as the appointment kind', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => ({
          data: {
            type: 'tag',
            id: '10105887',
            attributes: { title: 'Nový klient', color: '#22c55e' },
          },
          meta: [],
        }),
      });

      const tag = await client.createAppointmentTag(456, {
        title: 'Nový klient',
        color: '#22c55e',
      });

      expect(tag).toEqual({
        id: 10105887,
        title: 'Nový klient',
        color: '#22c55e',
      });
      const [url, init] = (global.fetch as jest.Mock).mock.calls[0];
      expect(url).toMatch(/\/v2\/locations\/456\/tags$/);
      expect(JSON.parse(init.body)).toEqual({
        title: 'Nový klient',
        color: '#22c55e',
        entity: 2,
      });
    });
  });
});
