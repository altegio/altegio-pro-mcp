/**
 * Timezone resolution: the location list answers for the locations it names,
 * and a location it leaves out is read on its own.
 */
import type { AltegioClient } from '../../../providers/altegio-client.js';
import {
  clearTimezoneCache,
  knownLocationTimezone,
  resolveLocationTimezone,
} from '../location-timezone.js';

interface FakeLocation {
  id: number;
  timezone_name?: string;
}

function fakeClient(options: {
  listed: FakeLocation[] | Error;
  single?: FakeLocation | Error;
}) {
  const getCompanies = jest.fn(async () => {
    if (options.listed instanceof Error) throw options.listed;
    return options.listed;
  });
  const getLocation = jest.fn(async () => {
    if (options.single === undefined) throw new Error('404 Not Found');
    if (options.single instanceof Error) throw options.single;
    return options.single;
  });
  const client = { getCompanies, getLocation } as unknown as AltegioClient;
  return { client, getCompanies, getLocation };
}

beforeEach(() => clearTimezoneCache());

describe('knownLocationTimezone', () => {
  it('answers from the location list without reading the location', async () => {
    const { client, getLocation } = fakeClient({
      listed: [{ id: 4564, timezone_name: 'Europe/Prague' }],
    });

    await expect(knownLocationTimezone(client, 4564)).resolves.toBe(
      'Europe/Prague'
    );
    expect(getLocation).not.toHaveBeenCalled();
  });

  it('reads a location the list leaves out, once per cache period', async () => {
    const { client, getCompanies, getLocation } = fakeClient({
      listed: [{ id: 720441, timezone_name: 'Europe/Warsaw' }],
      single: { id: 4564, timezone_name: 'Europe/Prague' },
    });
    const now = Date.parse('2026-10-21T10:00:00Z');

    await expect(knownLocationTimezone(client, 4564, now)).resolves.toBe(
      'Europe/Prague'
    );
    await expect(
      knownLocationTimezone(client, 4564, now + 60_000)
    ).resolves.toBe('Europe/Prague');
    expect(getLocation).toHaveBeenCalledTimes(1);
    expect(getLocation).toHaveBeenCalledWith(4564, { my: 1 });
    expect(getCompanies).toHaveBeenCalledTimes(1);
  });

  it('reads the location when the list cannot be read', async () => {
    const { client } = fakeClient({
      listed: new Error('403 Forbidden'),
      single: { id: 4564, timezone_name: 'Europe/Prague' },
    });

    await expect(knownLocationTimezone(client, 4564)).resolves.toBe(
      'Europe/Prague'
    );
  });

  it('does not read a listed location whose zone is not an IANA name', async () => {
    const { client, getLocation } = fakeClient({
      listed: [{ id: 4564, timezone_name: 'Mars/Olympus_Mons' }],
    });

    await expect(knownLocationTimezone(client, 4564)).resolves.toBeNull();
    expect(getLocation).not.toHaveBeenCalled();
  });

  it('says nothing when neither read answers, and presets fall back to UTC', async () => {
    const { client } = fakeClient({ listed: [] });

    await expect(knownLocationTimezone(client, 4564)).resolves.toBeNull();
    await expect(resolveLocationTimezone(client, 4564)).resolves.toBe('UTC');
  });
});
