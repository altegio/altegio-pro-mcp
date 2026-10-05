import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AltegioClient } from '../altegio-client.js';
import { runWithContext } from '../../request-context.js';
import { callOperation } from '../../tools/executor/call.js';
import { describeOperation } from '../../tools/executor/describe.js';

describe('mandatory managed-location reads', () => {
  let client: AltegioClient;
  let testDir: string;
  const originalFetch = global.fetch;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'managed-location-reads-'));
    client = new AltegioClient(
      { partnerToken: 'test-partner', userToken: 'test-user' },
      testDir
    );
    global.fetch = jest.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: /\/locations\/\d+/.test(url) ? { id: 4564 } : [],
      }),
    }));
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    await rm(testDir, { recursive: true, force: true });
  });

  function lastUrl(): URL {
    const calls = (global.fetch as jest.Mock).mock.calls;
    return new URL(calls.at(-1)![0] as string);
  }

  it.each([undefined, { my: 0 }, { my: 1 }])(
    'forces my=1 when listing with %j',
    async (params) => {
      await client.getCompanies(params);
      expect(lastUrl().searchParams.getAll('my')).toEqual(['1']);
    }
  );

  it.each([undefined, { my: 0 }, { my: 1 }])(
    'forces my=1 when reading one location with %j',
    async (params) => {
      await client.getLocation(4564, params);
      expect(lastUrl().searchParams.getAll('my')).toEqual(['1']);
    }
  );

  it.each(['/locations', '/locations/4564', '/companies', '/company/4564'])(
    'enforces the policy on generic reads of %s',
    async (path) => {
      await client.request('GET', path, { my: 0, page: 2, count: 10 });
      expect(lastUrl().searchParams.getAll('my')).toEqual(['1']);
      expect(lastUrl().searchParams.get('page')).toBe('2');
      expect(lastUrl().searchParams.get('count')).toBe('10');
    }
  );

  it('replaces every duplicate my parameter at the transport boundary', async () => {
    await client.request('GET', '/locations?my=0&my=0');
    expect(lastUrl().searchParams.getAll('my')).toEqual(['1']);
  });

  it.each([undefined, { my: 0, page: 1, count: 1 }])(
    'resolves only declared IDs even when the caller omits or disables my (%j)',
    async (params) => {
      await runWithContext(
        { identity: null, userToken: 'test-user', companyIds: new Set([4564]) },
        () => client.getCompanies(params)
      );
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(lastUrl().pathname).toBe('/api/v1/locations/4564');
      expect(lastUrl().searchParams.get('my')).toBe('1');
    }
  );

  it.each(['get_location_list', 'get_location'])(
    'prevents executor operation %s from disabling the filter',
    async (operationId) => {
      const description = describeOperation(operationId).structuredContent as {
        parameters: { name: string; enum?: number[]; default?: number }[];
      };
      expect(description.parameters.find((p) => p.name === 'my')).toMatchObject(
        {
          enum: [1],
          default: 1,
        }
      );
      const result = await callOperation(client, operationId, {
        ...(operationId === 'get_location' ? { location_id: 4564 } : {}),
        my: 0,
      });
      expect(lastUrl().searchParams.getAll('my')).toEqual(['1']);
      expect(result.structuredContent).toMatchObject({ query: { my: 1 } });
    }
  );

  it('keeps writes and nested or V2 resource reads unchanged', async () => {
    await client.updateLocation(4564, { title: 'Updated' });
    expect(lastUrl().searchParams.has('my')).toBe(false);
    await client.request('GET', '/locations/4564/appointments');
    expect(lastUrl().searchParams.has('my')).toBe(false);
    await client.request('GET', '/../v2/locations/4564/events');
    expect(lastUrl().searchParams.has('my')).toBe(false);
  });

  it('still refuses unauthenticated location reads before transport', async () => {
    client = new AltegioClient({ partnerToken: 'test-partner' }, testDir);
    await expect(client.getCompanies()).rejects.toThrow('Not authenticated');
    await expect(client.getLocation(4564)).rejects.toThrow('Not authenticated');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('still refuses location IDs outside the declared scope before transport', async () => {
    await expect(
      runWithContext(
        { identity: null, userToken: 'test-user', companyIds: new Set([4564]) },
        () => client.getLocation(999)
      )
    ).rejects.toThrow(/company 999 is not in scope/);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
