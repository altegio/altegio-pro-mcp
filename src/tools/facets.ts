/**
 * Static facets — ADR-001 D3.
 *
 * A facet is a fixed, filtered view of the one tool surface, served on its own
 * HTTP sub-path (`/mcp/<facet>`). Facets exist for hosts that cap the number of
 * active tools and cannot defer them; they are not product boundaries, carry no
 * separate audience or credential, and never change the behavior of a tool.
 *
 * Membership is declarative: explicit tool names plus tool-name prefixes, so a
 * whole pack joins a facet with one entry. The index is computed once at
 * startup from the registered tool names, which keeps `tools/list` identical
 * for every connection to a given path — the "no per-connection variance" rule
 * of MCP 2026-07-28 (ADR-001 D7) — and keeps the result reviewable in a diff.
 *
 * Legacy tool names (`get_staff`, `create_staff`, …) are listed verbatim
 * because they are the names on the wire today; the canonical vocabulary calls
 * these team member tools and the rename is tracked separately.
 */

/** Every facet served on `/mcp/<facet>`. */
export const FACET_NAMES = [
  'ops',
  'catalog',
  'finance',
  'marketing',
  'analytics',
  'onboarding',
] as const;

export type FacetName = (typeof FACET_NAMES)[number];

/** Key of the default view served on `/mcp`. */
export const DEFAULT_FACET = 'default';

/**
 * Key of the unfiltered view: every registered tool, no exclusions. stdio uses
 * it — a desktop host connects to one process and must see the whole surface,
 * including packs the default HTTP view holds back. It has no HTTP route.
 */
export const ALL_TOOLS_FACET = 'all';

export type FacetKey =
  FacetName | typeof DEFAULT_FACET | typeof ALL_TOOLS_FACET;

export function isFacetName(value: string): value is FacetName {
  return (FACET_NAMES as readonly string[]).includes(value);
}

/**
 * Tools every facet carries: authentication and location discovery. Without
 * them a narrow facet is unusable — no tool works before `altegio_login`, and
 * nearly every tool needs a `location_id`.
 */
export const FACET_BASE_TOOLS: readonly string[] = [
  'altegio_login',
  'altegio_logout',
  'list_locations',
];

interface FacetRule {
  /** Tools named one by one. */
  readonly tools: readonly string[];
  /** Tool-name prefixes; one entry admits a whole pack. */
  readonly prefixes: readonly string[];
}

/**
 * Facet membership. Names that no registered tool provides are ignored, so a
 * rule may describe a pack before it lands.
 */
const FACET_RULES: Record<FacetName, FacetRule> = {
  /**
   * Daily work: the digital schedule, appointments, clients.
   * Intended membership (ADR-001 D3) also covers the `clients_*` pack and the
   * journal tools; neither exists yet.
   */
  ops: {
    tools: [
      'get_appointments',
      'create_appointment',
      'update_appointment',
      'delete_appointment',
    ],
    prefixes: [],
  },

  /**
   * What the location offers and who delivers it: services, team members,
   * positions, work schedules, resources, location settings.
   */
  catalog: {
    tools: [
      'get_services',
      'create_service',
      'update_service',
      'get_service_categories',
      'get_staff',
      'create_staff',
      'update_staff',
      'delete_staff',
      'get_positions',
      'create_position',
      'update_position',
      'delete_position',
      'get_schedule',
      'create_schedule',
      'update_schedule',
      'delete_schedule',
      'get_appointment_settings',
      'update_appointment_settings',
      'get_online_booking_settings',
      'update_online_booking_settings',
      'get_booking_forms',
      'create_booking_form',
      'get_resources',
    ],
    prefixes: [],
  },

  /**
   * Money: analytics today. Intended membership (ADR-001 D3) also covers
   * visits, payments and payroll; those packs are not built yet, so this facet
   * is partial on purpose.
   */
  finance: {
    tools: [],
    prefixes: ['analytics_'],
  },

  /**
   * Reaching clients. Intended membership (ADR-001 D3): loyalty programs,
   * notifications and chain-level tools. None exist yet, so the facet carries
   * only the base tools.
   */
  marketing: {
    tools: [],
    prefixes: [],
  },

  /**
   * The analytics pack and the report builder. Not in the original D3 list;
   * added for the analytics pack, which needs a facet of its own because it
   * alone is larger than some hosts' whole tool budget.
   */
  analytics: {
    tools: [],
    prefixes: ['analytics_'],
  },

  /** The guided first-time setup walkthrough. */
  onboarding: {
    tools: [],
    prefixes: ['onboarding_'],
  },
};

