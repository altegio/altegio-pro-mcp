/**
 * Filter builder — turns the canonical `ClientSearchFilters` into the v1
 * `/clients/search` wire payload.
 *
 * The v1 filter protocol is an array of `{ type, state }` objects combined by a
 * top-level `operation` (AND/OR). Each `state` is one of three shapes: a `value`
 * (an id array, an enum-code array, or a boolean), a `{ from, to }` range, or —
 * for the appointment-history `record` filter — a nested object of sub-states.
 * This module is the single translation point; everything above it is canonical.
 */
import type {
  AppointmentHistoryFilter,
  ClientSearchFilters,
  FilterMatch,
  Range,
} from '../../api/clients-api.js';
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

/** Build a `{ from, to }` state, keeping only the bounds that are present. */
function rangeState(range: Range): Record<string, number | string> | null {
  const state: Record<string, number | string> = {};
  if (range.from !== undefined && range.from !== null) state.from = range.from;
  if (range.to !== undefined && range.to !== null) state.to = range.to;
  return Object.keys(state).length > 0 ? state : null;
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
    const created = rangeState(filter.created);
    if (created) state.created = created;
  }
  if (filter.count) {
    const count = rangeState(filter.count);
    if (count) state.records_count = count;
  }
  if (filter.amount) {
    const amount = rangeState(filter.amount);
    if (amount) state.sold_amount = amount;
  }
  // `invert` is what makes a lapsed / win-back segment: the clients who did NOT
  // have an appointment matching the rest of this filter.
  if (filter.exclude) state.invert = true;

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
  if (filters.total_spent) push('sold_amount', rangeState(filters.total_spent));
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
  if (filters.birthday) push('birthday', rangeState(filters.birthday));
  if (filters.age) push('age', rangeState(filters.age));
  if (filters.has_mobile_app !== undefined) {
    push('has_mobile_app', value(filters.has_mobile_app));
  }
  if (filters.client_account_balance) {
    push('deposit_balance', rangeState(filters.client_account_balance));
  }
  if (filters.membership_balance) {
    push('abonement_balance', rangeState(filters.membership_balance));
  }
  if (filters.membership_type_ids?.length) {
    push('abonement_types', value(filters.membership_type_ids));
  }
  if (filters.membership_is_frozen !== undefined) {
    push('abonement_is_frozen', value(filters.membership_is_frozen));
  }
  if (filters.membership_is_used !== undefined) {
    push('abonement_is_used', value(filters.membership_is_used));
  }
  if (filters.gift_card_balance) {
    push('certificate_balance', rangeState(filters.gift_card_balance));
  }
  if (filters.gift_card_type_ids?.length) {
    push('certificate_types', value(filters.gift_card_type_ids));
  }
  if (filters.gift_card_is_used !== undefined) {
    push('certificate_is_used', value(filters.gift_card_is_used));
  }
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
