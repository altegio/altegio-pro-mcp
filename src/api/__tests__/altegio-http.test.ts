/** The adapter port is implemented explicitly by the client. */
import {
  V2_PATH_PREFIX,
  httpFromClient,
  includeParams,
  queryString,
  requireUserToken,
  v2Path,
  type AltegioHttp,
} from '../altegio-http.js';
import { AltegioClient } from '../../providers/altegio-client.js';
import { AuthenticationError } from '../../utils/errors.js';

describe('httpFromClient', () => {
  it('uses the compiler-checked port owned by the client', () => {
    const client = new AltegioClient(
      { partnerToken: 'partner' },
      '/tmp/altegio-mcp-http-test'
    );
    expect(typeof client.apiRequest).toBe('function');
    expect(typeof httpFromClient(client).request).toBe('function');
  });

  it('forwards path and options and keeps the client as `this`', async () => {
    const seen: Array<[string, RequestInit | undefined]> = [];
    const fake = {
      apiRequest(path: string, init?: RequestInit) {
        // `this` must be the client, or per-identity token resolution breaks.
        expect(this).toBe(fake);
        seen.push([path, init]);
        return Promise.resolve(new Response('{}'));
      },
      isAuthenticated: () => true,
    };

    const http = httpFromClient(fake);
    await http.request('/locations/1/analytics/overall', { method: 'GET' });
    expect(seen).toEqual([
      ['/locations/1/analytics/overall', { method: 'GET' }],
    ]);
    expect(http.isAuthenticated()).toBe(true);
  });

  it('forwards an explicit location for a path that does not name one', async () => {
    const seen: unknown[][] = [];
    const fake = {
      apiRequest(...args: unknown[]) {
        seen.push(args);
        return Promise.resolve(new Response('{}'));
      },
      isAuthenticated: () => true,
    };

    const http = httpFromClient(fake);
    await http.request('/loyalty/memberships', { method: 'GET' }, 4564);
    expect(seen).toEqual([['/loyalty/memberships', { method: 'GET' }, 4564]]);
  });
});

describe('requireUserToken', () => {
  const http = (authenticated: boolean): AltegioHttp => ({
    isAuthenticated: () => authenticated,
    request: async () => new Response('{}'),
  });

  it('passes when a user token is present', () => {
    expect(() => requireUserToken(http(true), 'read metrics')).not.toThrow();
  });

  it('names the login tool and the action when it is not', () => {
    expect(() => requireUserToken(http(false), 'read key metrics')).toThrow(
      AuthenticationError
    );
    expect(() => requireUserToken(http(false), 'read key metrics')).toThrow(
      /auth_login before trying to read key metrics/
    );
  });
});

describe('queryString', () => {
  it('skips empty values and encodes the rest', () => {
    expect(
      queryString({
        date_from: '2026-08-01',
        team_member_id: 9001,
        position_id: undefined,
        user_id: null,
        blank: '',
        flag: false,
      })
    ).toBe('?date_from=2026-08-01&team_member_id=9001&flag=false');
  });

  it('returns an empty string when nothing is left', () => {
    expect(queryString({ a: undefined })).toBe('');
  });
});

describe('includeParams', () => {
  it('renders repeated include[] parameters', () => {
    expect(includeParams(['a_daily', 'currency'])).toBe(
      'include[]=a_daily&include[]=currency'
    );
  });
});

describe('v2Path', () => {
  it('normalizes to /api/v2 through a transport bound to /api/v1', () => {
    const url = new URL(
      `https://api.alteg.io/api/v1${v2Path('/locations/4564/clients/7/attendances_statistic')}`
    );
    expect(url.pathname).toBe(
      '/api/v2/locations/4564/clients/7/attendances_statistic'
    );
  });

  it('accepts a suffix with or without a leading slash', () => {
    expect(v2Path('locations/1')).toBe(`${V2_PATH_PREFIX}/locations/1`);
    expect(v2Path('/locations/1')).toBe(`${V2_PATH_PREFIX}/locations/1`);
  });
});
