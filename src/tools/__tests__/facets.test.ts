import { describe, it, expect } from '@jest/globals';
import {
  ALL_TOOLS_FACET,
  buildFacetIndex,
  DEFAULT_FACET,
  DEFAULT_FACET_EXTRA_TOOLS,
  FACET_BASE_TOOLS,
  FACET_NAMES,
  isFacetName,
} from '../facets.js';
import { orderedToolEntries } from '../registry.js';

const allNames = () => orderedToolEntries().map((entry) => entry.spec.name);

describe('tools/list ordering', () => {
  it('orders by category, then by name', () => {
    const entries = orderedToolEntries();
    const keys = entries.map(
      // A NUL joiner sorts below every other character, so comparing the
      // joined strings is exactly "category first, then name".
      (entry) => `${entry.category}\u0000${entry.spec.name}`
    );
    const sorted = [...keys].sort();
    expect(keys).toEqual(sorted);
  });

  it('is stable across calls', () => {
    expect(allNames()).toEqual(allNames());
  });

  it('groups every category contiguously', () => {
    const categories = orderedToolEntries().map((entry) => entry.category);
    const firstSeen = new Map<string, number>();
    categories.forEach((category, index) => {
      if (!firstSeen.has(category)) firstSeen.set(category, index);
    });
    for (const [category, start] of firstSeen) {
      const last = categories.lastIndexOf(category);
      const slice = categories.slice(start, last + 1);
      expect(slice.every((c) => c === category)).toBe(true);
    }
  });
});

describe('static facets', () => {
  const names = allNames();

  it('recognizes only the published facet names', () => {
    for (const facet of FACET_NAMES) {
      expect(isFacetName(facet)).toBe(true);
    }
    expect(isFacetName('default')).toBe(false);
    expect(isFacetName('all')).toBe(false);
    expect(isFacetName('nope')).toBe(false);
  });

  it('keeps every non-pack tool on the default view plus the named analytics entry points', () => {
    const index = buildFacetIndex(names);
    const expected = names.filter(
      (name) =>
        !name.startsWith('analytics_') ||
        DEFAULT_FACET_EXTRA_TOOLS.includes(name)
    );
    expect(index.members(DEFAULT_FACET)).toEqual(expected);
  });

  it('gives every facet the authentication and location tools', () => {
    const index = buildFacetIndex(names);
    for (const facet of FACET_NAMES) {
      for (const base of FACET_BASE_TOOLS) {
        expect(index.includes(facet, base)).toBe(true);
      }
    }
  });

  it('serves appointments on ops and nothing from the catalog', () => {
    const index = buildFacetIndex(names);
    expect([...index.members('ops')].sort()).toEqual(
      [
        'altegio_login',
        'altegio_logout',
        'clients_delete',
        'clients_get_card',
        'clients_get_visit_history',
        'clients_lookup',
        'clients_search',
        'create_appointment',
        'delete_appointment',
        'get_appointments',
        'list_locations',
        'update_appointment',
      ].sort()
    );
  });

  it('serves the catalog domains on catalog', () => {
    const index = buildFacetIndex(names);
    expect(index.includes('catalog', 'get_staff')).toBe(true);
    expect(index.includes('catalog', 'get_schedule')).toBe(true);
    expect(index.includes('catalog', 'get_online_booking_settings')).toBe(true);
    expect(index.includes('catalog', 'get_resources')).toBe(true);
    expect(index.includes('catalog', 'get_appointments')).toBe(false);
  });

  it('serves the whole wizard on onboarding and nothing else', () => {
    const index = buildFacetIndex(names);
    const members = index.members('onboarding');
    const wizard = members.filter((name) => name.startsWith('onboarding_'));
    expect(wizard).toHaveLength(12);
    expect(members).toHaveLength(wizard.length + FACET_BASE_TOOLS.length);
  });

  it('leaves marketing at the base tools until its packs land', () => {
    const index = buildFacetIndex(names);
    expect([...index.members('marketing')].sort()).toEqual(
      [...FACET_BASE_TOOLS].sort()
    );
  });

  it('points an out-of-facet tool at the facets that serve it', () => {
    const index = buildFacetIndex(names);
    expect(index.facetsProviding('get_staff')).toEqual(['catalog']);
    expect(index.facetsProviding('get_appointments')).toEqual(['ops']);
    expect(index.facetsProviding('altegio_login')).toEqual([...FACET_NAMES]);
  });

  it('ignores facet rules for tools that do not exist', () => {
    // Simulate a build without the analytics pack: its rules must be inert.
    const withoutPack = names.filter((name) => !name.startsWith('analytics_'));
    const index = buildFacetIndex(withoutPack);
    expect(index.members('analytics')).toEqual([...FACET_BASE_TOOLS]);
    for (const extra of DEFAULT_FACET_EXTRA_TOOLS) {
      expect(index.includes(DEFAULT_FACET, extra)).toBe(false);
    }
  });

  it('keeps a facet list in the order the builder received', () => {
    const index = buildFacetIndex(names);
    const catalog = index.members('catalog');
    expect(catalog).toEqual(names.filter((name) => catalog.includes(name)));
  });

  describe('the onboarding config switch', () => {
    it('removes the wizard from the default view only when on', () => {
      const off = buildFacetIndex(names);
      const on = buildFacetIndex(names, {
        excludeOnboardingFromDefault: true,
      });

      expect(
        off.members(DEFAULT_FACET).filter((n) => n.startsWith('onboarding_'))
      ).toHaveLength(12);
      expect(
        on.members(DEFAULT_FACET).filter((n) => n.startsWith('onboarding_'))
      ).toHaveLength(0);
      // The dedicated facet is unaffected.
      expect(on.members('onboarding')).toEqual(off.members('onboarding'));
    });
  });

  describe('with the analytics pack landed', () => {
    // A pack joins its own facet wholesale, and the default view only gains
    // the entry points named in DEFAULT_FACET_EXTRA_TOOLS.
    const analyticsCount = names.filter((name) =>
      name.startsWith('analytics_')
    ).length;

    it('has the whole pack registered', () => {
      expect(analyticsCount).toBe(14);
    });

    it('admits only the named entry points to the default view', () => {
      const index = buildFacetIndex(names);
      expect(index.includes(DEFAULT_FACET, 'analytics_get_overview')).toBe(
        true
      );
      expect(index.includes(DEFAULT_FACET, 'analytics_run_report')).toBe(true);
      expect(index.includes(DEFAULT_FACET, 'analytics_get_daily_series')).toBe(
        false
      );
      expect(index.members(DEFAULT_FACET)).toHaveLength(
        names.length - analyticsCount + DEFAULT_FACET_EXTRA_TOOLS.length
      );
    });

    it('serves everything on the unfiltered view stdio uses', () => {
      const index = buildFacetIndex(names);
      expect(index.members(ALL_TOOLS_FACET)).toEqual(names);
      // Which is strictly more than the default HTTP view holds back to.
      expect(index.members(DEFAULT_FACET)).not.toEqual(names);
      expect(
        index.includes(ALL_TOOLS_FACET, 'analytics_get_daily_series')
      ).toBe(true);
    });

    it('admits the whole pack to its own facet and to finance', () => {
      const index = buildFacetIndex(names);
      expect(index.members('analytics')).toHaveLength(
        FACET_BASE_TOOLS.length + analyticsCount
      );
      expect(index.members('finance')).toHaveLength(
        FACET_BASE_TOOLS.length + analyticsCount
      );
      expect(index.includes('ops', 'analytics_get_overview')).toBe(false);
    });
  });
});
