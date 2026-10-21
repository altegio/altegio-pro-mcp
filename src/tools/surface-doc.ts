/**
 * Render the surface table (`./surface.ts`) as the committed reference
 * document `docs/architecture/tool-surface.md`.
 *
 * The document is generated, never hand-written: `npm run surface:build`
 * writes it and `__tests__/surface-doc.test.ts` fails the build when the
 * committed copy differs from what the code produces. That is the same
 * contract `src/generated/catalog.json` has (ADR-001 D4) and for the same
 * reason — a surface change has to be visible in a reviewer's diff, and a
 * hand-maintained table describing seventy tools is wrong within a month.
 */
import {
  ALL_TOOLS_FACET,
  DEFAULT_FACET,
  DEFAULT_FACET_DEMOTED_GROUPS,
  demotedGroupOf,
  type FacetIndexOptions,
  type FacetKey,
} from './facets.js';
import { allToolEntries, type ToolInventoryEntry } from './inventory.js';
import {
  DEFAULT_VIEW_TARGET_BYTES,
  viewSizes,
  type ViewSize,
} from './listing-budget.js';
import {
  buildSurfaceTable,
  toolCounts,
  toolCountSentence,
  type SurfaceCell,
  type SurfaceGate,
  type SurfaceReason,
} from './surface.js';

/** Path of the generated document, relative to the repository root. */
export const SURFACE_DOC_PATH = 'docs/architecture/tool-surface.md';

/**
 * Where each view is reached. `all` has no HTTP route on purpose: it is the
 * unfiltered surface stdio serves to a desktop host (see `src/index.ts`).
 */
function viewAddress(view: FacetKey): string {
  if (view === ALL_TOOLS_FACET) return 'stdio (no HTTP route)';
  if (view === DEFAULT_FACET) return '`/mcp`';
  return `\`/mcp/${view}\``;
}

/** Column header for a view: short, so the matrix stays readable. */
function viewLabel(view: FacetKey): string {
  if (view === ALL_TOOLS_FACET) return 'stdio';
  if (view === DEFAULT_FACET) return '/mcp';
  return `/${view}`;
}

/**
 * The compact cell code for one reason. Served codes are words, withheld codes
 * start with `-`, so a column reads at a glance as "mostly on" or "mostly off".
 */
const REASON_CODES: Readonly<Record<SurfaceReason, string>> = {
  // served
  'unfiltered-view': 'all',
  'facet-base-tool': 'base',
  'password-login-exposed': 'pwd!',
  'facet-rule-name': 'rule',
  'facet-rule-prefix': 'pfx',
  'default-view-extra-tool': 'xtra',
  'default-view-not-excluded': 'dflt',
  'read-only-annotation': 'ro',
  'compact-view-listed': 'list',
  // not listed, run through the dispatcher
  'compact-view-dispatched': 'disp',
  // withheld
  'password-login-not-exposed': '-pwd',
  'default-view-excluded-tool': '-name',
  'default-view-excluded-prefix': '-pack',
  'default-view-demoted': '-low',
  'not-in-facet-rule': '-',
  'not-read-only': '-write',
  'dispatcher-compact-only': '-cmp',
  'disabled-everywhere': '-off',
};

/** What each code means, and which declaration produced it. */
const REASON_LEGEND: readonly (readonly [SurfaceReason, string, string])[] = [
  [
    'unfiltered-view',
    'the unfiltered view is never filtered',
    '`ALL_TOOLS_FACET`',
  ],
  [
    'facet-base-tool',
    'every facet carries it unconditionally',
    '`FACET_BASE_TOOLS`',
  ],
  [
    'password-login-exposed',
    'admitted by the deployment switch',
    '`PASSWORD_LOGIN_TOOLS` + `ALTEGIO_EXPOSE_PASSWORD_LOGIN`',
  ],
  [
    'facet-rule-name',
    'named one by one in this facet',
    '`FACET_RULES[<facet>].tools`',
  ],
  [
    'facet-rule-prefix',
    'matched by this facet’s prefix',
    '`FACET_RULES[<facet>].prefixes`',
  ],
  [
    'default-view-extra-tool',
    're-admitted to the full list despite an excluded prefix',
    '`DEFAULT_FACET_EXTRA_TOOLS`',
  ],
  [
    'default-view-not-excluded',
    'on the full list because nothing excludes it',
    '(the default)',
  ],
  [
    'read-only-annotation',
    'declares `readOnlyHint: true`',
    'the tool’s own annotations',
  ],
  [
    'compact-view-listed',
    'on the compact listing: the most used tools and the dispatcher',
    '`COMPACT_VIEW_TOOLS`, `DISPATCH_TOOLS`',
  ],
  [
    'compact-view-dispatched',
    'not on the compact listing; `tools_search` finds it, `tools_call_read`, `tools_call_write` or `tools_call_destructive` runs it',
    '`dispatchReaches`',
  ],
  [
    'password-login-not-exposed',
    'a password prompt under an OAuth endpoint',
    '`PASSWORD_LOGIN_TOOLS` + `ALTEGIO_EXPOSE_PASSWORD_LOGIN`',
  ],
  [
    'default-view-excluded-tool',
    'a dangerous right `/mcp` does not hand a generic agent',
    '`DEFAULT_FACET_EXCLUDED_TOOLS`',
  ],
  [
    'default-view-excluded-prefix',
    'a whole pack held back from the full list’s byte budget',
    '`DEFAULT_FACET_EXCLUDED_PREFIXES`',
  ],
  [
    'default-view-demoted',
    'a low-use group served on its facet only',
    '`DEFAULT_FACET_DEMOTED_GROUPS`',
  ],
  [
    'not-in-facet-rule',
    'this facet’s rule does not name it',
    '`FACET_RULES[<facet>]`',
  ],
  [
    'not-read-only',
    'it changes data, so the read-only address will not serve it',
    'the tool’s own annotations',
  ],
  [
    'dispatcher-compact-only',
    'the dispatcher is listed on the compact listing only',
    '`DISPATCH_TOOLS`',
  ],
  [
    'disabled-everywhere',
    'withheld from every view, stdio included',
    '`DISABLED_TOOL_NAMES`',
  ],
];

