/**
 * The surface table is the one place that answers "why is tool X on address
 * Y". These tests keep that promise honest in both directions:
 *
 *  - it must never become a *second* implementation of membership — every cell
 *    agrees with the `buildFacetIndex` the server actually serves;
 *  - it must cover the whole surface — every defined tool, disabled ones
 *    included, has a cell on every view with a reason from the closed set.
 *
 * The snapshot that a reviewer reads is the generated
 * `docs/architecture/tool-surface.md`, pinned by `./surface-doc.test.ts`.
 */
import { describe, it, expect } from '@jest/globals';
import {
  buildFacetIndex,
  DEFAULT_FACET,
  FACET_NAMES,
  PASSWORD_LOGIN_TOOLS,
  READONLY_VIEW,
  VIEW_KEYS,
  type FacetIndexOptions,
} from '../facets.js';
import { DISABLED_TOOL_NAMES } from '../disabled-tools.js';
import { allToolEntries } from '../inventory.js';
import { requiredScopesFor } from '../scopes.js';
import {
  buildSurfaceTable,
  toolCounts,
  toolCountSentence,
} from '../surface.js';

const entries = allToolEntries();
const CONFIGURATIONS: readonly FacetIndexOptions[] = [
  {},
  { exposePasswordLogin: true },
  { excludeOnboardingFromDefault: true },
  { exposePasswordLogin: true, excludeOnboardingFromDefault: true },
];

describe('the surface table', () => {
  it('covers every defined tool on every view, exactly once', () => {
    const surface = buildSurfaceTable(entries);
    expect(surface.tools).toHaveLength(entries.length);
    expect(surface.cells).toHaveLength(entries.length * VIEW_KEYS.length);
    for (const entry of entries) {
      const row = surface.forTool(entry.name);
      expect(row.map((cell) => cell.view)).toEqual([...VIEW_KEYS]);
    }
  });

  // THE anti-drift test: the table explains the surface, it does not define a
  // second one. If `decideView` and `buildFacetIndex` ever part ways, the
  // documentation would start describing a server nobody runs.
  it.each(CONFIGURATIONS)(
    'agrees with the served tool lists for %j',
    (options) => {
      const surface = buildSurfaceTable(entries, options);
      // buildFacetIndex only ever sees the tools the registry registered.
      const registered = entries.filter((entry) => !entry.disabled);
      const index = buildFacetIndex(registered, options);
      for (const view of VIEW_KEYS) {
        expect(surface.servedOn(view)).toEqual(index.members(view));
      }
    }
  );

  it('keeps `tools/list` order in every column', () => {
    const surface = buildSurfaceTable(entries);
    const order = entries.map((entry) => entry.name);
    for (const view of VIEW_KEYS) {
      const served = surface.servedOn(view);
      expect(served).toEqual(order.filter((name) => served.includes(name)));
    }
  });

  it('is deterministic', () => {
    const first = buildSurfaceTable(entries);
    const second = buildSurfaceTable(entries);
    expect(second.cells).toEqual(first.cells);
  });
});

describe('the reasons', () => {
  const surface = buildSurfaceTable(entries);

  it('gives a disabled tool one reason on every view, and no other tool that reason', () => {
    for (const cell of surface.cells) {
      const disabled = DISABLED_TOOL_NAMES.has(cell.tool);
      expect(cell.reason === 'disabled-everywhere').toBe(disabled);
      if (disabled) {
        expect(cell.served).toBe(false);
        // Not registered at all, so `tools/call` answers "Unknown tool".
        expect(cell.gates).toEqual([
          { kind: 'not-served', refusal: 'unknown-tool' },
        ]);
      }
    }
  });

  it('names the mechanism that withheld each tool from `/mcp`', () => {
    const reasonOn = (name: string) =>
      surface.cell(name, DEFAULT_FACET)?.reason;
    expect(reasonOn('remove_location_user')).toBe('default-view-excluded-tool');
    expect(reasonOn('analytics_get_daily_series')).toBe(
      'default-view-excluded-prefix'
    );
    expect(reasonOn('analytics_get_overview')).toBe('default-view-extra-tool');
    expect(reasonOn('altegio_login')).toBe('password-login-not-exposed');
    expect(reasonOn('list_locations')).toBe('facet-base-tool');
    expect(reasonOn('get_staff')).toBe('default-view-not-excluded');
    expect(reasonOn('analytics_run_report')).toBe('disabled-everywhere');
  });

  it('names the mechanism that admitted each tool to a facet', () => {
    expect(surface.cell('get_staff', 'catalog')?.reason).toBe(
      'facet-rule-name'
    );
    expect(surface.cell('clients_search', 'ops')?.reason).toBe(
      'facet-rule-prefix'
    );
    expect(surface.cell('list_locations', 'marketing')?.reason).toBe(
      'facet-base-tool'
    );
    expect(surface.cell('get_staff', 'ops')?.reason).toBe('not-in-facet-rule');
  });

  it('answers the read-only view with the tool’s own annotation', () => {
    for (const entry of entries) {
      if (entry.disabled) continue;
      const cell = surface.cell(entry.name, READONLY_VIEW)!;
      if (PASSWORD_LOGIN_TOOLS.includes(entry.name)) continue;
      expect(cell.served).toBe(entry.readOnly);
      expect(cell.reason).toBe(
        entry.readOnly ? 'read-only-annotation' : 'not-read-only'
      );
    }
  });

  it('shows the onboarding switch as its own reason, not as a pack exclusion', () => {
    const withSwitch = buildSurfaceTable(entries, {
      excludeOnboardingFromDefault: true,
    });
    expect(withSwitch.cell('onboarding_start', DEFAULT_FACET)?.reason).toBe(
      'onboarding-excluded-from-default'
    );
    expect(surface.cell('onboarding_start', DEFAULT_FACET)?.reason).toBe(
      'default-view-not-excluded'
    );
  });

  it('shows the password-login switch flipping the reason, not just the status', () => {
    const exposed = buildSurfaceTable(entries, { exposePasswordLogin: true });
    for (const name of PASSWORD_LOGIN_TOOLS) {
      expect(exposed.cell(name, DEFAULT_FACET)?.reason).toBe(
        'password-login-exposed'
      );
      for (const facet of FACET_NAMES) {
        expect(exposed.cell(name, facet)?.reason).toBe(
          'password-login-exposed'
        );
      }
      // …and it never reaches the read-only view, because it is not a read.
      expect(exposed.cell(name, READONLY_VIEW)?.reason).toBe('not-read-only');
      // stdio is not filtered by the switch either way.
      expect(exposed.cell(name, 'all')?.served).toBe(true);
      expect(surface.cell(name, 'all')?.served).toBe(true);
    }
  });
});

