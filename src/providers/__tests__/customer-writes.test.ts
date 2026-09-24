import { AltegioClient } from '../altegio-client.js';
import { AltegioApiError } from '../../utils/errors.js';

const client = () =>
  new AltegioClient({
    apiBase: 'https://api.example.test/api/v1',
    partnerToken: 'partner-test',
    userToken: 'user-test',
  });

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('curated JSON writes', () => {
  it('uses the corrected client-comment path with the request credential and JSON body', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { id: 9 },
          meta: [],
        }),
        { status: 201 }
      )
    );
    global.fetch = fetchMock as typeof fetch;
    const result = await client().postJson('/company/7/clients/8/comments', {
      text: 'Intake form URL',
    });
    expect(result).toEqual({ id: 9 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/company/7/clients/8/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ text: 'Intake form URL' }),
        headers: expect.objectContaining({
          Authorization: 'Bearer partner-test, User user-test',
          'Content-Type': 'application/json',
        }),
      })
    );
  });

  it('surfaces a 403 without reporting a successful attendance update', async () => {
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          data: null,
          meta: { message: 'Forbidden' },
        }),
        { status: 403 }
      )
    ) as typeof fetch;
    await expect(
      client().postJson('/company/7/records/11/attendance', { attendance: 1 })
    ).rejects.toMatchObject<Partial<AltegioApiError>>({ statusCode: 403 });
  });
});
