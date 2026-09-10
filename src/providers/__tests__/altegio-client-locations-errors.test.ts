import { AltegioClient } from '../altegio-client.js';
import { AltegioApiError } from '../../utils/errors.js';
import type { AltegioConfig } from '../../types/altegio.types.js';
import { runWithContext } from '../../request-context.js';

describe('AltegioClient - updateLocation', () => {
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

  it('should PUT /company/{id} with the update body', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { id: 4564, title: 'Renamed Salon' },
        meta: {},
      }),
    });

    const result = await client.updateLocation(4564, {
      title: 'Renamed Salon',
      city: 'Berlin',
    });

    expect(result.title).toBe('Renamed Salon');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/company/4564'),
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ title: 'Renamed Salon', city: 'Berlin' }),
      })
    );
  });

  it('should throw when not authenticated', async () => {
    const unauth = new AltegioClient({ partnerToken: 'test' }, '/tmp/test');
    await expect(unauth.updateLocation(4564, { title: 'x' })).rejects.toThrow(
      'Not authenticated'
    );
  });
});

describe('AltegioClient - company-scoped location listing', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves declared companies directly when my=1', async () => {
    const client = new AltegioClient(
      { partnerToken: 'partner', userToken: 'user' },
      '/tmp/test-credentials'
    );
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { id: 4564, title: 'Praha' },
          meta: {},
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { id: 720441, title: 'Kraków' },
          meta: {},
        }),
      });

    const locations = await runWithContext(
      { identity: null, companyIds: new Set([4564, 720441]) },
      () => client.getCompanies({ my: 1, page: 1, count: 20 })
    );

    expect(locations.map((location) => location.id)).toEqual([4564, 720441]);
    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('/company/4564?my=1'),
      expect.any(Object)
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/company/720441?my=1'),
      expect.any(Object)
    );
    expect(
      (global.fetch as jest.Mock).mock.calls.some(([url]) =>
        String(url).includes('/companies')
      )
    ).toBe(false);
  });

  it('applies 1-based pagination to the declared scope', async () => {
    const client = new AltegioClient(
      { partnerToken: 'partner', userToken: 'user' },
      '/tmp/test-credentials'
    );
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { id: 720441, title: 'Kraków' },
        meta: {},
      }),
    });

    const locations = await runWithContext(
      { identity: null, companyIds: new Set([4564, 720441]) },
      () => client.getCompanies({ my: 1, page: 2, count: 1 })
    );

    expect(locations.map((location) => location.id)).toEqual([720441]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('AltegioClient - API error surfacing', () => {
  let client: AltegioClient;

  beforeEach(() => {
    client = new AltegioClient(
      { partnerToken: 'test-token', userToken: 'test-user-token' },
      '/tmp/test-credentials'
    );
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('flattens meta.errors into the thrown message (422)', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      json: async () => ({
        success: false,
        data: null,
        meta: {
          message: 'Validation failed',
          errors: { seance_length: ['The seance length field is required.'] },
        },
      }),
    });

    await expect(client.getBookings(4564)).rejects.toThrow(
      /seance_length: The seance length field is required/
    );
  });

  it('passes the API message through on 403 instead of a generic string', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({
        success: false,
        data: null,
        meta: { message: 'create_service is denied for this role' },
      }),
    });

    const error = await client.getBookings(4564).catch((e) => e);
    expect(error).toBeInstanceOf(AltegioApiError);
    expect((error as AltegioApiError).message).toContain(
      'create_service is denied for this role'
    );
    expect((error as AltegioApiError).message).toContain('403');
  });
});
