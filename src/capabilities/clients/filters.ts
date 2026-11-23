/**
 * Filter builder — turns the canonical `ClientSearchFilters` into the v1
 * `/clients/search` wire payload.
 *
 * The v1 filter protocol is an array of `{ type, state }` objects combined by a
 * top-level `operation` (AND/OR). Each `state` is one of three shapes: a `value`
 * (an id array, an enum-code array, or a boolean), a `{ from, to }` range, or —
 * for the appointment-history `record` filter and the membership / gift card
 * `sale_abonement` / `sale_certificate` groups — a nested object of sub-states.
 * This module is the single translation point; everything above it is canonical.
 *
 * The backend answers 400 for a state it cannot parse, with a message that does
 * not name the filter. Inputs it would reject are therefore either normalized
 * here (a date-time bound becomes its date, an `MM-DD` birthday gets a year) or
 * refused with a `ClientsInputError` that names the filter and the fix.
 */
import type {
  AppointmentHistoryFilter,
  ClientSearchFilters,
  FilterMatch,
  Range,
} from '../../api/clients-api.js';
import { ClientsInputError } from './errors.js';
import {
  GENDER_TO_CODE,
  IMPORTANCE_TO_CODE,
  OUTCOME_TO_RECORD_CODE,
} from './vocabulary.js';

/** One entry of the wire `filters` array. */
export interface WireFilter {
  type: string;
  state: Record<string, unknown>;
}

export interface WireFilterPayload {
  operation: 'AND' | 'OR';
  filters: WireFilter[];
}

type Bound = number | string;

interface NumberRangeRules {
  /** The backend refuses a negative bound for this filter. */
  nonNegative?: boolean;
  /** The backend casts the bound to an integer. */
  integer?: boolean;
}

/**
 * A numeric `{ from, to }` state the backend accepts: numbers only, `from`
 * not above `to`, and no negative bound where the backend requires one.
 */
