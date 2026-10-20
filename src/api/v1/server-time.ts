/**
 * The V1 backend's own clock, and conversions between it and a location's.
 *
 * Financial transactions are stored in the backend server's wall time, not the
 * location's. The backend runs in the `Asia/Dubai` time zone, which has no
 * daylight saving, so the offset is +04:00 all year; the transaction list renders it explicitly
 * (`2026-10-15T13:00:00+0400` for an 11:00 Prague payment), while the single
 * transaction read and the visit read give the same wall time with no offset.
 *
 * The write side is not symmetric (verified live on 2026-10-19 and in the
 * backend source): creating a transaction stores the `date` it is sent
 * as server wall time, while updating one treats `date` as location wall time
 * and converts it. The adapter therefore sends a create in server time and an
 * update in location time, and every read comes back to the model in the
 * location's offset.
 */

/** The backend's process time zone. */
export const V1_SERVER_TIMEZONE = 'Asia/Dubai';

const WALL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** Minutes the zone is ahead of UTC at an instant. */
export function zoneOffsetMinutes(instantMs: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second')
  );
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60000);
}

/** `YYYY-MM-DD HH:MM:SS` wall time of an instant in a zone. */
export function wallTime(instantMs: number, zone: string): string {
  const shifted = new Date(
    instantMs + zoneOffsetMinutes(instantMs, zone) * 60000
  );
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  );
}

/**
 * The instant a wall time names in a zone. A time skipped by a DST jump lands
 * after the jump; an ambiguous one takes the first occurrence.
 */
export function instantOfWallTime(wall: string, zone: string): number | null {
  const m = WALL.exec(wall.trim());
  if (!m) return null;
  const asUtc = Date.UTC(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6] ?? '0')
  );
  if (Number.isNaN(asUtc)) return null;
  let guess = asUtc - zoneOffsetMinutes(asUtc, zone) * 60000;
  guess = asUtc - zoneOffsetMinutes(guess, zone) * 60000;
  return guess;
}

/** RFC 3339 with the zone's offset, seconds precision. */
export function toZonedRfc3339(instantMs: number, zone: string): string {
  const offset = zoneOffsetMinutes(instantMs, zone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${wallTime(instantMs, zone).replace(' ', 'T')}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Parse a datetime that carries its own offset (`+0400`, `+04:00`, `Z`). */
export function instantWithOffset(value: string): number | null {
  const m = WITH_OFFSET.exec(value.trim());
  if (!m) return null;
  const tz = m[7]!;
  const iso =
    `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}` +
    (tz === 'Z' ? 'Z' : `${tz.slice(0, 3)}:${tz.slice(-2)}`);
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Read a V1 datetime: with an offset as given, without one as the server's
 * wall time.
 */
export function parseV1Instant(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  return (
    instantWithOffset(value) ?? instantOfWallTime(value, V1_SERVER_TIMEZONE)
  );
}

/**
 * A V1 datetime for the model: RFC 3339 in the location's offset when the
 * location's zone is known, otherwise in the server's own offset — still the
 * right instant. `null` for an empty or unreadable value.
 */
export function v1DateForLocation(
  value: unknown,
  locationZone: string | null
): string | null {
  const instant = parseV1Instant(value);
  if (instant === null) return null;
  return toZonedRfc3339(instant, locationZone ?? V1_SERVER_TIMEZONE);
}
