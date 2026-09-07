/**
 * Period resolution for the analytics pack.
 *
 * Every analytics tool accepts either an explicit `date_from` + `date_to` pair
 * or one of the presets below. Presets are resolved in the **location's**
 * timezone, so "today" means today at the location, not on the server.
 *
 * The API rejects ranges longer than 365 days with a 422; we refuse them before
 * the call so the agent gets an actionable message instead of a validation
 * error dump.
 */
import { AnalyticsInputError } from './errors.js';

export const PERIOD_PRESETS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'last_30_days',
  'this_quarter',
  'last_quarter',
  'this_year',
] as const;

export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

/** Longest range the API accepts, counted inclusively. */
export const MAX_PERIOD_DAYS = 365;

export interface Period {
  /** Inclusive first day, `YYYY-MM-DD`. */
  readonly date_from: string;
  /** Inclusive last day, `YYYY-MM-DD`. */
  readonly date_to: string;
  /** Number of days the period covers, both ends included. */
  readonly days: number;
  /** Which preset produced it, when a preset was used. */
  readonly preset?: PeriodPreset;
  /** IANA timezone the preset was resolved in, or `UTC` for the fallback. */
  readonly timezone: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

/** Parse `YYYY-MM-DD` into a UTC-midnight timestamp, validating the calendar. */
function parseDay(value: string, field: string): number {
  if (!DATE_PATTERN.test(value)) {
    throw new AnalyticsInputError(
      `${field} must be a date in YYYY-MM-DD format, got "${value}".`
    );
  }
  const ms = Date.parse(`${value}T00:00:00Z`);
  // `Date.parse` rolls impossible dates over (2026-02-30 becomes 2026-03-02),
  // so compare the round-trip instead of only checking for NaN.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new AnalyticsInputError(
      `${field} is not a valid calendar date: "${value}".`
    );
  }
  return ms;
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * "Today" at the location, as a UTC-midnight timestamp of the local calendar
 * day. `Intl` does the timezone arithmetic, so DST is handled for us.
 */
function localToday(timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parseDay(parts, 'today');
}

/** ISO weekday, Monday = 0. Business weeks start on Monday. */
function isoWeekdayIndex(ms: number): number {
  return (new Date(ms).getUTCDay() + 6) % 7;
}

function startOfMonth(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

function startOfQuarter(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1);
}

function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate());
}

function endOfMonth(ms: number): number {
  return addMonths(startOfMonth(ms), 1) - MS_PER_DAY;
}

/**
 * Check that a timezone name is usable, so a stale or missing value degrades
 * to UTC instead of throwing deep inside a tool.
 */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Resolve one preset into an inclusive day range. */
export function resolvePreset(
  preset: PeriodPreset,
  timezone: string
): { date_from: string; date_to: string } {
  const today = localToday(timezone);

  switch (preset) {
    case 'today':
      return { date_from: formatDay(today), date_to: formatDay(today) };
    case 'yesterday': {
      const day = today - MS_PER_DAY;
      return { date_from: formatDay(day), date_to: formatDay(day) };
    }
    case 'this_week': {
      const from = today - isoWeekdayIndex(today) * MS_PER_DAY;
      return { date_from: formatDay(from), date_to: formatDay(today) };
    }
    case 'last_week': {
      const thisWeek = today - isoWeekdayIndex(today) * MS_PER_DAY;
      const from = thisWeek - 7 * MS_PER_DAY;
      return {
        date_from: formatDay(from),
        date_to: formatDay(thisWeek - MS_PER_DAY),
      };
    }
    case 'this_month':
      return {
        date_from: formatDay(startOfMonth(today)),
        date_to: formatDay(today),
      };
    case 'last_month': {
      const from = addMonths(startOfMonth(today), -1);
      return {
        date_from: formatDay(from),
        date_to: formatDay(startOfMonth(today) - MS_PER_DAY),
      };
    }
    case 'last_30_days':
      return {
        date_from: formatDay(today - 29 * MS_PER_DAY),
        date_to: formatDay(today),
      };
    case 'this_quarter':
      return {
        date_from: formatDay(startOfQuarter(today)),
        date_to: formatDay(today),
      };
    case 'last_quarter': {
      const from = addMonths(startOfQuarter(today), -3);
      return {
        date_from: formatDay(from),
        date_to: formatDay(endOfMonth(addMonths(from, 2))),
      };
    }
    case 'this_year': {
      const from = Date.UTC(new Date(today).getUTCFullYear(), 0, 1);
      return { date_from: formatDay(from), date_to: formatDay(today) };
    }
  }
}

