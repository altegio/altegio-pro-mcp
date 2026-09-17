/**
 * Static views of the tool surface — ADR-001 D3.
 *
 * A facet is a fixed, filtered view of the one tool surface, served on its own
 * HTTP sub-path (`/mcp/<facet>`). Facets exist for hosts that cap the number of
 * active tools and cannot defer them; they are not product boundaries, carry no
 * separate audience or credential, and never change the behavior of a tool.
 *
 * The read-only view (`READONLY_VIEW`) is deliberately NOT a facet. A facet
 * answers "how many tools fit in this host's context"; the read-only view
 * answers "what may this agent do at all". They are different questions with
 * different membership rules — a facet is a hand-curated domain slice, the
 * read-only view is computed from each tool's own `readOnlyHint` — so they are
 * separate kinds of view, alongside `DEFAULT_FACET` and `ALL_TOOLS_FACET`.
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
 * including packs the default HTTP view holds back, the password login tools
 * and access management. It has no HTTP route.
 */
export const ALL_TOOLS_FACET = 'all';

/**
 * Key of the read-only view served on `/mcp/readonly`.
 *
 * Its own HTTP address, because that is the only place a restriction can live
 * that both the protocol and the hosts respect. A separate URL is a separate
 * OAuth resource, which every host already understands; the alternative
 * considered — a request header such as `X-MCP-Readonly` — was rejected, since
 * nothing enforces a header the caller sets for itself, Claude Desktop does not
 * send one, and honoring it would make `tools/list` differ between connections
 * to the *same* resource, which ADR-001 D7 forbids. GitHub, Linear, Sentry,
 * Stripe, Notion, Atlassian and Slack all restrict an agent the same way.
 *
 * The audience is not the business owner — they take the full surface. It is
 * the caller with no human watching: an autonomous agent, a shared team agent,
 * a third-party agent nobody has audited, chain-wide analytics, and our own
 * internal builds. So it is documented for developers and not offered during
 * onboarding or in the marketplace.
 */
export const READONLY_VIEW = 'readonly';

export type FacetKey =
  | FacetName
  | typeof DEFAULT_FACET
  | typeof ALL_TOOLS_FACET
  | typeof READONLY_VIEW;

export function isFacetName(value: string): value is FacetName {
  return (FACET_NAMES as readonly string[]).includes(value);
}

/**
 * A tool as the view builder sees it: its name, and whether it only reads.
 *
 * `readOnly` is the tool's own `readOnlyHint` annotation and nothing else, so
 * the read-only view can never drift from the tool surface: a pack that lands
 * next month is classified by the annotation its own author wrote, with no list
 * here to update. The test in `__tests__/facets.test.ts` fails if the view ever
 * disagrees with the annotations, and `__tests__/tool-annotations.test.ts`
 * already forbids a tool from shipping without an annotations block at all.
 */
export interface FacetTool {
  readonly name: string;
  readonly readOnly: boolean;
}

/** The one rule for "this tool only reads". */
export function isReadOnlyTool(annotations?: {
  readOnlyHint?: boolean;
}): boolean {
  return annotations?.readOnlyHint === true;
}

/**
 * Project tool specs onto what the view builder needs. Fail-closed: a missing,
 * false or non-boolean `readOnlyHint` makes the tool a write, so a new tool is
 * kept off the read-only view until someone states that it only reads.
 */
export function facetToolsFromSpecs(
  specs: readonly { name: string; annotations?: { readOnlyHint?: boolean } }[]
): FacetTool[] {
  return specs.map((spec) => ({
    name: spec.name,
    readOnly: isReadOnlyTool(spec.annotations),
  }));
}

/**
 * Tools every facet carries unconditionally. Location discovery is the whole
 * list: nearly every tool needs a `location_id`, so a facet without it is
 * unusable. Password login is admitted per deployment instead — see
 * `PASSWORD_LOGIN_TOOLS`.
 */
export const FACET_BASE_TOOLS: readonly string[] = ['list_locations'];

