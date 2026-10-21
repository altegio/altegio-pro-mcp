/**
 * Location timezone resolution.
 *
 * Period presets ("yesterday", "last_month") must land on the calendar days the
 * owner means, which are the days at the location — a location in Lisbon and
 * one in Almaty do not share a "yesterday". The location list the authenticated
 * user already has access to carries an IANA timezone name, so one cached call
 * covers the locations it names. The list is paged and can leave out a location
 * the user still reaches, so a location it does not name is read on its own.
 *
 * Documented fallback: when neither the list nor the location itself can be
 * read (no permission for that location, a transport failure, or a location
 * the user cannot see) presets are resolved in **UTC** and the resolved period
 * says `timezone: "UTC"`, so the agent can tell the owner why a boundary looks
 * off by a day. Explicit `date_from`/`date_to` input never depends on this.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { assertCompanyAllowed } from '../../request-context.js';
import { isValidTimezone } from './periods.js';

/** How long a resolved timezone is trusted; locations move zone very rarely. */
export const TIMEZONE_CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  readonly timezone: string | null;
  readonly expires_at: number;
}

const cache = new Map<number, CacheEntry>();

/** Resolve the IANA timezone of one location, falling back to `UTC`. */
export async function resolveLocationTimezone(
  client: AltegioClient,
  locationId: number,
  now: number = Date.now()
): Promise<string> {
  return (await knownLocationTimezone(client, locationId, now)) ?? 'UTC';
}

/**
 * The IANA timezone of one location, or `null` when neither the location list
 * nor the location itself can say. For a caller that must not guess: a UTC
 * stand-in shifts "now" by hours.
 */
export async function knownLocationTimezone(
  client: AltegioClient,
  locationId: number,
  now: number = Date.now()
): Promise<string | null> {
  // Every location-scoped analytics use-case resolves a timezone first, so this
  // is the earliest, clearest place to reject a location outside the declared
  // company scope — before any network round-trip. `apiRequest` enforces the
  // same scope as a backstop for any path that does not pass through here.
  assertCompanyAllowed(locationId);

  const cached = cache.get(locationId);
  if (cached && cached.expires_at > now) return cached.timezone;

  try {
    const locations = await client.getCompanies({ my: 1 });
    for (const location of locations) {
      remember(location.id, location.timezone_name, now);
    }
  } catch {
    // Analytics still works in UTC; a hard failure here would hide the real
    // question the owner asked.
  }

  const listed = cache.get(locationId);
  if (listed && listed.expires_at > now) return listed.timezone;

  try {
    const location = await client.getLocation(locationId, { my: 1 });
    remember(locationId, location.timezone_name, now);
  } catch {
    // The same UTC fallback as for the list.
  }

  return cache.get(locationId)?.timezone ?? null;
}

function remember(locationId: number, name: unknown, now: number): void {
  cache.set(locationId, {
    timezone: typeof name === 'string' && isValidTimezone(name) ? name : null,
    expires_at: now + TIMEZONE_CACHE_TTL_MS,
  });
}

/** Drop the cache — used by tests. */
export function clearTimezoneCache(): void {
  cache.clear();
}