export interface PeriodInput {
  readonly period?: PeriodPreset;
  readonly date_from?: string;
  readonly date_to?: string;
}

/**
 * Turn tool input into a validated period.
 *
 * `timezone` is the location's IANA timezone; pass `undefined` when it could not
 * be resolved (the location is not in the authenticated user's location list) —
 * presets then resolve in UTC and the returned period says so.
 */
export function resolvePeriod(
  input: PeriodInput,
  timezone?: string
): Period {
  const zone = timezone && isValidTimezone(timezone) ? timezone : 'UTC';

  if (input.period && (input.date_from || input.date_to)) {
    throw new AnalyticsInputError(
      'Pass either a period preset or an explicit date_from/date_to pair, not both.'
    );
  }

  let from: string;
  let to: string;
  if (input.period) {
    const resolved = resolvePreset(input.period, zone);
    from = resolved.date_from;
    to = resolved.date_to;
  } else if (input.date_from && input.date_to) {
    from = input.date_from;
    to = input.date_to;
  } else if (input.date_from || input.date_to) {
    throw new AnalyticsInputError(
      'date_from and date_to must be given together. Use a period preset such as "last_month" for a single argument.'
    );
  } else {
    throw new AnalyticsInputError(
      `Give a period: either period (one of ${PERIOD_PRESETS.join(', ')}) or date_from + date_to in YYYY-MM-DD format.`
    );
  }

  const fromMs = parseDay(from, 'date_from');
  const toMs = parseDay(to, 'date_to');
  if (toMs < fromMs) {
    throw new AnalyticsInputError(
      `date_to (${to}) is before date_from (${from}). Swap them and retry.`
    );
  }

  const days = Math.round((toMs - fromMs) / MS_PER_DAY) + 1;
  if (days > MAX_PERIOD_DAYS) {
    throw new AnalyticsInputError(
      `The requested period covers ${days} days; analytics accepts at most ${MAX_PERIOD_DAYS} days per call. ` +
        `Narrow the range (for example ${from} to ${formatDay(fromMs + (MAX_PERIOD_DAYS - 1) * MS_PER_DAY)}) or call the tool once per year.`
    );
  }

  return {
    date_from: from,
    date_to: to,
    days,
    timezone: zone,
    ...(input.period ? { preset: input.period } : {}),
  };
}

/**
 * The comparison window the API uses: the same number of days immediately
 * before the requested period.
 */
export function previousPeriod(period: Period): {
  date_from: string;
  date_to: string;
} {
  const fromMs = parseDay(period.date_from, 'date_from');
  const toEnd = fromMs - MS_PER_DAY;
  return {
    date_from: formatDay(toEnd - (period.days - 1) * MS_PER_DAY),
    date_to: formatDay(toEnd),
  };
}

/** Every day in the period, `YYYY-MM-DD`, ascending. */
export function eachDay(period: Period): string[] {
  const fromMs = parseDay(period.date_from, 'date_from');
  return Array.from({ length: period.days }, (_, i) =>
    formatDay(fromMs + i * MS_PER_DAY)
  );
}

/** `YYYY-MM-DD` → `DD.MM.YYYY`, the format the day-end report expects. */
export function toDottedDate(day: string): string {
  const [year, month, date] = day.split('-');
  return `${date}.${month}.${year}`;
}

/**
 * Convert a chart x-value to a `YYYY-MM-DD` day in the location's timezone.
 * The daily charts return epoch milliseconds (and the published examples show
 * ISO strings), so both are accepted.
 */
export function chartPointToDay(
  value: number | string,
  timezone: string
): string {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (Number.isNaN(ms)) return String(value);
  const zone = isValidTimezone(timezone) ? timezone : 'UTC';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ms));
}