describe('the gates', () => {
  const surface = buildSurfaceTable(entries);

  it('states the refusal a caller reads wherever a tool is withheld', () => {
    for (const cell of surface.cells) {
      if (cell.served) continue;
      const gate = cell.gates[0];
      expect(gate).toEqual({
        kind: 'not-served',
        refusal: DISABLED_TOOL_NAMES.has(cell.tool)
          ? 'unknown-tool'
          : cell.view === READONLY_VIEW
            ? 'read-only-view-refusal'
            : 'out-of-view',
      });
    }
  });

  it('carries the same scope requirement the `tools/call` handler enforces', () => {
    for (const entry of entries) {
      // A disabled tool has no execution path, so it carries no scope gate.
      if (entry.disabled) continue;
      const gates = surface.cell(entry.name, 'all')!.gates;
      const scopes = gates.flatMap((gate) =>
        gate.kind === 'scope' ? [...gate.scopes] : []
      );
      expect(scopes).toEqual([...requiredScopesFor(entry.name)]);
    }
  });

  it('flags a human confirmation on every destructive tool and nowhere else', () => {
    for (const entry of entries) {
      if (entry.disabled) continue;
      const confirms = surface
        .cell(entry.name, 'all')!
        .gates.some((gate) => gate.kind === 'human-confirmation');
      expect(confirms).toBe(entry.requiresConfirmation);
      // `destructive-coverage.test.ts` owns the other direction in full; this
      // keeps the table from claiming a gate a destructive tool does not have.
      if (entry.destructive) expect(confirms).toBe(true);
    }
  });

  it('flags the executor’s own read-only policy (ADR-001 D2)', () => {
    const readsOnly = (name: string) =>
      surface
        .cell(name, 'all')!
        .gates.some((gate) => gate.kind === 'executor-read-only');
    expect(readsOnly('altegio_call_operation')).toBe(true);
    expect(readsOnly('altegio_describe_operation')).toBe(false);
    expect(readsOnly('get_staff')).toBe(false);
  });

  it('lists gates in the order the call path checks them', () => {
    const order = ['scope', 'human-confirmation', 'executor-read-only'];
    for (const cell of surface.cells) {
      if (!cell.served) continue;
      const kinds = cell.gates.map((gate) => gate.kind);
      expect(kinds).toEqual(
        [...kinds].sort((a, b) => order.indexOf(a) - order.indexOf(b))
      );
    }
  });
});

describe('tool counts', () => {
  const counts = toolCounts(entries);

  it('adds up', () => {
    expect(counts.defined).toBe(counts.served + counts.disabled);
    expect(counts.defined).toBe(
      counts.factoryDefined + counts.onboardingDefined
    );
    expect(counts.disabled).toBe(DISABLED_TOOL_NAMES.size);
    expect([...counts.byCategory.values()].reduce((a, b) => a + b, 0)).toBe(
      counts.served
    );
  });

  it('counts what the unfiltered view serves', () => {
    expect(buildSurfaceTable(entries).servedOn('all')).toHaveLength(
      counts.served
    );
  });

  it('states itself in one sentence the documents can quote verbatim', () => {
    expect(toolCountSentence(counts)).toBe(
      `${counts.served} tools served (${counts.defined} defined, ${counts.disabled} withheld from every view)`
    );
  });
});
