/**
 * The location's ISO currency code comes from the key-metrics currency
 * include, because the location record holds only a display symbol.
 */
import type { AltegioClient } from '../../../providers/altegio-client.js';
import {
  clearCurrencyCache,
  isoCurrencyCode,
  resolveLocationCurrency,
} from '../location-currency.js';

const NOW = Date.UTC(2026, 8, 29, 12);

function client(options: {
  metrics?: { status: number; body: unknown };
  shortTitle?: string;
}): { client: AltegioClient; paths: string[] } {
  const paths: string[] = [];
  const fake = {
    isAuthenticated: () => true,
    apiRequest: async (path: string) => {
      paths.push(path);
      const { status, body } = options.metrics ?? {
        status: 403,
        body: { success: false, data: null, meta: { message: 'Forbidden' } },
      };
      return new Response(JSON.stringify(body), { status });
    },
    getLocation: async () => {
      paths.push('location');
      return { id: 1, currency_short_title: options.shortTitle ?? 'Kč' };
    },
  };
  return { client: fake as unknown as AltegioClient, paths };
}

const metrics = (iso: string) => ({
  status: 200,
  body: {
    success: true,
    data: {
      income_total_stats: {
        current_sum: '0',
        currency: { id: 11, iso, symbol: 'Kč' },
      },
    },
  },
});

beforeEach(() => clearCurrencyCache());
afterAll(() => clearCurrencyCache());

describe('resolveLocationCurrency', () => {
  it('reads the ISO code from a one-day key-metrics call', async () => {
    const { client: c, paths } = client({ metrics: metrics('CZK') });
    await expect(resolveLocationCurrency(c, 1, NOW)).resolves.toBe('CZK');
    expect(paths).toEqual([
      '/locations/1/analytics/overall?date_from=2026-09-29&date_to=2026-09-29',
    ]);
  });

  it('caches a resolved code per location', async () => {
    const { client: c, paths } = client({ metrics: metrics('CZK') });
    await resolveLocationCurrency(c, 1, NOW);
    await resolveLocationCurrency(c, 1, NOW + 1000);
    expect(paths).toHaveLength(1);
  });

  it('falls back to a location title that is already a code', async () => {
    const { client: c } = client({ shortTitle: 'eur' });
    await expect(resolveLocationCurrency(c, 1, NOW)).resolves.toBe('EUR');
  });

  it('reports no currency, not a symbol, and retries later', async () => {
    const { client: c, paths } = client({});
    await expect(resolveLocationCurrency(c, 1, NOW)).resolves.toBeNull();
    await resolveLocationCurrency(c, 1, NOW);
    expect(paths.filter((p) => p !== 'location')).toHaveLength(2);
  });
});

describe('isoCurrencyCode', () => {
  it('accepts three letters only', () => {
    expect(isoCurrencyCode(' usd ')).toBe('USD');
    expect(isoCurrencyCode('Kč')).toBeNull();
    expect(isoCurrencyCode('$')).toBeNull();
    expect(isoCurrencyCode(null)).toBeNull();
  });
});
