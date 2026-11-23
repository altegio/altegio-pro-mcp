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
  SORT_FIELD_TO_WIRE,
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

  it('nests membership filters in one sale_abonement group (regression: top-level types were ignored)', () => {
    const payload = build({
      membership_balance: { to: 0 },
      membership_is_used: true,
      membership_type_ids: [4],
      membership_is_frozen: false,
    });
    expect(payload.filters).toEqual([
      {
        type: 'sale_abonement',
        state: {
          abonement_balance: { to: 0 },
          abonement_types: { value: [4] },
          abonement_is_frozen: { value: false },
          abonement_is_used: { value: true },
        },
      },
    ]);
    expect(byType(payload, 'abonement_balance')).toBeUndefined();
  });

  it('nests gift card filters in one sale_certificate group', () => {
    expect(
      build({ gift_card_type_ids: [9], gift_card_balance: { from: 10.5 } })
        .filters
    ).toEqual([
      {
        type: 'sale_certificate',
        state: {
          certificate_balance: { from: 10.5 },
          certificate_types: { value: [9] },
        },
      },
    ]);
  });

  it('refuses a fractional membership visit balance and reversed ranges', () => {
    expect(() => build({ membership_balance: { from: 1.5 } })).toThrow(
      /whole number/
    );
    expect(() => build({ total_spent: { from: 500, to: 100 } })).toThrow(
      /swap the bounds/
    );
    expect(() => build({ age: { from: -1 } })).toThrow(/cannot be negative/);
  });

  it('gives MM-DD birthday bounds a year the backend accepts', () => {
    expect(
      byType(build({ birthday: { from: '12-20', to: '01-10' } }), 'birthday')
    ).toEqual({
      type: 'birthday',
      state: { from: '2000-12-20', to: '2000-01-10' },
    });
    expect(
      byType(build({ birthday: { from: '02-29' } }), 'birthday')?.state
    ).toEqual({ from: '2000-02-29' });
    expect(
      byType(build({ birthday: { from: '0 days', to: '+7 days' } }), 'birthday')
        ?.state
    ).toEqual({ from: '0 days', to: '+7 days' });
  });

  it('refuses birthday bounds the backend would reject with a bare 400', () => {
    expect(() => build({ birthday: { from: '13-01' } })).toThrow(/MM-DD/);
    expect(() =>
      build({ birthday: { from: '1990-01-01', to: '2000-01-01' } })
    ).toThrow(/less than a year/);
    expect(() => build({ birthday: { from: '09-01', to: '+7 days' } })).toThrow(
      /relative offset/
    );
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
          created: { from: '2026-06-01' },
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
        created: { from: '2026-06-01' },
        records_count: { from: 1 },
        sold_amount: { to: 500 },
      },
    });
  });

  it('sends the date part of a date-time and refuses other date shapes', () => {
    expect(
      byType(
        build({
          appointments: {
            created: { from: '2026-06-01 00:00:00', to: '2026-06-30T23:59Z' },
          },
        }),
        'record'
      )?.state.created
    ).toEqual({ from: '2026-06-01', to: '2026-06-30' });
    expect(
      byType(
        build({ appointments: { created: { from: '-90 days' } } }),
        'record'
      )?.state.created
    ).toEqual({ from: '-90 days' });
    expect(() =>
      build({ appointments: { created: { from: '06/01/2026' } } })
    ).toThrow(/YYYY-MM-DD/);
  });

  it('avoids the zero bounds the backend rejects in the record filter', () => {
    // from 0 is no lower bound at all.
    expect(
      byType(
        build({
          appointments: { service_ids: [5], count: { from: 0, to: 3 } },
        }),
        'record'
      )?.state
    ).toEqual({ service: { value: [5] }, records_count: { to: 3 } });
    // "at most 0" is "not at least 1".
    expect(
      byType(build({ appointments: { count: { to: 0 } } }), 'record')?.state
    ).toEqual({ records_count: { from: 1 }, invert: true });
    expect(
      byType(
        build({
          appointments: { service_ids: [5], count: { to: 0 }, exclude: true },
        }),
        'record'
      )?.state
    ).toEqual({ service: { value: [5] }, records_count: { from: 1 } });
    expect(
      byType(
        build({ appointments: { service_ids: [5], amount: { from: 0 } } }),
        'record'
      )?.state
    ).toEqual({ service: { value: [5] } });
    expect(() =>
      build({ appointments: { service_ids: [5], amount: { to: 0 } } })
    ).toThrow(/above 0/);
  });

  it('sets invert for a win-back segment, but only alongside a real constraint', () => {
    const winBack = byType(
      build({
        appointments: {
          outcome: ['arrived'],
          created: { from: '2026-06-01' },
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

describe('sort field', () => {
  it('sends visits_count for visit_count (regression: API rejected visit_count)', () => {
    expect(SORT_FIELD_TO_WIRE.visit_count).toBe('visits_count');
    expect(SORT_FIELD_TO_WIRE.total_spent).toBe('sold_amount');
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
