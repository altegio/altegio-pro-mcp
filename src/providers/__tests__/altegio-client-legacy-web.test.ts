import { randomBytes } from 'node:crypto';
import { AltegioClient } from '../altegio-client.js';
import { runWithContext } from '../../request-context.js';

const credential = (): string => randomBytes(32).toString('hex');

describe('legacy ERP web transport', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('injects the current owner credential without a cookie session', async () => {
    const seen: Array<{ url: URL; init?: RequestInit }> = [];
    global.fetch = jest.fn(async (input, init) => {
      seen.push({ url: new URL(String(input)), init });
      return new Response('ok');
    }) as typeof fetch;
    const client = new AltegioClient({
      partnerToken: 'partner',
      legacyWebBase: 'https://erp.example.test',
    });
    const first = credential();
    const second = credential();

    await Promise.all([
      runWithContext({ identity: null, userToken: first }, () =>
        client.requestLegacyWebReport({
          locationId: 10,
          path: '/analytics_clients/clients_search/10/',
          query: { page: 1 },
        })
      ),
      runWithContext({ identity: null, userToken: second }, () =>
        client.requestLegacyWebReport({
          locationId: 20,
          path: '/analytics_clients/clients_search/20/',
          query: { page: 2 },
        })
      ),
    ]);

    expect(seen).toHaveLength(2);
    const byLocation = new Map(
      seen.map((entry) => [entry.url.pathname.split('/').at(-2), entry])
    );
    expect(byLocation.get('10')!.url.searchParams.get('user_hash')).toBe(first);
    expect(byLocation.get('20')!.url.searchParams.get('user_hash')).toBe(
      second
    );
    for (const entry of seen) {
      expect(entry.init).toMatchObject({
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
      });
      expect(entry.init?.headers).not.toHaveProperty('Cookie');
    }
  });

  it('enforces declared company scope before transport', async () => {
    global.fetch = jest.fn() as typeof fetch;
    const client = new AltegioClient({ partnerToken: 'partner' });
    await expect(
      runWithContext(
        {
          identity: null,
          userToken: credential(),
          companyIds: new Set([10]),
        },
        () =>
          client.requestLegacyWebReport({
            locationId: 20,
            path: '/analytics_clients/clients_search/20/',
          })
      )
    ).rejects.toThrow(/company 20 is not in scope/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'https://app.alteg.io'],
    ['https://yclients.com', 'https://yclients.com'],
  ])(
    'uses the configured legacy origin %s',
    async (legacyWebBase, expected) => {
      let seen: URL | undefined;
      global.fetch = jest.fn(async (input) => {
        seen = new URL(String(input));
        return new Response('ok');
      }) as typeof fetch;
      const client = new AltegioClient({
        partnerToken: 'partner',
        ...(legacyWebBase ? { legacyWebBase } : {}),
      });
      await runWithContext({ identity: null, userToken: credential() }, () =>
        client.requestLegacyWebReport({
          locationId: 10,
          path: '/analytics_clients/clients_search/10/',
        })
      );
      expect(seen?.origin).toBe(expected);
    }
  );

  it('redacts the credential from network and redirect errors', async () => {
    const current = credential();
    const client = new AltegioClient({ partnerToken: 'partner' });
    global.fetch = jest.fn(async (input) => {
      throw new Error(`transport failed for ${String(input)}`);
    }) as typeof fetch;

    const networkError = await runWithContext(
      { identity: null, userToken: current },
      () =>
        client
          .requestLegacyWebReport({
            locationId: 10,
            path: '/analytics_clients/clients_search/10/',
          })
          .catch((error: Error) => error.message)
    );
    expect(networkError).not.toContain(current);
    expect(networkError).not.toContain('user_hash');

    global.fetch = jest.fn(
      async () =>
        new Response('', { status: 302, headers: { location: '/signin/' } })
    ) as typeof fetch;
    const redirectError = await runWithContext(
      { identity: null, userToken: current },
      () =>
        client
          .requestLegacyWebReport({
            locationId: 10,
            path: '/analytics_clients/clients_search/10/',
          })
          .catch((error: Error) => error.message)
    );
    expect(redirectError).not.toContain(current);
    expect(redirectError).not.toContain('user_hash');
  });
});
