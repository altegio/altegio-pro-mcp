/**
 * Filter-builder unit tests — the semantic core of the clients pack.
 *
 * These lock the canonical → v1 wire translation: the enum codes, the range and
 * value state shapes, the appointment-history `record` filter with its `invert`
 * flag, and — the classic trap of this API — the two different numberings of the
 * same visit outcome.
 */
import { buildFilterPayload } from '../filters.js';
import {
  OUTCOME_TO_ATTENDANCE_CODE,
  OUTCOME_TO_RECORD_CODE,
} from '../vocabulary.js';
import type { ClientSearchFilters } from '../../../api/clients-api.js';

function build(filters: ClientSearchFilters, match: 'all' | 'any' = 'all') {
  return buildFilterPayload(filters, match);
}

/** Find the one wire filter of a given type. */
function byType(payload: ReturnType<typeof buildFilterPayload>, type: string) {
  return payload.filters.find((f) => f.type === type);
}

describe('buildFilterPayload', () => {
  it('produces an empty AND search for no filters', () => {
    expect(build({})).toEqual({ operation: 'AND', filters: [] });
  });

  it('maps match=any to the OR operation', () => {
    expect(build({}, 'any').operation).toBe('OR');
  });

  it('trims quick_search and drops an empty query', () => {
    expect(byType(build({ query: '  James  ' }), 'quick_search')).toEqual({
      type: 'quick_search',
      state: { value: 'James' },
    });
    expect(byType(build({ query: '   ' }), 'quick_search')).toBeUndefined();
  });

  it('maps total_spent to a sold_amount range, keeping only present bounds', () => {
    expect(
      byType(build({ total_spent: { from: 50000 } }), 'sold_amount')
    ).toEqual({ type: 'sold_amount', state: { from: 50000 } });
  });

  it('maps importance and gender labels to their numeric codes', () => {
    expect(
      byType(build({ importance: ['gold', 'silver'] }), 'importance')
    ).toEqual({ type: 'importance', state: { value: [3, 2] } });
    expect(byType(build({ gender: ['male'] }), 'gender')).toEqual({
      type: 'gender',
      state: { value: [1] },
    });
  });

  it('maps client tags to the legacy category filter', () => {
    expect(byType(build({ tag_ids: [1, 7] }), 'category')).toEqual({
      type: 'category',
      state: { value: [1, 7] },
    });
  });

  it('maps membership and gift-card filters to abonement/certificate', () => {
    expect(
      byType(build({ membership_balance: { from: 1 } }), 'abonement_balance')
    ).toEqual({ type: 'abonement_balance', state: { from: 1 } });
    expect(
      byType(build({ gift_card_type_ids: [9] }), 'certificate_types')
    ).toEqual({ type: 'certificate_types', state: { value: [9] } });
  });

  it('maps consent flags to their is_* filters as booleans', () => {
    expect(
      byType(
        build({ mass_notification_allowed: true }),
        'is_mass_notification_allowed'
      )
    ).toEqual({ type: 'is_mass_notification_allowed', state: { value: true } });
    expect(byType(build({ has_mobile_app: false }), 'has_mobile_app')).toEqual({
      type: 'has_mobile_app',
      state: { value: false },
    });
  });

  it('builds the appointment-history record filter with the record status codes', () => {
    const record = byType(
      build({
        appointments: {
          team_member_ids: [1, 2],
          outcome: ['arrived', 'no_show'],
          created: { from: '2026-06-01 00:00:00' },
          count: { from: 1 },
          amount: { to: 500 },
        },
      }),
      'record'
    );
    expect(record).toEqual({
      type: 'record',
      state: {
        staff: { value: [1, 2] },
        // arrived → 3, no_show → 1 in the *record* numbering
        status: { value: [3, 1] },
        created: { from: '2026-06-01 00:00:00' },
        records_count: { from: 1 },
        sold_amount: { to: 500 },
      },
    });
  });

  it('sets invert for a win-back segment, but only alongside a real constraint', () => {
    const winBack = byType(
      build({
        appointments: {
          outcome: ['arrived'],
          created: { from: '2026-06-01 00:00:00' },
          exclude: true,
        },
      }),
      'record'
    );
    expect(winBack?.state.invert).toBe(true);
    expect(winBack?.state.status).toEqual({ value: [3] });

    // `exclude` on its own is meaningless and must be dropped.
    expect(
      byType(build({ appointments: { exclude: true } }), 'record')
    ).toBeUndefined();
  });
});

describe('the two visit-outcome numberings differ', () => {
  it('numbers the record filter and the visit-history attendance differently', () => {
    // This is the trap the pack exists to hide: same outcome, different code.
    expect(OUTCOME_TO_RECORD_CODE.arrived).toBe(3);
    expect(OUTCOME_TO_ATTENDANCE_CODE.arrived).toBe(1);
    expect(OUTCOME_TO_RECORD_CODE.no_show).toBe(1);
    expect(OUTCOME_TO_ATTENDANCE_CODE.no_show).toBe(-1);
    expect(OUTCOME_TO_RECORD_CODE).not.toEqual(OUTCOME_TO_ATTENDANCE_CODE);
  });
});
