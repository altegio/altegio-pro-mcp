/**
 * Period resolution: presets in the location's timezone, the 365-day guard, the
 * previous-period rule, and the day-end report's dotted dates.
 *
 * The tests pin "today" with fake timers so a preset means the same thing in
 * CI as on a developer machine.
 */
import {
  MAX_PERIOD_DAYS,
  PERIOD_PRESETS,
  chartPointToDay,
  eachDay,
  isValidTimezone,
  previousPeriod,
  resolvePeriod,
  resolvePreset,
  toDottedDate,
} from '../periods.js';
import { AnalyticsInputError } from '../errors.js';

// A Wednesday, 21:30 UTC — already Thursday in Almaty, still Wednesday in Lisbon.
const NOW = '2026-09-09T21:30:00Z';

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date(NOW));
});
afterEach(() => {
  jest.useRealTimers();
});

describe('resolvePreset', () => {
  it.each([
    ['today', '2026-09-09', '2026-09-09'],
    ['yesterday', '2026-09-08', '2026-09-08'],
    ['this_week', '2026-09-07', '2026-09-09'],
    ['last_week', '2026-08-31', '2026-09-06'],
    ['this_month', '2026-09-01', '2026-09-09'],
    ['last_month', '2026-08-01', '2026-08-31'],
    ['last_30_days', '2026-08-11', '2026-09-09'],
    ['this_quarter', '2026-07-01', '2026-09-09'],
    ['last_quarter', '2026-04-01', '2026-06-30'],
    ['this_year', '2026-01-01', '2026-09-09'],
  ])('%s resolves to %s…%s in UTC', (preset, from, to) => {
    expect(resolvePreset(preset as (typeof PERIOD_PRESETS)[number], 'UTC')).toEqual(
      { date_from: from, date_to: to }
    );
  });

  it('resolves the same instant to a different day per timezone', () => {
    expect(resolvePreset('today', 'Asia/Almaty').date_to).toBe('2026-09-10');
    expect(resolvePreset('today', 'Europe/Lisbon').date_to).toBe('2026-09-09');
    // …and "this month" follows the local day, not the server's.
    expect(resolvePreset('this_month', 'Asia/Almaty')).toEqual({
      date_from: '2026-09-01',
      date_to: '2026-09-10',
    });
  });

  it('starts weeks on Monday', () => {
    // 2026-09-07 is a Monday.
    expect(new Date('2026-09-07T00:00:00Z').getUTCDay()).toBe(1);
    expect(resolvePreset('this_week', 'UTC').date_from).toBe('2026-09-07');
  });

  it('covers every declared preset', () => {
    for (const preset of PERIOD_PRESETS) {
      const range = resolvePreset(preset, 'UTC');
      expect(range.date_from <= range.date_to).toBe(true);
    }
  });
});

describe('resolvePeriod', () => {
  it('resolves a preset and reports the timezone it used', () => {
    const period = resolvePeriod({ period: 'last_month' }, 'Europe/Berlin');
    expect(period).toMatchObject({
      date_from: '2026-08-01',
      date_to: '2026-08-31',
      days: 31,
      preset: 'last_month',
      timezone: 'Europe/Berlin',
    });
  });

  it('falls back to UTC when the timezone is missing or unusable', () => {
    expect(resolvePeriod({ period: 'today' }).timezone).toBe('UTC');
    expect(
      resolvePeriod({ period: 'today' }, 'Not/AZone').timezone
    ).toBe('UTC');
  });

  it('accepts an explicit range and records no preset', () => {
    const period = resolvePeriod({
      date_from: '2026-01-01',
      date_to: '2026-01-31',
    });
    expect(period.days).toBe(31);
    expect(period.preset).toBeUndefined();
    expect('preset' in period).toBe(false);
  });

  it('refuses a preset together with explicit dates', () => {
    expect(() =>
      resolvePeriod({ period: 'today', date_from: '2026-01-01' })
    ).toThrow(AnalyticsInputError);
  });

  it('refuses half a range with a hint about presets', () => {
    expect(() => resolvePeriod({ date_from: '2026-01-01' })).toThrow(
      /must be given together/
    );
  });

  it('refuses no period at all and lists the presets', () => {
    expect(() => resolvePeriod({})).toThrow(/last_month/);
  });

  it('refuses a reversed range', () => {
    expect(() =>
      resolvePeriod({ date_from: '2026-02-01', date_to: '2026-01-01' })
    ).toThrow(/Swap them/);
  });

  it('refuses a malformed date', () => {
    expect(() =>
      resolvePeriod({ date_from: '01.01.2026', date_to: '2026-01-31' })
    ).toThrow(/YYYY-MM-DD/);
    expect(() =>
      resolvePeriod({ date_from: '2026-02-30', date_to: '2026-03-01' })
    ).toThrow(/valid calendar date/);
  });

  it('accepts exactly 365 days and refuses 366 with an actionable message', () => {
    expect(
      resolvePeriod({ date_from: '2026-01-01', date_to: '2026-12-31' }).days
    ).toBe(365);
    expect(() =>
      resolvePeriod({ date_from: '2026-01-01', date_to: '2027-01-01' })
    ).toThrow(
      new RegExp(`366 days; analytics accepts at most ${MAX_PERIOD_DAYS}`)
    );
    expect(() =>
      resolvePeriod({ date_from: '2026-01-01', date_to: '2027-01-01' })
    ).toThrow(/2026-01-01 to 2026-12-31/);
  });
});

describe('previousPeriod', () => {
  it('is the window of equal length immediately before', () => {
    const period = resolvePeriod({
      date_from: '2026-08-01',
      date_to: '2026-08-31',
    });
    expect(previousPeriod(period)).toEqual({
      date_from: '2026-07-01',
      date_to: '2026-07-31',
    });
  });

  it('works for a single day', () => {
    const period = resolvePeriod({
      date_from: '2026-03-01',
      date_to: '2026-03-01',
    });
    expect(previousPeriod(period)).toEqual({
      date_from: '2026-02-28',
      date_to: '2026-02-28',
    });
  });
});

describe('day helpers', () => {
  it('enumerates every day of a period', () => {
    const days = eachDay(
      resolvePeriod({ date_from: '2026-02-27', date_to: '2026-03-02' })
    );
    expect(days).toEqual([
      '2026-02-27',
      '2026-02-28',
      '2026-03-01',
      '2026-03-02',
    ]);
  });

  it('renders the dotted format the day-end report expects', () => {
    expect(toDottedDate('2026-08-01')).toBe('01.08.2026');
  });

  it('buckets a chart timestamp in the given timezone', () => {
    const utcMidnight = Date.parse('2026-08-01T00:00:00Z');
    expect(chartPointToDay(utcMidnight, 'UTC')).toBe('2026-08-01');
    expect(chartPointToDay(utcMidnight, 'America/New_York')).toBe('2026-07-31');
    expect(chartPointToDay('2026-08-01T09:00:00+02:00', 'Europe/Berlin')).toBe(
      '2026-08-01'
    );
    expect(chartPointToDay('not a date', 'UTC')).toBe('not a date');
  });

  it('validates timezone names', () => {
    expect(isValidTimezone('Europe/Berlin')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
});
