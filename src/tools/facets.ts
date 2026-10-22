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
 * Tool names use the canonical product vocabulary.
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
 * Key of the unfiltered view: every registered tool but the dispatcher, which
 * runs what a view does not list. stdio uses it — a desktop host connects to
 * one process and must see the whole surface, including packs the default
 * HTTP view holds back, the password login tools and access management. It
 * has no HTTP route.
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

/**
 * Key of the compact view served on `/mcp/compact`, and what `/mcp` lists by
 * default (`DEFAULT_VIEW_LISTINGS`).
 *
 * It reaches what the full list reaches and more, with about two fifths of its
 * listing: `tools/list` carries the most used tools (`COMPACT_VIEW_TOOLS`) and
 * the curated-tool dispatcher (`DISPATCH_TOOLS`), and every other tool a
 * generic agent may hold — the packs and groups the full list leaves out for
 * its byte budget included — is found with `tools_search` and run through
 * `tools_call_read`, `tools_call_write` or `tools_call_destructive`, with that
 * tool's own validation, scope and confirmation. The list is still static per
 * address (ADR-001 D7); only what one tool call dispatches to varies. Like the
 * read-only view it is a view, not a facet: it answers "how much does a host
 * pay up front", not "which domain".
 */
export const COMPACT_VIEW = 'compact';

/**
 * Key of the full flat view served on `/mcp/full`: every tool the default view
 * served before it adopted the compact listing, listed one by one, with no
 * dispatcher. It is for gateways and scripts that want the whole list up
 * front; `DEFAULT_FACET_EXCLUDED_PREFIXES`, `DEFAULT_FACET_EXTRA_TOOLS` and
 * `DEFAULT_FACET_DEMOTED_GROUPS` shape it. A sub-path, not a query parameter
 * or a header, because ADR-001 D7 wants one static `tools/list` per address.
 */
export const FULL_VIEW = 'full';

/**
 * What `/mcp` lists, a deployment switch (`MCP_DEFAULT_VIEW`): the compact
 * listing with the dispatcher, or the full flat list. Either way `/mcp` keeps
 * its address and a direct call by name to anything the listing reaches runs;
 * `full` is the way back for a deployment without a code change.
 */
export const DEFAULT_VIEW_LISTINGS = ['compact', 'full'] as const;

export type DefaultViewListing = (typeof DEFAULT_VIEW_LISTINGS)[number];

/** What `/mcp` lists when the deployment does not say. */
export const DEFAULT_VIEW_LISTING: DefaultViewListing = 'compact';

export type FacetKey =
  | FacetName
  | typeof DEFAULT_FACET
  | typeof ALL_TOOLS_FACET
  | typeof READONLY_VIEW
  | typeof COMPACT_VIEW
  | typeof FULL_VIEW;

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
 * Tools every facet carries unconditionally. Location discovery, because
 * nearly every tool needs a `location_id`, so a facet without it is unusable;
 * the signed-in person's own profile, because a host that speaks the user's
 * Altegio language needs it whichever facet it mounted; and the feedback
 * report, because a missing capability shows up on whichever facet lacks it.
 * Password login is admitted per deployment instead — see
 * `PASSWORD_LOGIN_TOOLS`.
 */
export const FACET_BASE_TOOLS: readonly string[] = [
  'locations_list',
  'users_get_current',
  'feedback_submit',
];