/**
 * Packs kept out of the default `/mcp` view. Everything else that exists is
 * served there, so the default endpoint keeps working exactly as it does today
 * for current users; a new pack joins it only by an explicit decision here.
 */
export const DEFAULT_FACET_EXCLUDED_PREFIXES: readonly string[] = [
  'analytics_',
];

/**
 * Individual tools re-admitted to `/mcp` despite an excluded prefix: the two
 * entry points a session needs before it knows to switch to `/mcp/analytics`.
 * Names that no tool provides are ignored.
 */
export const DEFAULT_FACET_EXTRA_TOOLS: readonly string[] = [
  'analytics_get_overview',
  'analytics_run_report',
];

/** Prefix removed from the default view by the onboarding config switch. */
const ONBOARDING_PREFIX = 'onboarding_';

export interface FacetIndexOptions {
  /**
   * Drop the onboarding walkthrough from `/mcp`, leaving it on
   * `/mcp/onboarding`. Off by default: turning it on is a visible change for
   * current users of the default endpoint.
   */
  readonly excludeOnboardingFromDefault?: boolean;
}

export interface FacetIndex {
  /** Facet keys with a computed member list. */
  readonly keys: readonly FacetKey[];
  /** Tool names in a facet, in the order the builder received them. */
  members(facet: FacetKey): readonly string[];
  /** Whether a facet serves a tool. */
  includes(facet: FacetKey, toolName: string): boolean;
  /** Named facets that serve a tool — used to point a caller at the right path. */
  facetsProviding(toolName: string): readonly FacetName[];
}

function matchesPrefix(name: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * Compute the facet index once, from the registered tool names in their final
 * `tools/list` order. Each facet preserves that order, so every facet's list is
 * deterministic without sorting again.
 */
export function buildFacetIndex(
  toolNames: readonly string[],
  options: FacetIndexOptions = {}
): FacetIndex {
  const base = new Set(FACET_BASE_TOOLS);
  const extras = new Set(DEFAULT_FACET_EXTRA_TOOLS);
  const excludedFromDefault = [
    ...DEFAULT_FACET_EXCLUDED_PREFIXES,
    ...(options.excludeOnboardingFromDefault ? [ONBOARDING_PREFIX] : []),
  ];

  const inDefault = (name: string): boolean =>
    base.has(name) ||
    extras.has(name) ||
    !matchesPrefix(name, excludedFromDefault);

  const inFacet = (facet: FacetName, name: string): boolean => {
    const rule = FACET_RULES[facet];
    return (
      base.has(name) ||
      rule.tools.includes(name) ||
      matchesPrefix(name, rule.prefixes)
    );
  };

  const members = new Map<FacetKey, readonly string[]>();
  members.set(ALL_TOOLS_FACET, [...toolNames]);
  members.set(
    DEFAULT_FACET,
    toolNames.filter((name) => inDefault(name))
  );
  for (const facet of FACET_NAMES) {
    members.set(
      facet,
      toolNames.filter((name) => inFacet(facet, name))
    );
  }

  const sets = new Map<FacetKey, ReadonlySet<string>>();
  for (const [facet, names] of members) {
    sets.set(facet, new Set(names));
  }

  return {
    keys: [ALL_TOOLS_FACET, DEFAULT_FACET, ...FACET_NAMES],
    members: (facet) => members.get(facet) ?? [],
    includes: (facet, toolName) => sets.get(facet)?.has(toolName) ?? false,
    facetsProviding: (toolName) =>
      FACET_NAMES.filter((facet) => sets.get(facet)?.has(toolName)),
  };
}