function numberRangeState(
  range: Range,
  name: string,
  rules: NumberRangeRules = {}
): Record<string, number> | null {
  const state: Record<string, number> = {};
  for (const key of ['from', 'to'] as const) {
    const raw = range[key];
    if (raw === undefined || raw === null) continue;
    const bound = typeof raw === 'number' ? raw : Number(String(raw).trim());
    if (typeof raw === 'string' && raw.trim() === '') continue;
    if (!Number.isFinite(bound)) {
      throw new ClientsInputError(
        `Filter ${name}.${key} must be a number, got "${String(raw)}".`
      );
    }
    if (rules.integer && !Number.isInteger(bound)) {
      throw new ClientsInputError(
        `Filter ${name}.${key} must be a whole number, got ${bound}.`
      );
    }
    if (rules.nonNegative && bound < 0) {
      throw new ClientsInputError(
        `Filter ${name}.${key} cannot be negative, got ${bound}.`
      );
    }
    state[key] = bound;
  }
  if (
    state.from !== undefined &&
    state.to !== undefined &&
    state.from > state.to
  ) {
    throw new ClientsInputError(
      `Filter ${name} has from ${state.from} above to ${state.to}; swap the bounds.`
    );
  }
  return Object.keys(state).length > 0 ? state : null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A date-time whose date part is used: `2026-06-01 00:00:00`, `2026-06-01T09:00Z`. */
const ISO_DATE_TIME =
  /^(\d{4}-\d{2}-\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
const MONTH_DAY = /^(\d{2})-(\d{2})$/;
/** The backend's relative offset: `-30 days`, `0 days`, `+1 month`. */
const RELATIVE_DATE = /^[-+]?\d{1,4} (?:day|week|month|year)s?$/;
/**
 * A leap year, so `02-29` stays a real date. The birthday filter compares month
 * and day only; the year matters solely for the backend's window-length check.
 */
const BIRTHDAY_YEAR = 2000;

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** One date bound in a form the backend accepts: `YYYY-MM-DD` or relative. */
function dateBound(raw: Bound, name: string): string {
  const text = String(raw).trim();
  if (RELATIVE_DATE.test(text)) return text;
  const dateTime = ISO_DATE_TIME.exec(text);
  const date = dateTime ? dateTime[1]! : text;
  const parts = ISO_DATE.exec(date);
  if (
    parts &&
    isRealDate(Number(parts[1]), Number(parts[2]), Number(parts[3]))
  ) {
    return date;
  }
  throw new ClientsInputError(
    `Filter ${name} must be YYYY-MM-DD or a relative offset such as "-30 days", got "${text}".`
  );
}

/** A date `{ from, to }` state; bounds may be YYYY-MM-DD or relative offsets. */
function dateRangeState(
  range: Range,
  name: string
): Record<string, string> | null {
  const state: Record<string, string> = {};
  for (const key of ['from', 'to'] as const) {
    const raw = range[key];
    if (raw === undefined || raw === null || String(raw).trim() === '')
      continue;
    state[key] = dateBound(raw, `${name}.${key}`);
  }
  if (
    state.from !== undefined &&
    state.to !== undefined &&
    ISO_DATE.test(state.from) &&
    ISO_DATE.test(state.to) &&
    state.from > state.to
  ) {
    throw new ClientsInputError(
      `Filter ${name} has from ${state.from} after to ${state.to}; swap the bounds.`
    );
  }
  return Object.keys(state).length > 0 ? state : null;
}

/**
 * The birthday window. `MM-DD` bounds (a yearly band) get a placeholder leap
 * year, since the backend parses only full dates; month and day are what it
 * compares, and a window may cross the new year (`12-20` to `01-10`). Full
 * dates must span less than a year, which the backend otherwise refuses.
 */
function birthdayState(range: Range): Record<string, string> | null {
  const raw: Partial<Record<'from' | 'to', string>> = {};
  for (const key of ['from', 'to'] as const) {
    const value = range[key];
    if (value === undefined || value === null || String(value).trim() === '') {
      continue;
    }
    raw[key] = String(value).trim();
  }
  const keys = Object.keys(raw) as Array<'from' | 'to'>;
  if (keys.length === 0) return null;

  const monthDay = keys.some((key) => MONTH_DAY.test(raw[key]!));
  const state: Record<string, string> = {};
  for (const key of keys) {
    const text = raw[key]!;
    const name = `birthday.${key}`;
    if (monthDay) {
      // A yearly band: reduce every bound to its month and day.
      const md = MONTH_DAY.exec(text);
      const full = md ? null : ISO_DATE.exec(dateBound(text, name));
      if (!md && !full) {
        throw new ClientsInputError(
          'Filter birthday mixes MM-DD with a relative offset; give both bounds as MM-DD.'
        );
      }
      const month = Number(md ? md[1] : full?.[2]);
      const day = Number(md ? md[2] : full?.[3]);
      if (!isRealDate(BIRTHDAY_YEAR, month, day)) {
        throw new ClientsInputError(
          `Filter ${name} must be MM-DD or YYYY-MM-DD, got "${text}".`
        );
      }
      state[key] =
        `${BIRTHDAY_YEAR}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    } else {
      state[key] = dateBound(text, name);
    }
  }
  if (
    !monthDay &&
    state.from !== undefined &&
    state.to !== undefined &&
    ISO_DATE.test(state.from) &&
    ISO_DATE.test(state.to)
  ) {
    const from = new Date(`${state.from}T00:00:00Z`);
    const yearLater = new Date(from);
    yearLater.setUTCFullYear(from.getUTCFullYear() + 1);
    if (new Date(`${state.to}T00:00:00Z`) >= yearLater) {
      throw new ClientsInputError(
        'Filter birthday must span less than a year; for a yearly band give MM-DD bounds, e.g. {"from":"09-01","to":"09-30"}.'
      );
    }
  }
  return state;
}

/** Build the nested `record` (appointment-history) state. */
function appointmentState(
  filter: AppointmentHistoryFilter
): Record<string, unknown> | null {
  const state: Record<string, unknown> = {};
  if (filter.team_member_ids?.length) {
    state.staff = { value: filter.team_member_ids };
  }
  if (filter.service_ids?.length) {
    state.service = { value: filter.service_ids };
  }
  if (filter.service_category_ids?.length) {
    state.service_category = { value: filter.service_category_ids };
  }
  if (filter.outcome?.length) {
    state.status = {
      value: filter.outcome.map((outcome) => OUTCOME_TO_RECORD_CODE[outcome]),
    };
  }
  if (filter.created) {
    const created = dateRangeState(filter.created, 'appointments.created');
    if (created) state.created = created;
  }
  // `invert` is what makes a lapsed / win-back segment: the clients who did NOT
  // have an appointment matching the rest of this filter.
  let invert = filter.exclude === true;
  if (filter.count) {
    // The backend refuses a range whose given bounds are all 0, so `from: 0`
    // (no lower limit) is dropped, and "at most 0" — no matching appointment —
    // becomes the inverse of "at least 1".
    const count = numberRangeState(filter.count, 'appointments.count', {
      integer: true,
      nonNegative: true,
    });
    if (count?.to === 0) {
      state.records_count = { from: 1 };
      invert = !invert;
    } else if (count) {
      const { from, to } = count;
      const bounds = {
        ...(from ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      };
      if (Object.keys(bounds).length > 0) state.records_count = bounds;
    }
  }
  if (filter.amount) {
    const amount = numberRangeState(filter.amount, 'appointments.amount', {
      nonNegative: true,
    });
    if (amount?.to === 0) {
      throw new ClientsInputError(
        'Filter appointments.amount.to must be above 0; the backend cannot match appointments with nothing sold.'
      );
    }
    if (amount) {
      const { from, to } = amount;
      const bounds = {
        ...(from ? { from } : {}),
        ...(to !== undefined ? { to } : {}),
      };
      if (Object.keys(bounds).length > 0) state.sold_amount = bounds;
    }
  }
  if (invert) state.invert = true;

  // An appointment filter with `exclude` but no other constraint is meaningless;
  // require at least one positive constraint alongside the inversion.
  const hasConstraint = Object.keys(state).some((key) => key !== 'invert');
  return hasConstraint ? state : null;
}

/**
 * Translate the canonical filter model to the wire payload. Empty inputs produce
 * an empty `filters` array — a valid "whole client base" search.
 */
export function buildFilterPayload(
  filters: ClientSearchFilters,
  match: FilterMatch
): WireFilterPayload {
  const wire: WireFilter[] = [];
  const push = (type: string, state: Record<string, unknown> | null): void => {
    if (state) wire.push({ type, state });
  };
  const value = (v: unknown): Record<string, unknown> => ({ value: v });

  if (filters.query?.trim()) push('quick_search', value(filters.query.trim()));
  if (filters.client_ids?.length) push('id', value(filters.client_ids));
  if (filters.total_spent) {
    push(
      'sold_amount',
      numberRangeState(filters.total_spent, 'total_spent', {
        nonNegative: true,
      })
    );
  }
  if (filters.importance?.length) {
    push(
      'importance',
      value(filters.importance.map((i) => IMPORTANCE_TO_CODE[i]))
    );
  }
  if (filters.gender?.length) {
    push('gender', value(filters.gender.map((g) => GENDER_TO_CODE[g])));
  }
  if (filters.tag_ids?.length) push('category', value(filters.tag_ids));
  if (filters.birthday) push('birthday', birthdayState(filters.birthday));
  if (filters.age) {
    push(
      'age',
      numberRangeState(filters.age, 'age', { integer: true, nonNegative: true })
    );
  }
  if (filters.has_mobile_app !== undefined) {
    push('has_mobile_app', value(filters.has_mobile_app));
  }
  if (filters.client_account_balance) {
    push(
      'deposit_balance',
      numberRangeState(filters.client_account_balance, 'client_account_balance')
    );
  }

  // Membership and gift card conditions are not top-level filter types: the
  // backend applies them only inside their `sale_abonement` / `sale_certificate`
  // group and silently ignores them anywhere else. One group matches clients
  // holding a membership (gift card) sold at this location that meets every
  // condition in it.
  const membership: Record<string, unknown> = {};
  if (filters.membership_balance) {
    const balance = numberRangeState(
      filters.membership_balance,
      'membership_balance',
      { integer: true, nonNegative: true }
    );
    if (balance) membership.abonement_balance = balance;
  }
  if (filters.membership_type_ids?.length) {
    membership.abonement_types = value(filters.membership_type_ids);
  }
  if (filters.membership_is_frozen !== undefined) {
    membership.abonement_is_frozen = value(filters.membership_is_frozen);
  }
  if (filters.membership_is_used !== undefined) {
    membership.abonement_is_used = value(filters.membership_is_used);
  }
  if (Object.keys(membership).length > 0) push('sale_abonement', membership);

  const giftCard: Record<string, unknown> = {};
  if (filters.gift_card_balance) {
    const balance = numberRangeState(
      filters.gift_card_balance,
      'gift_card_balance',
      { nonNegative: true }
    );
    if (balance) giftCard.certificate_balance = balance;
  }
  if (filters.gift_card_type_ids?.length) {
    giftCard.certificate_types = value(filters.gift_card_type_ids);
  }
  if (filters.gift_card_is_used !== undefined) {
    giftCard.certificate_is_used = value(filters.gift_card_is_used);
  }
  if (Object.keys(giftCard).length > 0) push('sale_certificate', giftCard);

  if (filters.newsletter_allowed !== undefined) {
    push('is_newsletter_allowed', value(filters.newsletter_allowed));
  }
  if (filters.mass_notification_allowed !== undefined) {
    push(
      'is_mass_notification_allowed',
      value(filters.mass_notification_allowed)
    );
  }
  if (filters.push_enabled !== undefined) {
    push('is_push_notification_enabled', value(filters.push_enabled));
  }
  if (filters.personal_data_processing_allowed !== undefined) {
    push(
      'is_personal_data_processing_allowed',
      value(filters.personal_data_processing_allowed)
    );
  }
  if (filters.appointments) {
    push('record', appointmentState(filters.appointments));
  }

  return { operation: match === 'any' ? 'OR' : 'AND', filters: wire };
}