/**
 * Email + password login, admitted to the HTTP views only when the deployment
 * asks for it (`exposePasswordLogin`, set from `ALTEGIO_EXPOSE_PASSWORD_LOGIN`).
 *
 * `auth_login` tells the model to ask the user for an email and a password.
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
  'auth_login',
  'auth_logout',
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
   * Daily work: the digital schedule, appointments, group events, clients. The
   * `events_*` pack (timetable, bookings, duplication) and the `clients_*` pack
   * (segmentation, client card, visit history, lookup) join by prefix; the
   * reception's membership tasks (a client's memberships, freeze, unfreeze)
   * join by name, the rest of that pack lives on `marketing`. So do the
   * reception's inventory tasks — an appointment's consumables and a product
   * lookup with its stock; the rest of the inventory pack lives on `finance`.
   * The journal tools do not exist yet.
   */
  ops: {
    tools: [
      'appointments_list',
      'appointments_find_free_slots',
      'appointments_create',
      'appointments_update',
      'appointments_delete',
      'appointments_list_tags',
      'appointments_create_tag',
      'appointments_preview_attendance',
      'appointments_apply_attendance',
      'memberships_list_for_client',
      'memberships_freeze',
      'memberships_unfreeze',
      'visits_get',
      'visits_add_payment',
      'visits_add_product',
      'visits_remove_product',
      'visits_cancel_payment',
      'client_accounts_list_for_client',
      'client_accounts_deposit',
      'accounts_and_cash_registers_list',
      'appointments_get_consumables',
      'appointments_set_consumables',
      'products_search',
    ],
    prefixes: ['events_', 'clients_'],
  },

  /**
   * What the location offers and who delivers it: services, team members,
   * positions, work schedules, resources, location settings.
   */
  catalog: {
    tools: [
      'locations_diagnose_access',
      'locations_update',
      'services_list',
      'services_create',
      'services_update',
      'services_delete',
      'services_link_team_member',
      'services_update_team_member_link',
      'services_unlink_team_member',
      'team_members_link_services',
      'service_categories_list',
      'service_categories_create',
      'service_categories_update',
      'service_categories_delete',
      'team_members_list',
      'team_members_create',
      'team_members_update',
      'team_members_delete',
      'positions_list',
      'positions_create',
      'positions_update',
      'positions_delete',
      'schedules_get',
      'schedules_create',
      'schedules_update',
      'schedules_delete',
      'settings_get_appointment_calendar',
      'settings_update_appointment_calendar',
      'settings_get_online_booking',
      'settings_update_online_booking',
      'booking_forms_list',
      'booking_forms_create',
      'booking_forms_delete',
      'resources_list',
      'locations_remove_user',
    ],
    prefixes: [],
  },

  /**
   * Money: a visit and its payments, client accounts, accounts and cash
   * registers, financial transactions, payroll, inventory, and the analytics
   * pack. Inventory is stock valued at cost price, bought from Suppliers and
   * Partners and sold or used up — the money side of products, next to the
   * product-sales and reorder-risk analytics. The `inventory_`, `products_`
   * and `product_categories_` packs join by prefix, Suppliers and the
   * appointment consumables by name.
   * Still partial: fund transfers between accounts and cash registers (no
   * documented operation) and fiscalization are not built.
   */
  finance: {
    tools: [
      'clients_get_membership_purchases',
      'suppliers_and_partners_list',
      'appointments_get_consumables',
      'appointments_set_consumables',
    ],
    prefixes: [
      'visits_',
      'client_accounts_',
      'accounts_and_cash_registers_',
      'financial_transactions_',
      'payroll_',
      'analytics_',
      'inventory_',
      'products_',
      'product_categories_',
    ],
  },

  /**
   * Reaching clients and keeping them: loyalty. The `memberships_*` pack joins
   * by prefix (membership types, sold memberships, the chains they belong to)
   * next to the membership purchase evidence; notifications, gift cards and
   * loyalty programs remain future work.
   */
  marketing: {
    tools: ['clients_get_membership_purchases'],
    prefixes: ['memberships_'],
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
 * Packs kept out of the full flat list (`/mcp/full`, and `/mcp` when the
 * deployment lists it in full). Everything else that exists is served there; a
 * new pack joins it only by an explicit decision here. The compact listing
 * reaches these packs through its dispatcher.
 *
 * Back-office money (`financial_transactions_*`, `payroll_*`) is served on
 * `/mcp`: owners are the default view's first audience (ADR-001 D2), and
 * withholding the expense and payroll tools while serving payments and stock
 * writes left an owner no way to record an expense from the default address.
 * What `/mcp` may cost is a byte budget (`./listing-budget.ts`), not a list;
 * single low-use groups leave it through `DEFAULT_FACET_DEMOTED_GROUPS`.
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
 * `locations_remove_user` hands out and revokes access to a location. The v3
 * authorization RFC puts access management among the dangerous rights that no
 * integration is granted by default, so it is not part of what `/mcp` offers a
 * generic agent. It stays on `/mcp/catalog` — a path a deployment points a
 * client at deliberately — and on stdio.
 */
export const DEFAULT_FACET_EXCLUDED_TOOLS: readonly string[] = [
  'locations_remove_user',
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

/**
 * A low-use group served only on its facet, not on `/mcp`.
 *
 * Unlike `DEFAULT_FACET_EXCLUDED_TOOLS` this is about the default view's byte
 * budget, not about a right: the read-only view and every facet are
 * unaffected.
 */
export interface DemotedGroup {
  /** What the group does, as the default view's instructions name it. */
  readonly summary: string;
  /** The facet that keeps serving the whole group. */
  readonly facet: FacetName;
  /** Tools named one by one. */
  readonly tools: readonly string[];
  /** Tool-name prefixes; one entry demotes a whole pack. */
  readonly prefixes: readonly string[];
}

/**
 * Groups demoted from the full list to their facet by measured use. On
 * 2026-10-20 these 26 tools carried 442 of about 164,600 calls to the hosted
 * default view over 22 days (0.27 %) and 23 KB of its listing. A call to one
 * on the full list is refused with the address that serves it, and its
 * `initialize` instructions name each group and its facet
 * (`demotedGroupsInstruction`), so a model can still tell the user where to
 * find it. The compact listing reaches them through its dispatcher. Promote a
 * group back by removing it here, as a reviewed change to the listing budget.
 */
export const DEFAULT_FACET_DEMOTED_GROUPS: readonly DemotedGroup[] = [
  {
    summary: 'the first-time setup wizard',
    facet: 'onboarding',
    tools: [],
    prefixes: ['onboarding_'],
  },
  {
    summary: 'event duplication patterns',
    facet: 'ops',
    tools: [
      'events_list_duplication_strategies',
      'events_create_duplication_strategy',
      'events_update_duplication_strategy',
      'events_delete_duplication_strategy',
    ],
    prefixes: [],
  },
  {
    summary: 'client files',
    facet: 'ops',
    tools: ['clients_list_files', 'clients_upload_file'],
    prefixes: [],
  },
  {
    summary: 'membership freeze, balance and validity changes',
    facet: 'marketing',
    tools: [
      'memberships_freeze',
      'memberships_unfreeze',
      'memberships_set_balance',
      'memberships_set_validity',
    ],
    prefixes: [],
  },
  {
    summary: 'archiving or deleting a membership type',
    facet: 'marketing',
    tools: ['memberships_archive_type', 'memberships_delete_type'],
    prefixes: [],
  },
  {
    summary: 'creating or deleting a booking form',
    facet: 'catalog',
    tools: ['booking_forms_create', 'booking_forms_delete'],
    prefixes: [],
  },
  {
    // New on 2026-10-21 for back-office product management (supplier invoice
    // intake) and the receipt it records; not measured yet, so it starts on
    // its facet like the groups above rather than growing the flat list.
    summary:
      'managing products and product categories, editing inventory documents and paying product receipts',
    facet: 'finance',
    tools: [
      'products_create',
      'products_update',
      'products_archive',
      'product_categories_create',
      'product_categories_update',
      'product_categories_delete',
      'inventory_update_document',
      'inventory_pay_document',
    ],
    prefixes: [],
  },
];

/**
 * The curated-tool dispatcher: search, then run a tool the view does not list,
 * through one of three tools by risk — the tiers of Atlassian Rovo's
 * `executeRead` / `executeWrite` / `executeDestructive`, so a host can approve
 * reads and ordinary writes without asking and still stop before a deletion.
 * Listed on the compact listing (`/mcp`, `/mcp/compact`) only. A tool that
 * listing carries is called directly, so a host's setting for it holds.
 */
export const DISPATCH_SEARCH_TOOL = 'tools_search';
export const DISPATCH_READ_TOOL = 'tools_call_read';
export const DISPATCH_WRITE_TOOL = 'tools_call_write';
export const DISPATCH_DESTRUCTIVE_TOOL = 'tools_call_destructive';
export const DISPATCH_TOOLS: readonly string[] = [
  DISPATCH_SEARCH_TOOL,
  DISPATCH_READ_TOOL,
  DISPATCH_WRITE_TOOL,
  DISPATCH_DESTRUCTIVE_TOOL,
];

/**
 * What the compact listing carries besides `FACET_BASE_TOOLS` and the
 * dispatcher.
 *
 * The first twenty: the daily core of ADR-001 D2 — the journal, free slots,
 * booking, the client card, the team, schedules, services and the sales
 * summary — and every tool with more than about 700 calls to the hosted
 * default view in the 22 days to 2026-10-20, which together carried about
 * 95 % of those calls. The executor stays listed: it reads what no curated
 * tool covers, and its search names the curated tool where one exists.
 *
 * The last ten: the most called tools beyond those on interactive hosts
 * (claude.ai, Codex, ChatGPT, Claude Code, Cursor), 2026-10-16..21, in that
 * order. With them the listed tools answer about 96.5 % of interactive calls
 * directly, against 91.5 % without.
 */
export const COMPACT_VIEW_TOOLS: readonly string[] = [
  'api_search_operations',
  'api_describe_operation',
  'api_call_operation',
  'appointments_list',
  'appointments_find_free_slots',
  'appointments_create',
  'appointments_update',
  'appointments_delete',
  'analytics_get_overview',
  'team_members_list',
  'schedules_get',
  'services_list',
  'services_update',
  'clients_search',
  'clients_get_card',
  'clients_get_visit_history',
  'clients_get_segment_report',
  'clients_list_profiles',
  'clients_list_comments',
  'events_get',
  'services_create',
  'clients_lookup',
  'events_book_clients',
  'services_link_team_member',
  'payroll_get_calculation',
  'memberships_create_type',
  'team_members_link_services',
  'memberships_get_type',
  'schedules_create',
  'financial_transactions_list',
];

/** The demoted group a tool belongs to, if any. */
export function demotedGroupOf(name: string): DemotedGroup | undefined {
  return DEFAULT_FACET_DEMOTED_GROUPS.find(
    (group) => group.tools.includes(name) || matchesPrefix(name, group.prefixes)
  );
}

/**
 * One sentence for the full list's `initialize` instructions: each demoted
 * group and the address that serves it, relative to the complete surface's
 * address like the rest of the instructions.
 */
export function demotedGroupsInstruction(): string {
  const byFacet = new Map<FacetName, string[]>();
  for (const group of DEFAULT_FACET_DEMOTED_GROUPS) {
    byFacet.set(group.facet, [
      ...(byFacet.get(group.facet) ?? []),
      group.summary,
    ]);
  }
  const parts = [...byFacet].map(
    ([facet, summaries]) => `${summaries.join(', ')} (/${facet})`
  );
  return `Served only on a narrower address, not here: ${parts.join('; ')}.`;
}

export interface FacetIndexOptions {
  /**
   * Admit `PASSWORD_LOGIN_TOOLS` to the default view and to every named facet.
   * Off by default, which is the safe posture for a public HTTP endpoint. The
   * unfiltered `all` view stdio serves is not affected either way — it always
   * carries them.
   */
  readonly exposePasswordLogin?: boolean;
  /**
   * What `/mcp` lists (`MCP_DEFAULT_VIEW`); `DEFAULT_VIEW_LISTING` when unset.
   */
  readonly defaultListing?: DefaultViewListing;
}

/**
 * The view whose rule a view follows: `/mcp` follows the compact view or the
 * full list, as the deployment says; every other view its own.
 */
export function effectiveView(
  view: FacetKey,
  options: FacetIndexOptions = {}
): Exclude<FacetKey, typeof DEFAULT_FACET> {
  if (view !== DEFAULT_FACET) return view;
  return (options.defaultListing ?? DEFAULT_VIEW_LISTING) === 'full'
    ? FULL_VIEW
    : COMPACT_VIEW;
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
  /** Tool names a view's dispatcher runs (`dispatchReaches`), in order. */
  reachable(facet: FacetKey): readonly string[];
  /** Whether a call on a view reaches a tool: listed, or dispatched. */
  serves(facet: FacetKey, toolName: string): boolean;
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
  /** On the full list because nothing excludes it — the default for everything. */
  | 'default-view-not-excluded'
  /** On `/mcp/readonly` because its own `readOnlyHint` says it only reads. */
  | 'read-only-annotation'
  /** On the compact listing: `COMPACT_VIEW_TOOLS` or the dispatcher. */
  | 'compact-view-listed';

/** Why a view withholds a tool. Machine values, same contract as above. */
export type ViewWithholdReason =
  /** In `PASSWORD_LOGIN_TOOLS` with `exposePasswordLogin` off. */
  | 'password-login-not-exposed'
  /** In `DEFAULT_FACET_EXCLUDED_TOOLS` (also applied to the read-only view). */
  | 'default-view-excluded-tool'
  /** Matched by `DEFAULT_FACET_EXCLUDED_PREFIXES` and not re-admitted. */
  | 'default-view-excluded-prefix'
  /** In `DEFAULT_FACET_DEMOTED_GROUPS`: low use, served on its facet only. */
  | 'default-view-demoted'
  /** This facet's rule names neither the tool nor a prefix matching it. */
  | 'not-in-facet-rule'
  /** Not annotated `readOnlyHint: true`, so `/mcp/readonly` will not serve it. */
  | 'not-read-only'
  /**
   * Not on the compact listing, and reached there through `tools_call_read`,
   * `tools_call_write` or `tools_call_destructive` (`dispatchReaches`).
   */
  | 'compact-view-dispatched'
  /** A dispatcher tool: only the compact listing lists it. */
  | 'dispatcher-compact-only';

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
  address: FacetKey,
  tool: FacetTool,
  options: FacetIndexOptions = {}
): ViewDecision {
  const { name } = tool;
  // `/mcp` is decided by the rule of the listing it serves.
  const view = effectiveView(address, options);
  const exposePasswordLogin = options.exposePasswordLogin ?? false;
  const isPasswordLogin = PASSWORD_LOGIN_TOOLS.includes(name);
  const isBase = FACET_BASE_TOOLS.includes(name);

  if (view === ALL_TOOLS_FACET) {
    // stdio's view: never filtered, not even by the password-login switch.
    // It lists every tool, so the dispatcher would have nothing to run.
    return DISPATCH_TOOLS.includes(name)
      ? withhold('dispatcher-compact-only')
      : admit('unfiltered-view');
  }

  // Withheld from every HTTP view by the deployment, ahead of every admitting
  // rule — a base or extra entry must not let an excluded tool back in.
  if (isPasswordLogin && !exposePasswordLogin) {
    return withhold('password-login-not-exposed');
  }

  // The dispatcher reaches tools a view does not list, so it belongs to the
  // view built around it. Ahead of the read-only rule: `tools_call_read` only
  // reads, but the read-only view lists every read it serves already.
  if (DISPATCH_TOOLS.includes(name)) {
    return view === COMPACT_VIEW
      ? admit('compact-view-listed')
      : withhold('dispatcher-compact-only');
  }

  if (view === COMPACT_VIEW) {
    // What a generic agent may not hold stays out of reach as on `/mcp`;
    // everything else is listed or dispatched, the packs `/mcp` leaves out
    // for its byte budget included.
    if (DEFAULT_FACET_EXCLUDED_TOOLS.includes(name)) {
      return withhold('default-view-excluded-tool');
    }
    if (isPasswordLogin) return admit('password-login-exposed');
    if (isBase) return admit('facet-base-tool');
    if (COMPACT_VIEW_TOOLS.includes(name)) return admit('compact-view-listed');
    return withhold('compact-view-dispatched');
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

  if (view === FULL_VIEW) {
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
    if (demotedGroupOf(name)) return withhold('default-view-demoted');
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
  FULL_VIEW,
  READONLY_VIEW,
  COMPACT_VIEW,
  ...FACET_NAMES,
];

/**
 * Whether a view's dispatcher (`tools_call_read`, `tools_call_write`,
 * `tools_call_destructive`) runs a tool: on the compact listing, every tool it
 * reaches without listing it; elsewhere nothing, since no other view lists the
 * dispatcher. A listed tool is called directly, so a host's allow, ask or deny
 * setting for it cannot be side-stepped through its tier's dispatcher. Never a
 * dispatcher tool itself.
 */
export function dispatchReaches(
  view: FacetKey,
  tool: FacetTool,
  options: FacetIndexOptions = {}
): boolean {
  if (DISPATCH_TOOLS.includes(tool.name)) return false;
  if (effectiveView(view, options) !== COMPACT_VIEW) return false;
  return decideView(view, tool, options).reason === 'compact-view-dispatched';
}

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

  const reach = new Map<FacetKey, readonly string[]>();
  const reachSets = new Map<FacetKey, ReadonlySet<string>>();
  for (const view of VIEW_KEYS) {
    const names = tools
      .filter((tool) => dispatchReaches(view, tool, options))
      .map((tool) => tool.name);
    reach.set(view, names);
    reachSets.set(view, new Set(names));
  }

  return {
    keys: VIEW_KEYS,
    members: (facet) => members.get(facet) ?? [],
    includes: (facet, toolName) => sets.get(facet)?.has(toolName) ?? false,
    facetsProviding: (toolName) =>
      FACET_NAMES.filter((facet) => sets.get(facet)?.has(toolName)),
    reachable: (facet) => reach.get(facet) ?? [],
    serves: (facet, toolName) =>
      (sets.get(facet)?.has(toolName) ?? false) ||
      (reachSets.get(facet)?.has(toolName) ?? false),
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
