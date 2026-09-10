import { AltegioClient } from '../altegio-client.js';
import { removeLocationUserTool } from '../../tools/definitions/users.tools.js';

describe('documented exact-ID destructive operations', () => {
  let client: AltegioClient;

  beforeEach(() => {
    client = new AltegioClient(
      { partnerToken: 'partner', userToken: 'user' },
      '/tmp/test-credentials'
    );
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 });
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    [
      'service category',
      () => client.deleteServiceCategory(456, 12),
      '/service_category/456/12',
    ],
    ['client', () => client.deleteClient(456, 34), '/client/456/34'],
    [
      'booking form',
      () => client.deleteBookingForm(456, 56),
      '/company/456/booking_forms/56',
    ],
    [
      'location user',
      () => client.removeLocationUser(456, 78),
      '/company/456/users/78',
    ],
  ])(
    'deletes one %s through the documented path',
    async (_name, call, path) => {
      await call();
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining(path),
        expect.objectContaining({ method: 'DELETE' })
      );
    }
  );

  it('requires the user ID confirmation before removing access', async () => {
    const result = await removeLocationUserTool.createHandler(client)({
      location_id: 456,
      user_id: 78,
      confirm_user_id: 79,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('must exactly match user_id');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
