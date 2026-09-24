import { describe, it, expect } from '@jest/globals';
import {
  ALL_TOOLS_FACET,
  buildFacetIndex,
  DEFAULT_FACET,
  DEFAULT_FACET_EXCLUDED_TOOLS,
  DEFAULT_FACET_EXTRA_TOOLS,
  FACET_BASE_TOOLS,
  FACET_NAMES,
  facetToolsFromSpecs,
  isFacetName,
  PASSWORD_LOGIN_TOOLS,
  READONLY_VIEW,
  readOnlyRefusalMessage,
  viewUrl,
  type FacetTool,
} from '../facets.js';
import { orderedToolEntries } from '../registry.js';

const allNames = () => orderedToolEntries().map((entry) => entry.spec.name);
const allTools = (): FacetTool[] =>
  facetToolsFromSpecs(orderedToolEntries().map((entry) => entry.spec));

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

describe('static views', () => {
  const names = allNames();
  const tools = allTools();

  it('recognizes only the published facet names', () => {
    for (const facet of FACET_NAMES) {
      expect(isFacetName(facet)).toBe(true);
    }
    expect(isFacetName('default')).toBe(false);
    expect(isFacetName('all')).toBe(false);
    expect(isFacetName('nope')).toBe(false);
  });

  it('keeps every non-pack tool on the default view plus the named analytics entry points', () => {
    const index = buildFacetIndex(tools);
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
    const index = buildFacetIndex(tools);
    for (const facet of FACET_NAMES) {
      for (const base of FACET_BASE_TOOLS) {
        expect(index.includes(facet, base)).toBe(true);
      }
    }
  });

  it('serves appointments on ops and nothing from the catalog', () => {
    const index = buildFacetIndex(tools);
    expect([...index.members('ops')].sort()).toEqual(
      [
        'appointments_attendance_apply',
        'appointments_attendance_preview',
        'clients_add_comment',
        'clients_delete',
        'clients_get_card',
        'clients_get_membership_purchases',
        'clients_get_segment_report',
        'clients_list_profiles',
        'clients_get_visit_history',
        'clients_lookup',
        'clients_list_comments',
        'clients_list_files',
        'clients_upload_file',
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
    const index = buildFacetIndex(tools);
    expect(index.includes('catalog', 'get_staff')).toBe(true);
    expect(index.includes('catalog', 'get_schedule')).toBe(true);
    expect(index.includes('catalog', 'get_online_booking_settings')).toBe(true);
    expect(index.includes('catalog', 'get_resources')).toBe(true);
    expect(index.includes('catalog', 'get_appointments')).toBe(false);
  });

  it('serves the whole wizard on onboarding and nothing else', () => {
    const index = buildFacetIndex(tools);
    const members = index.members('onboarding');
    const wizard = members.filter((name) => name.startsWith('onboarding_'));
    expect(wizard).toHaveLength(12);
    expect(members).toHaveLength(wizard.length + FACET_BASE_TOOLS.length);
  });

  it('serves membership evidence on marketing', () => {
    const index = buildFacetIndex(tools);
    expect([...index.members('marketing')].sort()).toEqual(
      [...FACET_BASE_TOOLS, 'clients_get_membership_purchases'].sort()
    );
  });

  it('points an out-of-facet tool at the facets that serve it', () => {
    const index = buildFacetIndex(tools);
    expect(index.facetsProviding('get_staff')).toEqual(['catalog']);
    expect(index.facetsProviding('get_appointments')).toEqual(['ops']);
    expect(index.facetsProviding('list_locations')).toEqual([...FACET_NAMES]);
  });

  it('ignores facet rules for tools that do not exist', () => {
    // Simulate a build without the analytics pack: its rules must be inert.
    const withoutPack = tools.filter(
      (tool) => !tool.name.startsWith('analytics_')
    );
    const index = buildFacetIndex(withoutPack);
    expect(index.members('analytics')).toEqual([...FACET_BASE_TOOLS]);
    for (const extra of DEFAULT_FACET_EXTRA_TOOLS) {
      expect(index.includes(DEFAULT_FACET, extra)).toBe(false);
    }
  });

  it('keeps a facet list in the order the builder received', () => {
    const index = buildFacetIndex(tools);
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
      const index = buildFacetIndex(tools);
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
      const off = buildFacetIndex(tools);
      const on = buildFacetIndex(tools, { exposePasswordLogin: true });
      for (const name of PASSWORD_LOGIN_TOOLS) {
        expect(off.includes(ALL_TOOLS_FACET, name)).toBe(true);
        expect(on.includes(ALL_TOOLS_FACET, name)).toBe(true);
      }
      // The switch does not filter `all` at all.
      expect(on.members(ALL_TOOLS_FACET)).toEqual(off.members(ALL_TOOLS_FACET));
    });

    it('admits password login to every view when on — the closed staff deployment', () => {
      const index = buildFacetIndex(tools, { exposePasswordLogin: true });
      for (const name of PASSWORD_LOGIN_TOOLS) {
        expect(index.includes(DEFAULT_FACET, name)).toBe(true);
        for (const facet of FACET_NAMES) {
          expect(index.includes(facet, name)).toBe(true);
        }
        expect(index.facetsProviding(name)).toEqual([...FACET_NAMES]);
      }
    });

    it('changes nothing else about the views it filters', () => {
      const off = buildFacetIndex(tools);
      const on = buildFacetIndex(tools, { exposePasswordLogin: true });
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
      const index = buildFacetIndex(tools);
      expect(index.includes(DEFAULT_FACET, 'remove_location_user')).toBe(false);
    });

    it('keeps it reachable on the catalog facet and on stdio', () => {
      const index = buildFacetIndex(tools);
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
        const index = buildFacetIndex(tools, options);
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
        const first = buildFacetIndex(tools, options);
        const second = buildFacetIndex(tools, options);
        for (const key of first.keys) {
          expect(second.members(key)).toEqual(first.members(key));
        }
      }
    });
  });

  describe('the onboarding config switch', () => {
    it('removes the wizard from the default view only when on', () => {
      const off = buildFacetIndex(tools);
      const on = buildFacetIndex(tools, {
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
      // 33 defined, 6 withheld — see src/tools/disabled-tools.ts.
      expect(analyticsCount).toBe(27);
    });

    it('admits only the named entry points to the default view', () => {
      const index = buildFacetIndex(tools);
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
      const index = buildFacetIndex(tools);
      expect(index.members(ALL_TOOLS_FACET)).toEqual(names);
      // Which is strictly more than the default HTTP view holds back to.
      expect(index.members(DEFAULT_FACET)).not.toEqual(names);
      expect(
        index.includes(ALL_TOOLS_FACET, 'analytics_get_daily_series')
      ).toBe(true);
    });

    it('admits the whole pack to its own facet and to finance', () => {
      const index = buildFacetIndex(tools);
      expect(index.members('analytics')).toHaveLength(
        FACET_BASE_TOOLS.length + analyticsCount
      );
      expect(index.members('finance')).toHaveLength(
        FACET_BASE_TOOLS.length + analyticsCount + 1
      );
      expect(
        index.includes('finance', 'clients_get_membership_purchases')
      ).toBe(true);
      expect(index.includes('ops', 'analytics_get_overview')).toBe(false);
    });

    it('places the temporary legacy-report tools only on analytics surfaces', () => {
      const index = buildFacetIndex(tools);
      for (const name of [
        'analytics_get_client_sales',
        'analytics_get_client_retention',
        'analytics_get_client_forecast',
        'analytics_get_service_profitability',
        'analytics_get_team_member_sales',
        'analytics_get_team_member_capacity',
        'analytics_get_client_reactivation_candidates',
        'analytics_get_group_event_performance',
        'analytics_get_product_sales',
        'analytics_get_cash_flow_breakdown',
      ]) {
        expect(index.includes(DEFAULT_FACET, name)).toBe(false);
        expect(index.includes('analytics', name)).toBe(true);
        expect(index.includes('finance', name)).toBe(true);
        expect(index.includes(READONLY_VIEW, name)).toBe(true);
        expect(index.includes('ops', name)).toBe(false);
        expect(index.includes('catalog', name)).toBe(false);
      }
    });
  });
});

/**
 * The read-only view served on `/mcp/readonly`.
 *
 * Its membership is computed from each tool's own `readOnlyHint`, never from a
 * list kept here, so the tests below are written to fail on a *future* pack
 * too: they compare the view against the annotations of whatever is registered
 * at the time they run, and they check the computation itself with synthetic
 * tools that no pack has to exist for.
 */
describe('the read-only view', () => {
  const entries = orderedToolEntries();
  const names = allNames();
  const tools = allTools();
  const index = buildFacetIndex(tools);
  const members = index.members(READONLY_VIEW);
  const annotationSaysReadOnly = (name: string): boolean =>
    entries.find((entry) => entry.spec.name === name)?.spec.annotations
      ?.readOnlyHint === true;

  it('is a view, not a seventh facet', () => {
    // Facets ration context; this rations what an agent may do. Keeping them
    // separate is the point — see the module header.
    expect(isFacetName(READONLY_VIEW)).toBe(false);
    expect([...FACET_NAMES]).not.toContain(READONLY_VIEW);
    expect(index.keys).toContain(READONLY_VIEW);
    // And it is never offered as the answer to "where else can I call this?".
    for (const name of names) {
      expect([...index.facetsProviding(name)]).not.toContain(READONLY_VIEW);
    }
  });

  // THE regression test: if a new pack lands with a writing tool that this
  // view admits, this fails without anybody remembering to update a list.
  it('admits nothing that is not annotated readOnlyHint: true', () => {
    const leaked = members.filter((name) => !annotationSaysReadOnly(name));
    expect(leaked).toEqual([]);
  });

  it('admits every registered read-only tool', () => {
    const expected = names.filter(
      (name) =>
        annotationSaysReadOnly(name) &&
        !PASSWORD_LOGIN_TOOLS.includes(name) &&
        !DEFAULT_FACET_EXCLUDED_TOOLS.includes(name)
    );
    expect(members).toEqual(expected);
    expect(members.length).toBeGreaterThan(0);
    expect(members.length).toBeLessThan(names.length);
  });

  it('classifies a tool by its annotation and nothing else', () => {
    // A pack that does not exist yet: the view has to pick up its reading tools
    // and leave its writing ones out, with no entry added to this module.
    const future: FacetTool[] = [
      ...tools,
      { name: 'future_pack_get_thing', readOnly: true },
      { name: 'future_pack_create_thing', readOnly: false },
    ];
    const withFuture = buildFacetIndex(future).members(READONLY_VIEW);
    expect(withFuture).toContain('future_pack_get_thing');
    expect(withFuture).not.toContain('future_pack_create_thing');
  });

  it('treats a missing or malformed readOnlyHint as a write (fail closed)', () => {
    const projected = facetToolsFromSpecs([
      { name: 'no_annotations_at_all' },
      { name: 'empty_annotations', annotations: {} },
      { name: 'explicitly_false', annotations: { readOnlyHint: false } },
      {
        name: 'truthy_but_not_true',
        annotations: { readOnlyHint: 1 as never },
      },
      { name: 'properly_read_only', annotations: { readOnlyHint: true } },
    ]);
    expect(buildFacetIndex(projected).members(READONLY_VIEW)).toEqual([
      'properly_read_only',
    ]);
  });

  it('does not force-admit the base tools the way a facet does', () => {
    // list_locations is on this view because it reads, not because it is a
    // base tool. If it ever stopped reading it would have to drop out.
    expect(members).toContain('list_locations');
    const hypothetical = tools.map((tool) =>
      FACET_BASE_TOOLS.includes(tool.name) ? { ...tool, readOnly: false } : tool
    );
    const index2 = buildFacetIndex(hypothetical);
    for (const base of FACET_BASE_TOOLS) {
      expect(index2.includes(READONLY_VIEW, base)).toBe(false);
      // …while every facet still carries it, which is the difference.
      expect(index2.includes('ops', base)).toBe(true);
    }
  });

  it('serves the whole analytics pack, which the default view holds back', () => {
    // Chain-wide analytics is a named audience for this address, and every
    // analytics tool only reads.
    const analytics = names.filter((name) => name.startsWith('analytics_'));
    expect(analytics.length).toBeGreaterThan(1);
    for (const name of analytics) {
      expect(index.includes(READONLY_VIEW, name)).toBe(true);
    }
    expect(
      index.members(DEFAULT_FACET).filter((n) => analytics.includes(n)).length
    ).toBeLessThan(analytics.length);
  });

  it('carries no destructive tool and no password login', () => {
    for (const name of [
      'delete_staff',
      'delete_appointment',
      'clients_delete',
      'remove_location_user',
      'onboarding_rollback_phase',
      ...PASSWORD_LOGIN_TOOLS,
    ]) {
      expect(index.includes(READONLY_VIEW, name)).toBe(false);
    }
    // Even with the closed-deployment switch on, login is not a read.
    const withLogin = buildFacetIndex(tools, { exposePasswordLogin: true });
    for (const name of PASSWORD_LOGIN_TOOLS) {
      expect(withLogin.includes(READONLY_VIEW, name)).toBe(false);
    }
  });

  it('serves the read-only executor, which refuses writes itself', () => {
    expect(index.includes(READONLY_VIEW, 'altegio_search_operations')).toBe(
      true
    );
    expect(index.includes(READONLY_VIEW, 'altegio_call_operation')).toBe(true);
  });

  it('is deterministic and keeps the registry order (ADR-001 D7)', () => {
    expect(buildFacetIndex(tools).members(READONLY_VIEW)).toEqual(members);
    expect(members).toEqual(names.filter((name) => members.includes(name)));
  });

  it('is unaffected by the switches that shape the default view', () => {
    for (const options of [
      { exposePasswordLogin: true },
      { excludeOnboardingFromDefault: true },
    ]) {
      expect(buildFacetIndex(tools, options).members(READONLY_VIEW)).toEqual(
        members
      );
    }
  });

  describe('the refusal a writing tool gets here', () => {
    const base = 'https://mcp.alteg.io/pro';
    const message = readOnlyRefusalMessage('delete_staff', base);

    it('names the tool and the full address of the complete surface', () => {
      expect(message).toContain('delete_staff');
      expect(message).toContain(viewUrl(base, READONLY_VIEW));
      expect(message).toContain(viewUrl(base, DEFAULT_FACET));
      expect(viewUrl(base, READONLY_VIEW)).toBe(
        'https://mcp.alteg.io/pro/readonly'
      );
      expect(viewUrl(base, DEFAULT_FACET)).toBe('https://mcp.alteg.io/pro');
    });

    it('keeps a /mcp segment the base already carries (internal lane)', () => {
      const internal = 'https://mcp.altegio.dev/pro/mcp';
      expect(viewUrl(internal, READONLY_VIEW)).toBe(
        'https://mcp.altegio.dev/pro/mcp/readonly'
      );
      expect(viewUrl(internal, DEFAULT_FACET)).toBe(internal);
    });

    it('tolerates a base URL with a trailing slash', () => {
      expect(viewUrl('https://example.test/pro/', DEFAULT_FACET)).toBe(
        'https://example.test/pro'
      );
    });

    it('tells the model to report rather than retry or seek elevation', () => {
      // Hosts do not re-authorize on a refusal (Claude Code closed that as
      // "not planned"), so the message must not imply a step-up exists.
      expect(message).toMatch(/no confirmation, no wider scope and no retry/i);
      expect(message).toMatch(/tell the user/i);
      expect(message).toMatch(/separate MCP server/i);
    });
  });
});
