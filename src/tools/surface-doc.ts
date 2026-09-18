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
  type FacetIndexOptions,
  type FacetKey,
} from './facets.js';
import { allToolEntries, type ToolInventoryEntry } from './inventory.js';
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
  // withheld
  'password-login-not-exposed': '-pwd',
  'default-view-excluded-tool': '-name',
  'default-view-excluded-prefix': '-pack',
  'onboarding-excluded-from-default': '-onb',
  'not-in-facet-rule': '-',
  'not-read-only': '-write',
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
    're-admitted to `/mcp` despite an excluded prefix',
    '`DEFAULT_FACET_EXTRA_TOOLS`',
  ],
  [
    'default-view-not-excluded',
    'on `/mcp` because nothing excludes it',
    '(the default)',
  ],
  [
    'read-only-annotation',
    'declares `readOnlyHint: true`',
    'the tool’s own annotations',
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
    'a whole pack held back from `/mcp`’s tool budget',
    '`DEFAULT_FACET_EXCLUDED_PREFIXES`',
  ],
  [
    'onboarding-excluded-from-default',
    'the onboarding config switch is on',
    '`MCP_DEFAULT_FACET_EXCLUDE_ONBOARDING`',
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

  const out: string[] = [];

  out.push('# Tool surface — which tool is served where, and why');
  out.push('');
  out.push(
    '<!-- GENERATED by `npm run surface:build` from `src/tools/surface.ts`. Do not edit by hand. -->'
  );
  out.push('');
  out.push(
    'Six mechanisms decide where a tool appears and two more decide whether the'
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
          'what `stdio` lists; every HTTP view is a subset',
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
      ['View', 'Address', `Serves (of ${counts.defined} defined)`, 'Reasons'],
      views.map((view) => [
        `\`${view}\``,
        viewAddress(view),
        String(surface.servedOn(view).length),
        reasonBreakdown(surface.forView(view)),
      ])
    )
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

  // ---- legend ------------------------------------------------------------
  out.push('## Legend');
  out.push('');
  out.push(
    table(
      ['Code', 'Served?', 'Meaning', 'Declared in'],
      REASON_LEGEND.map(([reason, meaning, where]) => [
        `\`${REASON_CODES[reason]}\``,
        REASON_CODES[reason].startsWith('-') ? 'no' : 'yes',
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
    'The table above describes the default configuration: password login off,'
  );
  out.push('onboarding on `/mcp`. Two environment switches change it.');
  out.push('');
  out.push(
    '`ALTEGIO_EXPOSE_PASSWORD_LOGIN=true` (the closed staff deployment):'
  );
  out.push('');
  out.push(...switchDelta(entries, { exposePasswordLogin: true }));
  out.push('');
  out.push('`MCP_DEFAULT_FACET_EXCLUDE_ONBOARDING=true`:');
  out.push('');
  out.push(...switchDelta(entries, { excludeOnboardingFromDefault: true }));
  out.push('');

  return `${out.join('\n')}\n`;
}
