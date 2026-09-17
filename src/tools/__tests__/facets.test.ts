import { describe, it, expect } from '@jest/globals';
import {
  ALL_TOOLS_FACET,
  buildFacetIndex,
  DEFAULT_FACET,
  DEFAULT_FACET_EXCLUDED_TOOLS,
  DEFAULT_FACET_EXTRA_TOOLS,
  FACET_BASE_TOOLS,
  FACET_NAMES,
  isFacetName,
  PASSWORD_LOGIN_TOOLS,
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
        !PASSWORD_LOGIN_TOOLS.includes(name) &&
        !DEFAULT_FACET_EXCLUDED_TOOLS.includes(name) &&
        (!name.startsWith('analytics_') ||
          DEFAULT_FACET_EXTRA_TOOLS.includes(name))
    );
    expect(index.members(DEFAULT_FACET)).toEqual(expected);
  });

  it('gives every facet the location tools', () => {
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
    expect(index.facetsProviding('list_locations')).toEqual([...FACET_NAMES]);
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

  describe('the password login switch', () => {
    // altegio_login instructs the model to collect an email and a password.
    // The public HTTP endpoint authenticates through OAuth and never needs
    // them, so the switch is off by default and no HTTP view carries the tools.
    it('names both halves of the password login pair', () => {
      expect([...PASSWORD_LOGIN_TOOLS].sort()).toEqual([
        'altegio_login',
        'altegio_logout',
      ]);
      for (const name of PASSWORD_LOGIN_TOOLS) {
        expect(names).toContain(name);
      }
    });

    it('keeps password login off every HTTP view by default', () => {
      const index = buildFacetIndex(names);
      for (const name of PASSWORD_LOGIN_TOOLS) {
        expect(index.includes(DEFAULT_FACET, name)).toBe(false);
        for (const facet of FACET_NAMES) {
          expect(index.includes(facet, name)).toBe(false);
        }
        // Nothing to point a refused caller at, either.
        expect(index.facetsProviding(name)).toEqual([]);
      }
    });

    it('still serves password login on the unfiltered view stdio uses', () => {
      const off = buildFacetIndex(names);
      const on = buildFacetIndex(names, { exposePasswordLogin: true });
      for (const name of PASSWORD_LOGIN_TOOLS) {
        expect(off.includes(ALL_TOOLS_FACET, name)).toBe(true);
        expect(on.includes(ALL_TOOLS_FACET, name)).toBe(true);
      }
      // The switch does not filter `all` at all.
      expect(on.members(ALL_TOOLS_FACET)).toEqual(off.members(ALL_TOOLS_FACET));
    });

    it('admits password login to every view when on — the closed staff deployment', () => {
      const index = buildFacetIndex(names, { exposePasswordLogin: true });
      for (const name of PASSWORD_LOGIN_TOOLS) {
        expect(index.includes(DEFAULT_FACET, name)).toBe(true);
        for (const facet of FACET_NAMES) {
          expect(index.includes(facet, name)).toBe(true);
        }
        expect(index.facetsProviding(name)).toEqual([...FACET_NAMES]);
      }
    });

    it('changes nothing else about the views it filters', () => {
      const off = buildFacetIndex(names);
      const on = buildFacetIndex(names, { exposePasswordLogin: true });
      const withoutLogin = (list: readonly string[]) =>
        list.filter((name) => !PASSWORD_LOGIN_TOOLS.includes(name));

      for (const key of [DEFAULT_FACET, ...FACET_NAMES] as const) {
        expect(off.members(key)).toEqual(withoutLogin(on.members(key)));
      }
    });
  });

  describe('access management on the default view', () => {
    // Handing out and revoking location access is a dangerous right that the
    // default endpoint does not offer a generic agent (v3 authorization RFC).
    it('withholds remove_location_user from /mcp', () => {
      const index = buildFacetIndex(names);
      expect(index.includes(DEFAULT_FACET, 'remove_location_user')).toBe(false);
    });

    it('keeps it reachable on the catalog facet and on stdio', () => {
      const index = buildFacetIndex(names);
      expect(index.includes('catalog', 'remove_location_user')).toBe(true);
      expect(index.includes(ALL_TOOLS_FACET, 'remove_location_user')).toBe(
        true
      );
      expect(index.facetsProviding('remove_location_user')).toEqual([
        'catalog',
      ]);
    });

    it('stays excluded whatever the other switches say', () => {
      for (const options of [
        {},
        { exposePasswordLogin: true },
        { excludeOnboardingFromDefault: true },
      ]) {
        const index = buildFacetIndex(names, options);
        for (const name of DEFAULT_FACET_EXCLUDED_TOOLS) {
          expect(index.includes(DEFAULT_FACET, name)).toBe(false);
        }
      }
    });
  });

  describe('determinism (ADR-001 D7)', () => {
    it('gives the same list for the same inputs, every build', () => {
      for (const options of [
        {},
        { exposePasswordLogin: true },
        { excludeOnboardingFromDefault: true },
      ]) {
        const first = buildFacetIndex(names, options);
        const second = buildFacetIndex(names, options);
        for (const key of first.keys) {
          expect(second.members(key)).toEqual(first.members(key));
        }
      }
    });
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

    it('has the whole served pack registered', () => {
      // 15 defined, 6 withheld — see src/tools/disabled-tools.ts.
      expect(analyticsCount).toBe(9);
    });

    it('admits only the named entry points to the default view', () => {
      const index = buildFacetIndex(names);
      expect(index.includes(DEFAULT_FACET, 'analytics_get_overview')).toBe(
        true
      );
      // The report-builder entry points are gone from every view.
      expect(index.includes(DEFAULT_FACET, 'analytics_run_report')).toBe(false);
      expect(
        index.includes(DEFAULT_FACET, 'analytics_delete_assistant_report')
      ).toBe(false);
      expect(index.includes(DEFAULT_FACET, 'analytics_get_daily_series')).toBe(
        false
      );
      expect(index.members(DEFAULT_FACET)).toHaveLength(
        names.length -
          analyticsCount +
          DEFAULT_FACET_EXTRA_TOOLS.length -
          PASSWORD_LOGIN_TOOLS.length -
          DEFAULT_FACET_EXCLUDED_TOOLS.length
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
