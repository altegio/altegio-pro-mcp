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
 *
 * **Where the mechanisms are joined:** this module is one of several that
 * decide where a tool is served. `./surface.ts` puts all of them into one
 * table — tool × view, with a machine-readable reason — and renders it to
 * `docs/architecture/tool-surface.md`. `decideView` below is the only
 * membership function; everything else, `buildFacetIndex` included, is a
 * projection of it.
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
      'appointments_preview_attendance',
      'appointments_apply_attendance',
    ],
    prefixes: ['clients_'],
  },

  /**
   * What the location offers and who delivers it: services, team members,
   * positions, work schedules, resources, location settings.
   */
  catalog: {
    tools: [
      'diagnose_location_access',
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
    tools: ['clients_get_membership_purchases'],
    prefixes: ['analytics_'],
  },

  /**
   * Reaching clients. Membership purchase evidence is the first loyalty
   * workflow here; notifications and chain-level tools remain future work.
   */
  marketing: {
    tools: ['clients_get_membership_purchases'],
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
 * Why a view serves a tool. A machine value, not a comment: `./surface.ts`
 * turns these into the one table that answers "why is tool X on address Y",
 * and the generated `docs/architecture/tool-surface.md` renders them, so a
 * change of rule shows up in a reviewer's diff instead of in someone's head.
 */
export type ViewAdmitReason =
  /** The unfiltered `all` view stdio serves: no rule applies. */
  | 'unfiltered-view'
  /** In `FACET_BASE_TOOLS`: every facet carries it unconditionally. */
  | 'facet-base-tool'
  /** In `PASSWORD_LOGIN_TOOLS` with `exposePasswordLogin` on. */
  | 'password-login-exposed'
  /** Named one by one in this facet's rule. */
  | 'facet-rule-name'
  /** Matched by one of this facet's tool-name prefixes. */
  | 'facet-rule-prefix'
  /** In `DEFAULT_FACET_EXTRA_TOOLS`: re-admitted despite an excluded prefix. */
  | 'default-view-extra-tool'
  /** On `/mcp` because nothing excludes it — the default for everything. */
  | 'default-view-not-excluded'
  /** On `/mcp/readonly` because its own `readOnlyHint` says it only reads. */
  | 'read-only-annotation';

/** Why a view withholds a tool. Machine values, same contract as above. */
export type ViewWithholdReason =
  /** In `PASSWORD_LOGIN_TOOLS` with `exposePasswordLogin` off. */
  | 'password-login-not-exposed'
  /** In `DEFAULT_FACET_EXCLUDED_TOOLS` (also applied to the read-only view). */
  | 'default-view-excluded-tool'
  /** Matched by `DEFAULT_FACET_EXCLUDED_PREFIXES` and not re-admitted. */
  | 'default-view-excluded-prefix'
  /** The `excludeOnboardingFromDefault` config switch is on. */
  | 'onboarding-excluded-from-default'
  /** This facet's rule names neither the tool nor a prefix matching it. */
  | 'not-in-facet-rule'
  /** Not annotated `readOnlyHint: true`, so `/mcp/readonly` will not serve it. */
  | 'not-read-only';

export type ViewDecision =
  | { readonly served: true; readonly reason: ViewAdmitReason }
  | { readonly served: false; readonly reason: ViewWithholdReason };

const admit = (reason: ViewAdmitReason): ViewDecision => ({
  served: true,
  reason,
});
const withhold = (reason: ViewWithholdReason): ViewDecision => ({
  served: false,
  reason,
});

/**
 * **The one decision function.** Whether a view serves a tool, and the reason.
 *
 * Every view built anywhere in this server goes through here —
 * `buildFacetIndex` is a projection of it, and so is the surface table — so
 * the six admission mechanisms that grew up independently (disabled tools,
 * excluded prefixes, excluded names, extra names, password login, the
 * read-only rule) have exactly one implementation and one explanation.
 *
 * It does NOT know about `./disabled-tools.ts`: a disabled tool never reaches
 * the registry at all, so that exclusion sits one level up, in `./surface.ts`.
 */
export function decideView(
  view: FacetKey,
  tool: FacetTool,
  options: FacetIndexOptions = {}
): ViewDecision {
  const { name } = tool;
  const exposePasswordLogin = options.exposePasswordLogin ?? false;
  const isPasswordLogin = PASSWORD_LOGIN_TOOLS.includes(name);
  const isBase = FACET_BASE_TOOLS.includes(name);

  if (view === ALL_TOOLS_FACET) {
    // stdio's view: never filtered, not even by the password-login switch.
    return admit('unfiltered-view');
  }

  // Withheld from every HTTP view by the deployment, ahead of every admitting
  // rule — a base or extra entry must not let an excluded tool back in.
  if (isPasswordLogin && !exposePasswordLogin) {
    return withhold('password-login-not-exposed');
  }

  if (view === READONLY_VIEW) {
    // The view's own rule first: a writing tool is absent because it writes,
    // whatever else would also have excluded it.
    if (!tool.readOnly) return withhold('not-read-only');
    if (DEFAULT_FACET_EXCLUDED_TOOLS.includes(name)) {
      return withhold('default-view-excluded-tool');
    }
    // Note what is deliberately NOT here: `FACET_BASE_TOOLS` is not
    // force-admitted the way it is to a facet, so a base tool that ever
    // stopped being read-only would drop out instead of quietly widening the
    // view; and the default view's prefix exclusions do not apply, so the
    // whole analytics pack is served here.
    return admit('read-only-annotation');
  }

  if (view === DEFAULT_FACET) {
    if (DEFAULT_FACET_EXCLUDED_TOOLS.includes(name)) {
      return withhold('default-view-excluded-tool');
    }
    if (isPasswordLogin) return admit('password-login-exposed');
    if (isBase) return admit('facet-base-tool');
    if (DEFAULT_FACET_EXTRA_TOOLS.includes(name)) {
      return admit('default-view-extra-tool');
    }
    if (matchesPrefix(name, DEFAULT_FACET_EXCLUDED_PREFIXES)) {
      return withhold('default-view-excluded-prefix');
    }
    if (
      options.excludeOnboardingFromDefault &&
      name.startsWith(ONBOARDING_PREFIX)
    ) {
      return withhold('onboarding-excluded-from-default');
    }
    return admit('default-view-not-excluded');
  }

  // A named facet. `DEFAULT_FACET_EXCLUDED_TOOLS` deliberately does not apply:
  // a tool kept off the generic default endpoint stays reachable on the
  // narrower path a deployment points a client at on purpose.
  if (isPasswordLogin) return admit('password-login-exposed');
  if (isBase) return admit('facet-base-tool');
  const rule = FACET_RULES[view];
  if (rule.tools.includes(name)) return admit('facet-rule-name');
  if (matchesPrefix(name, rule.prefixes)) return admit('facet-rule-prefix');
  return withhold('not-in-facet-rule');
}

/** Every view this server can serve, in the order the table renders them. */
export const VIEW_KEYS: readonly FacetKey[] = [
  ALL_TOOLS_FACET,
  DEFAULT_FACET,
  READONLY_VIEW,
  ...FACET_NAMES,
];

/**
 * Compute the view index once, from the registered tools in their final
 * `tools/list` order. Each view preserves that order, so every view's list is
 * deterministic without sorting again. Membership is `decideView` and nothing
 * else.
 */
export function buildFacetIndex(
  tools: readonly FacetTool[],
  options: FacetIndexOptions = {}
): FacetIndex {
  const members = new Map<FacetKey, readonly string[]>();
  for (const view of VIEW_KEYS) {
    members.set(
      view,
      tools
        .filter((tool) => decideView(view, tool, options).served)
        .map((tool) => tool.name)
    );
  }

  const sets = new Map<FacetKey, ReadonlySet<string>>();
  for (const [facet, names] of members) {
    sets.set(facet, new Set(names));
  }

  return {
    keys: VIEW_KEYS,
    members: (facet) => members.get(facet) ?? [],
    includes: (facet, toolName) => sets.get(facet)?.has(toolName) ?? false,
    facetsProviding: (toolName) =>
      FACET_NAMES.filter((facet) => sets.get(facet)?.has(toolName)),
  };
}

/** Sub-path of a view, appended to the public address of the complete surface. */
function viewPath(view: FacetKey): string {
  return view === DEFAULT_FACET ? '' : `/${view}`;
}

/** Absolute address of a view, from the public address of the complete surface. */
export function viewUrl(publicBaseUrl: string, view: FacetKey): string {
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