/** The gates column: what still refuses the call where the tool IS served. */
function gateCodes(gates: readonly SurfaceGate[]): string {
  const codes = gates.flatMap((gate) => {
    switch (gate.kind) {
      case 'scope':
        return [gate.scopes.join(' + ')];
      case 'human-confirmation':
        return ['confirm'];
      case 'executor-read-only':
        return ['reads-only'];
      case 'not-served':
        return [];
    }
  });
  return codes.length > 0 ? codes.join(', ') : '—';
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function row(cells: readonly string[]): string {
  return `| ${cells.join(' | ')} |`;
}

function table(
  headers: readonly string[],
  rows: readonly (readonly string[])[]
): string {
  return [
    row(headers),
    row(headers.map(() => '---')),
    ...rows.map((cells) => row(cells.map(escapeCell))),
  ].join('\n');
}

/** Which deployment switch moves which tools, rendered as a delta. */
function switchDelta(
  entries: readonly ToolInventoryEntry[],
  options: FacetIndexOptions
): string[] {
  const base = buildSurfaceTable(entries);
  const changed = buildSurfaceTable(entries, options);
  const lines: string[] = [];
  for (const view of base.views) {
    const before = new Set(base.servedOn(view));
    const after = new Set(changed.servedOn(view));
    const added = [...after].filter((name) => !before.has(name));
    const removed = [...before].filter((name) => !after.has(name));
    if (added.length === 0 && removed.length === 0) continue;
    const parts = [
      ...added.map((name) => `+\`${name}\``),
      ...removed.map((name) => `−\`${name}\``),
    ];
    lines.push(`- ${viewAddress(view)} — ${parts.join(', ')}`);
  }
  return lines.length > 0 ? lines : ['- nothing moves'];
}

/** How many tools a switch adds to and removes from `/mcp`, in one clause. */
function switchSummary(
  entries: readonly ToolInventoryEntry[],
  options: FacetIndexOptions
): string {
  const before = new Set(buildSurfaceTable(entries).servedOn(DEFAULT_FACET));
  const after = new Set(
    buildSurfaceTable(entries, options).servedOn(DEFAULT_FACET)
  );
  const added = [...after].filter((name) => !before.has(name)).length;
  const removed = [...before].filter((name) => !after.has(name)).length;
  return `${added} more tools listed, ${removed} fewer`;
}

/** `147705` → `147,705`, without the host's locale. */
function groupDigits(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** The size cell: bytes, and the share of the budget when there is one. */
function sizeCell(size: ViewSize | undefined): string {
  return size ? groupDigits(size.bytes) : '—';
}

function budgetCell(size: ViewSize | undefined): string {
  if (size?.budget === undefined) return '—';
  const used = Math.round((size.bytes / size.budget) * 100);
  return `${groupDigits(size.budget)} (${used} %)`;
}

function reasonBreakdown(cells: readonly SurfaceCell[]): string {
  const counts = new Map<SurfaceReason, number>();
  for (const cell of cells) {
    counts.set(cell.reason, (counts.get(cell.reason) ?? 0) + 1);
  }
  return (
    [...counts]
      .sort((a, b) => (b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] < b[0] ? -1 : 1))
      .map(([reason, count]) => `${REASON_CODES[reason]} ×${count}`)
      .join(', ') || '—'
  );
}

/**
 * Render the whole document. Deterministic: the tool order is `tools/list`
 * order, the view order is `VIEW_KEYS`, and nothing is timestamped — a
 * regenerated file differs only when the surface actually changed.
 */
export function renderSurfaceDoc(
  entries: readonly ToolInventoryEntry[] = allToolEntries()
): string {
  const surface = buildSurfaceTable(entries);
  const counts = toolCounts(entries);
  const views = surface.views;
  const sizes = viewSizes(entries.filter((entry) => !entry.disabled));
  const sizeOf = (view: FacetKey) => sizes.find((size) => size.view === view);

  const out: string[] = [];

  out.push('# Tool surface — which tool is served where, and why');
  out.push('');
  out.push(
    '<!-- GENERATED by `npm run surface:build` from `src/tools/surface.ts`. Do not edit by hand. -->'
  );
  out.push('');
  out.push(
    'Several mechanisms decide where a tool appears and two more decide whether the'
  );
  out.push(
    'call it receives there runs. Each is justified on its own terms and none is'
  );
  out.push(
    'collapsed into the others; this table is the single place that *joins* them,'
  );
  out.push(
    'so "why is tool X not on address Y" has one answer instead of six lists to'
  );
  out.push('hold in your head.');
  out.push('');
  out.push(
    'It is computed from the running configuration — the same `decideView` that'
  );
  out.push(
    'builds every `tools/list` — and regenerated by `npm run surface:build`.'
  );
  out.push(
    '`src/tools/__tests__/surface-doc.test.ts` fails the build if this file and'
  );
  out.push(
    'the code disagree, which is how a surface change reaches a reviewer’s diff'
  );
  out.push('(ADR-001 D4, D7).');
  out.push('');

  // ---- counts ------------------------------------------------------------
  out.push('## Counts');
  out.push('');
  out.push(`**${toolCountSentence(counts)}.**`);
  out.push('');
  out.push(
    table(
      ['What', 'Count', 'Where'],
      [
        [
          'Defined',
          String(counts.defined),
          `${counts.factoryDefined} in \`src/tools/definitions/*.tools.ts\` + ${counts.onboardingDefined} in \`src/tools/onboarding-registry.ts\``,
        ],
        [
          'Withheld from every view',
          String(counts.disabled),
          '`src/tools/disabled-tools.ts` (the report builder)',
        ],
        [
          '**Served**',
          `**${counts.served}**`,
          'what some view serves; `stdio` lists all of it but the dispatcher, which only the compact listing lists',
        ],
      ]
    )
  );
  out.push('');
  out.push('Served tools per category, in `tools/list` order:');
  out.push('');
  out.push(
    table(
      ['Category', 'Served'],
      [...counts.byCategory].map(([category, count]) => [
        category,
        String(count),
      ])
    )
  );
  out.push('');

  // ---- views -------------------------------------------------------------
  out.push('## Views');
  out.push('');
  out.push(
    table(
      [
        'View',
        'Address',
        `Lists (of ${counts.defined} defined)`,
        'Reaches',
        '`tools/list` bytes',
        'Budget (used)',
        'Reasons',
      ],
      views.map((view) => [
        `\`${view}\``,
        viewAddress(view),
        String(surface.servedOn(view).length),
        String(
          surface
            .forView(view)
            .filter(
              (cell) => cell.served || cell.reason === 'compact-view-dispatched'
            ).length
        ),
        sizeCell(sizeOf(view)),
        budgetCell(sizeOf(view)),
        reasonBreakdown(surface.forView(view)),
      ])
    )
  );
  out.push('');
  out.push(
    '`tools/list` bytes is the serialized result the view sends in the default'
  );
  out.push(
    'deployment — what a host that loads the whole list pays on every connection,'
  );
  out.push(
    'roughly 4 bytes per token. The budgets are in `src/tools/listing-budget.ts`;'
  );
  out.push(
    `the tests and \`npm run surface:check\` fail above them. \`/mcp\` stays under`
  );
  out.push(`${groupDigits(DEFAULT_VIEW_TARGET_BYTES)} bytes (ADR-001 D3).`);
  out.push('');
  out.push(
    '`/mcp` serves the compact listing by default: the `/mcp` column equals the'
  );
  out.push(
    '`/compact` column. `/full` is the flat list `/mcp` served before, for gateways'
  );
  out.push(
    'that want every tool up front; `MCP_DEFAULT_VIEW=full` makes `/mcp` serve it.'
  );
  out.push('');
  out.push(
    'A facet answers *how many tools fit in this host’s context*; `readonly`'
  );
  out.push(
    'answers *what may this agent do at all*. They are different kinds of view —'
  );
  out.push('`readonly` is not a seventh facet (ADR-001 D3 addendum).');
  out.push('');

  // ---- demoted groups ----------------------------------------------------
  out.push('## Demoted from the full list');
  out.push('');
  out.push(
    'Low-use groups served on their facet only (`-low` in the `/full` column); the'
  );
  out.push(
    'compact listing reaches them through its dispatcher. The full list’s'
  );
  out.push('`initialize` instructions name each group and its address.');
  out.push('');
  out.push(
    table(
      ['Group', 'Served on', 'Tools'],
      DEFAULT_FACET_DEMOTED_GROUPS.map((group) => [
        group.summary,
        viewAddress(group.facet),
        entries
          .filter((entry) => demotedGroupOf(entry.name) === group)
          .map((entry) => `\`${entry.name}\``)
          .join(', '),
      ])
    )
  );
  out.push('');

  // ---- legend ------------------------------------------------------------
  out.push('## Legend');
  out.push('');
  out.push(
    table(
      ['Code', 'Served?', 'Meaning', 'Declared in'],
      REASON_LEGEND.map(([reason, meaning, where]) => [
        `\`${REASON_CODES[reason]}\``,
        REASON_CODES[reason].startsWith('-')
          ? 'no'
          : reason === 'compact-view-dispatched'
            ? 'through the dispatcher'
            : 'yes',
        meaning,
        where,
      ])
    )
  );
  out.push('');
  out.push(
    '**A withheld tool is refused, not merely hidden.** What the caller'
  );
  out.push('reads depends on why:');
  out.push('');
  out.push(
    '- `-off` — the tool is not registered at all, so the call answers `Unknown tool`.'
  );
  out.push(
    '- any code in the `/readonly` column — the read-only policy message, which names'
  );
  out.push(
    '  the full address of the complete surface and tells the model to report rather'
  );
  out.push('  than retry.');
  out.push(
    '- `disp` in the `/mcp` and `/compact` columns — not refused: the dispatcher of'
  );
  out.push('  its risk tier runs it (`tools_call_read`, `tools_call_write`,');
  out.push('  `tools_call_destructive`), and so does a direct call by name.');
  out.push(
    '- every other column — the out-of-view error, naming the paths that do serve it'
  );
  out.push('  (or saying the deployment serves it nowhere).');
  out.push('');
  out.push(
    'The **Gates** column applies wherever the tool is served: these refuse the call'
  );
  out.push(
    'after it is accepted, in the order `src/tools/registry.ts` checks them.'
  );
  out.push('');
  out.push(
    '- a scope name — the caller’s token must carry it (`src/tools/scopes.ts`). A'
  );
  out.push(
    '  caller that declares no scopes, which is every deployment today, passes.'
  );
  out.push(
    '- `confirm` — a human approves it first, by elicitation or a one-time token bound'
  );
  out.push('  to the exact arguments (`src/tools/confirmation.ts`).');
  out.push(
    '- `reads-only` — the handler itself performs documented GETs only and refuses any'
  );
  out.push('  other method (ADR-001 D2).');
  out.push('');

  // ---- the matrix --------------------------------------------------------
  out.push('## The table');
  out.push('');
  const byCategory = new Map<string, ToolInventoryEntry[]>();
  for (const entry of entries) {
    byCategory.set(entry.category, [
      ...(byCategory.get(entry.category) ?? []),
      entry,
    ]);
  }
  for (const [category, tools] of byCategory) {
    out.push(`### ${category}`);
    out.push('');
    out.push(
      table(
        ['Tool', ...views.map(viewLabel), 'Gates'],
        tools.map((entry) => [
          `\`${entry.name}\``,
          ...views.map((view) => {
            const cell = surface.cell(entry.name, view)!;
            return `\`${REASON_CODES[cell.reason]}\``;
          }),
          gateCodes(surface.cell(entry.name, views[0]!)!.gates),
        ])
      )
    );
    out.push('');
  }

  // ---- switches ----------------------------------------------------------
  out.push('## Deployment switches');
  out.push('');
  out.push(
    'The table above describes the default configuration: password login off, the'
  );
  out.push('compact listing on `/mcp`. Two environment switches change it.');
  out.push('');
  out.push(
    '`ALTEGIO_EXPOSE_PASSWORD_LOGIN=true` (the closed staff deployment):'
  );
  out.push('');
  out.push(...switchDelta(entries, { exposePasswordLogin: true }));
  out.push('');
  out.push(
    '`MCP_DEFAULT_VIEW=full` (a deployment that turns `/mcp` back): `/mcp` serves'
  );
  out.push(
    'what the `/full` column shows, without the dispatcher, and refuses the rest'
  );
  out.push(
    `with the addresses that serve it — ${switchSummary(entries, { defaultListing: 'full' })}.`
  );
  out.push('');

  return `${out.join('\n')}\n`;
}
