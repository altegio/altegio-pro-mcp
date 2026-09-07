/**
 * Location timezone resolution.
 *
 * Period presets ("yesterday", "last_month") must land on the calendar days the
 * owner means, which are the days at the location — a location in Lisbon and
 * one in Almaty do not share a "yesterday". The location list the authenticated
 * user already has access to carries an IANA timezone name, so one cached call
 * covers every location the user can report on.
 *
 * Documented fallback: when the list cannot be read (no permission for that
 * location, a transport failure, or a location the user cannot see) presets are
 * resolved in **UTC** and the resolved period says `timezone: "UTC"`, so the
 * agent can tell the owner why a boundary looks off by a day. Explicit
 * `date_from`/`date_to` input never depends on this.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { isValidTimezone } from './periods.js';

/** How long a resolved timezone is trusted; locations move zone very rarely. */
export const TIMEZONE_CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  readonly timezone: string;
  readonly expires_at: number;
}

const cache = new Map<number, CacheEntry>();

/** Resolve the IANA timezone of one location, falling back to `UTC`. */
export async function resolveLocationTimezone(
  client: AltegioClient,
  locationId: number,
  now: number = Date.now()
): Promise<string> {
  const cached = cache.get(locationId);
  if (cached && cached.expires_at > now) return cached.timezone;

  try {
    const locations = await client.getCompanies({ my: 1 });
    for (const location of locations) {
      const name = location.timezone_name;
      const timezone =
        typeof name === 'string' && isValidTimezone(name) ? name : 'UTC';
      cache.set(location.id, {
        timezone,
        expires_at: now + TIMEZONE_CACHE_TTL_MS,
      });
    }
  } catch {
    // Analytics still works in UTC; a hard failure here would hide the real
    // question the owner asked.
  }

  return cache.get(locationId)?.timezone ?? 'UTC';
}

/** Drop the cache — used by tests. */
export function clearTimezoneCache(): void {
  cache.clear();
}
