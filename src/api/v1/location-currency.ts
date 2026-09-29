/**
 * The ISO currency code of a location, for analytics results.
 *
 * The location record carries the currency only as a display symbol
 * (`currency_short_title`: "Kč", "zł", "₴", "€"). A symbol is not a code, and
 * "$" is several currencies, so the analytics contract never reports one. The
 * key-metrics endpoint returns the currency with its ISO code; reading it for a
 * single day is the cheapest way to get it. One cached call per location
 * serves every analytics tool, and a failure degrades to `null` rather than
 * failing the report that asked.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { httpFromClient, queryString } from '../altegio-http.js';
import { callEnveloped } from './analytics-http.js';

/** How long a resolved code is trusted; a location's currency rarely changes. */
export const CURRENCY_CACHE_TTL_MS = 60 * 60 * 1000;

const cache = new Map<number, { code: string; expires_at: number }>();

/** A three-letter ISO 4217 code, upper-cased, or `null`. */
export function isoCurrencyCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

async function fromKeyMetrics(
  client: AltegioClient,
  locationId: number,
  now: number
): Promise<string | null> {
  const day = new Date(now).toISOString().slice(0, 10);
  const data = await callEnveloped<Record<string, unknown>>(
    httpFromClient(client),
    `/locations/${locationId}/analytics/overall${queryString({ date_from: day, date_to: day })}`,
    { kind: 'metrics', context: 'read the currency of this location' }
  );
  const total = data.income_total_stats as
    { currency?: { iso?: unknown } } | undefined;
  return isoCurrencyCode(total?.currency?.iso);
}

/** Resolve the ISO currency code of one location, or `null`. */
export async function resolveLocationCurrency(
  client: AltegioClient,
  locationId: number,
  now: number = Date.now()
): Promise<string | null> {
  const cached = cache.get(locationId);
  if (cached && cached.expires_at > now) return cached.code;

  let code: string | null = null;
  try {
    code = await fromKeyMetrics(client, locationId, now);
  } catch {
    // Without analytics access the location record may still hold a code.
  }
  if (!code) {
    try {
      const location = await client.getLocation(locationId, { my: 1 });
      code = isoCurrencyCode(
        location.currency_short_title ?? location.currency ?? null
      );
    } catch {
      // Report without a currency rather than fail the report.
    }
  }
  if (code)
    cache.set(locationId, { code, expires_at: now + CURRENCY_CACHE_TTL_MS });
  return code;
}

/** Drop the cache — used by tests. */
export function clearCurrencyCache(): void {
  cache.clear();
}