/**
 * Email + password login, admitted to the HTTP views only when the deployment
 * asks for it (`exposePasswordLogin`, set from `ALTEGIO_EXPOSE_PASSWORD_LOGIN`).
 *
 * `altegio_login` tells the model to ask the user for an email and a password.
 * On the public endpoint, which authenticates through OAuth and never needs
 * them, that is a standing prompt-injection target: any text the model reads
 * can try to talk it into collecting credentials. So the public HTTP surface
 * does not carry these tools, and a call to one is refused, not merely hidden.
 *
 * Two deployments still need them and turn the switch on:
 *  - stdio — the desktop host logs in with a password. It serves the unfiltered
 *    `all` view, which is never filtered by this switch.
 *  - the closed staff deployment behind Google OIDC (`hd=alteg.io`), where a
 *    password login is still how a V1 user token is obtained.
 */
export const PASSWORD_LOGIN_TOOLS: readonly string[] = [
  'altegio_login',
  'altegio_logout',
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
   * Daily work: the digital schedule, appointments, clients. The `clients_*`
   * pack (segmentation, client card, visit history, lookup) joins by prefix;
   * the journal tools do not exist yet.
   */
  ops: {
    tools: [
      'get_appointments',
      'create_appointment',
      'update_appointment',
      'delete_appointment',
    ],
    prefixes: ['clients_'],
  },

  /**
   * What the location offers and who delivers it: services, team members,
   * positions, work schedules, resources, location settings.
   */
  catalog: {
    tools: [
      'update_location',
      'get_services',
      'create_service',
      'update_service',
      'delete_service',
      'link_service_team_member',
      'update_service_team_member',
      'unlink_service_team_member',
      'link_team_member_services',
      'get_service_categories',
      'delete_service_category',
      'get_staff',
      'create_staff',
      'update_staff',
      'delete_staff',
      'get_positions',
      'create_position',
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
      'delete_booking_form',
      'get_resources',
      'remove_location_user',
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
   * The analytics pack. Not in the original D3 list; added for the analytics
   * pack, which needs a facet of its own because it alone is larger than some
   * hosts' whole tool budget. The report-builder tools are withheld from every
   * view (report builder disabled, see `./disabled-tools.ts`).
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
 * Individual tools withheld from the default `/mcp` view while staying on a
 * narrower path and on stdio's unfiltered `all` view. Unlike the prefix list
 * above this names one tool at a time, for a tool whose pack is otherwise
 * served by default.
 *
 * `remove_location_user` hands out and revokes access to a location. The v3
 * authorization RFC puts access management among the dangerous rights that no
 * integration is granted by default, so it is not part of what `/mcp` offers a
 * generic agent. It stays on `/mcp/catalog` — a path a deployment points a
 * client at deliberately — and on stdio.
 */
export const DEFAULT_FACET_EXCLUDED_TOOLS: readonly string[] = [
  'remove_location_user',
];

/**
 * Individual tools re-admitted to `/mcp` despite an excluded prefix: the entry
 * point a session needs before it knows to switch to `/mcp/analytics`. Names
 * that no tool provides are ignored — the report-builder entries that used to
 * sit here are withheld from every view (report builder disabled, see
 * `./disabled-tools.ts`).
 */
export const DEFAULT_FACET_EXTRA_TOOLS: readonly string[] = [
  'analytics_get_overview',
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

  /**
   * Admit `PASSWORD_LOGIN_TOOLS` to the default view and to every named facet.
   * Off by default, which is the safe posture for a public HTTP endpoint. The
   * unfiltered `all` view stdio serves is not affected either way — it always
   * carries them.
   */
  readonly exposePasswordLogin?: boolean;
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
 * Compute the view index once, from the registered tools in their final
 * `tools/list` order. Each view preserves that order, so every view's list is
 * deterministic without sorting again.
 */
export function buildFacetIndex(
  tools: readonly FacetTool[],
  options: FacetIndexOptions = {}
): FacetIndex {
  const toolNames = tools.map((tool) => tool.name);
  const readOnlyNames = new Set(
    tools.filter((tool) => tool.readOnly).map((tool) => tool.name)
  );
  const exposePasswordLogin = options.exposePasswordLogin ?? false;
  const base = new Set([
    ...FACET_BASE_TOOLS,
    ...(exposePasswordLogin ? PASSWORD_LOGIN_TOOLS : []),
  ]);
  const extras = new Set(DEFAULT_FACET_EXTRA_TOOLS);
  const excludedFromDefault = [
    ...DEFAULT_FACET_EXCLUDED_PREFIXES,
    ...(options.excludeOnboardingFromDefault ? [ONBOARDING_PREFIX] : []),
  ];
  // Withheld by name, ahead of every admitting rule: an excluded tool stays
  // excluded even if a base or extra entry would otherwise let it back in.
  const excludedNames = new Set([
    ...DEFAULT_FACET_EXCLUDED_TOOLS,
    ...(exposePasswordLogin ? [] : PASSWORD_LOGIN_TOOLS),
  ]);

  const inDefault = (name: string): boolean =>
    !excludedNames.has(name) &&
    (base.has(name) ||
      extras.has(name) ||
      !matchesPrefix(name, excludedFromDefault));

  const inFacet = (facet: FacetName, name: string): boolean => {
    const rule = FACET_RULES[facet];
    return (
      base.has(name) ||
      rule.tools.includes(name) ||
      matchesPrefix(name, rule.prefixes)
    );
  };

  // The read-only view: every tool that declares it only reads, minus the
  // tools this deployment withholds from the HTTP surface by name. Note what is
  // deliberately absent — `FACET_BASE_TOOLS` is NOT force-admitted here the way
  // it is to a facet, so a base tool that ever stopped being read-only would
  // drop out of this view instead of quietly widening it. The default view's
  // prefix exclusions do not apply either: the whole analytics pack only reads,
  // and chain-wide analytics is exactly who this address is for.
  const inReadOnly = (name: string): boolean =>
    readOnlyNames.has(name) && !excludedNames.has(name);

  const members = new Map<FacetKey, readonly string[]>();
  members.set(ALL_TOOLS_FACET, [...toolNames]);
  members.set(
    DEFAULT_FACET,
    toolNames.filter((name) => inDefault(name))
  );
  members.set(
    READONLY_VIEW,
    toolNames.filter((name) => inReadOnly(name))
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
    keys: [ALL_TOOLS_FACET, DEFAULT_FACET, READONLY_VIEW, ...FACET_NAMES],
    members: (facet) => members.get(facet) ?? [],
    includes: (facet, toolName) => sets.get(facet)?.has(toolName) ?? false,
    facetsProviding: (toolName) =>
      FACET_NAMES.filter((facet) => sets.get(facet)?.has(toolName)),
  };
}

/** MCP sub-path of a view, appended to a deployment's public base URL. */
function viewPath(view: typeof DEFAULT_FACET | typeof READONLY_VIEW): string {
  return view === DEFAULT_FACET ? '/mcp' : `/mcp/${view}`;
}

/** Absolute address of a view, from the deployment's public base URL. */
export function viewUrl(
  publicBaseUrl: string,
  view: typeof DEFAULT_FACET | typeof READONLY_VIEW
): string {
  return `${publicBaseUrl.replace(/\/+$/, '')}${viewPath(view)}`;
}

/**
 * What a caller gets when it invokes a writing tool on the read-only address.
 *
 * Hiding the tool from `tools/list` is not enough on its own: a model that has
 * the name from anywhere else — a cached list, documentation, a guess — will
 * still call it, so the call is refused as well (the same posture as password
 * login on the public surface).
 *
 * The text names the full address of the complete surface because a host cannot
 * act on anything subtler. Re-authorizing after a 403 to widen a token is not a
 * thing MCP hosts do — Claude Code closed that request as "not planned" in
 * April 2026 — so there is no step-up to hint at. The only real next step is a
 * person changing which server their client connects to, and the message has to
 * say so in words the model can act on: report, do not retry.
 */
export function readOnlyRefusalMessage(
  toolName: string,
  publicBaseUrl: string
): string {
  return [
    `Tool "${toolName}" changes data, and this endpoint (${viewUrl(publicBaseUrl, READONLY_VIEW)}) serves read operations only.`,
    'Nothing unlocks it from here: no confirmation, no wider scope and no retry turns this address into a writing one.',
    `The complete surface is a separate MCP server at ${viewUrl(publicBaseUrl, DEFAULT_FACET)}, which a person adds in their own client configuration — this session cannot move there by itself.`,
    'So: finish the reading part of the task, then tell the user precisely what change you would have made and where, and let them decide whether they want an agent that can make it.',
  ].join(' ');
}
