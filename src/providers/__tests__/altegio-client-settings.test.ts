import { AltegioClient } from '../altegio-client.js';
import type { AltegioConfig } from '../../types/altegio.types.js';

describe('AltegioClient - Location settings & resources', () => {
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

  const mockJson = (data: unknown, status = 200) =>
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status,
      json: async () => ({ success: true, data, meta: {} }),
    });

  describe('appointment (timetable) settings', () => {
    it('gets appointment settings', async () => {
      mockJson({ record_type: 0, activity_record_clients_count_max: 1 });

      const result = await client.getAppointmentSettings(456);

      expect(result.record_type).toBe(0);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/company/456/settings/timetable'),
        expect.objectContaining({ headers: expect.any(Object) })
      );
    });

    it('updates appointment settings with PATCH', async () => {
      mockJson({ record_type: 2, activity_record_clients_count_max: 10 });

      const result = await client.updateAppointmentSettings(456, {
        record_type: 2,
        activity_record_clients_count_max: 10,
      });

      expect(result.record_type).toBe(2);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/company/456/settings/timetable'),
        expect.objectContaining({ method: 'PATCH' })
      );
    });

    it('throws when not authenticated', async () => {
      const unauth = new AltegioClient({ partnerToken: 'x' }, '/tmp/test');
      await expect(unauth.getAppointmentSettings(456)).rejects.toThrow(
        'Not authenticated'
      );
    });
  });

  describe('online booking settings', () => {
    it('gets online booking settings', async () => {
      mockJson({
        confirm_number: false,
        any_master: true,
        seance_delay_step: 90,
        activity_online_record_clients_count_max: 1,
      });

      const result = await client.getOnlineBookingSettings(456);

      expect(result.any_master).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/company/456/settings/online'),
        expect.any(Object)
      );
    });

    it('updates online booking settings with PATCH', async () => {
      mockJson({
        confirm_number: true,
        any_master: false,
        seance_delay_step: 30,
        activity_online_record_clients_count_max: 5,
      });

      const result = await client.updateOnlineBookingSettings(456, {
        confirm_number: true,
        any_master: false,
        seance_delay_step: 30,
        activity_online_record_clients_count_max: 5,
      });

      expect(result.confirm_number).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/company/456/settings/online'),
        expect.objectContaining({ method: 'PATCH' })
      );
    });
  });

  describe('booking forms', () => {
    it('lists booking forms', async () => {
      mockJson([{ id: 1, title: 'Main widget', is_default: true }]);

      const result = await client.getBookingForms(456);

      expect(result).toHaveLength(1);
      expect(result[0]!.title).toBe('Main widget');
    });

    it('creates a booking form with POST', async () => {
      mockJson({ id: 7, title: 'New widget' }, 201);

      const result = await client.createBookingForm(456, {
        title: 'New widget',
      });

      expect(result.id).toBe(7);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/company/456/booking_forms'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  describe('resources', () => {
    it('lists resources', async () => {
      mockJson([{ id: 70, title: 'Pedicure chair' }]);

      const result = await client.getResources(456);

      expect(result).toHaveLength(1);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/resources/456'),
        expect.any(Object)
      );
    });

    it('throws when not authenticated', async () => {
      const unauth = new AltegioClient({ partnerToken: 'x' }, '/tmp/test');
      await expect(unauth.getResources(456)).rejects.toThrow(
        'Not authenticated'
      );
    });
  });
});
