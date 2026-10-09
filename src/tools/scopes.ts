/**
 * Token scopes: what a tool's execution requires, and the gate that checks it.
 *
 * **Why this exists.** The v3 authorization RFC settled that the real access
 * boundary is the scope of the token, not the endpoint address and not the
 * tool annotations: MCP forbids clients from treating annotations as a
 * security decision, and a separate HTTP path only helps a deployment pick a
 * profile of rights — it does not restrict anything on its own. The OAuth
 * proxy already forwards the caller's granted scopes as `x-mcp-auth-scope` on
 * every `forward_identity` route, and until this file existed nothing read
 * it.
 *
 * **What this is, honestly.** Plumbing, not a live boundary. The scope names
 * below are PLACEHOLDERS: their shape follows the ratified v3 convention
 * (`domain:action`, snake_case domain taken from the resource name in the URL)
 * and most of them are copied verbatim from the v3 scope catalog, but the
 * catalog is explicitly not final and the API team owns the names. Renaming is
 * a one-file edit here, by design — no tool definition spells a scope out.
 *
 * **Two vocabularies live here.** Requirements are written in the v3
 * `domain:action` names; the grants that actually arrive are the platform's
 * `mcp:pro:read` / `mcp:pro:write`, issued by the OAuth proxy today. The rule
 * for reconciling them is stated once, under "Satisfaction" below, and nowhere
 * else.
 *
 * **Three rules this file obeys.**
 *
 * 1. *Execution only.* The check runs in `tools/call` and nowhere else.
 *    `tools/list` must stay identical for every connection to one path
 *    (ADR-001 D7), so the tool list is never filtered by the caller's scopes.
 *    A tool a caller cannot execute is still listed, and says why when called.
 * 2. *Declared scopes fail closed.* A caller that declares no scopes at all —
 *    local stdio — passes through for compatibility. Once the trusted proxy
 *    sends a scope header, an empty, malformed or unknown grant authorises
 *    nothing; vocabulary drift is an operator error, never wider access.
 * 3. *The refusal is in-band.* It is an `isError` tool result, the same
 *    channel as the confirmation gate and `ExecutorRefusalError` — never an
 *    HTTP 403, which would drop the session, and never a protocol error the
 *    host may swallow before the model sees why.
 */
import { logger } from '../utils/logger.js';
import type { ToolResult } from './tool-result.js';

// ==========================================================================
// Vocabulary (placeholder — pending approval by the API team)
// ==========================================================================

/**
 * Scope names taken verbatim from the API team's v3 P0 scope catalog (a draft
 * dated 2026-09-01, explicitly not final). Only the ones this server's tools
 * actually need are listed; the catalog carries more (`visits:*`,
 * `payments:*`, `finance:read`,
 * `availability:read`, `locations:create`, the four `chain_*` names) and they
 * are deliberately absent until a tool needs one.
 */
const V3_CATALOG_SCOPES = [
  'locations:read',
  'locations:write',
  'team_members:read',
  'team_members:write',
  'team_members:manage_access',
  'services:read',
  'services:write',
  'clients:read',
  'clients:write',
  'appointments:read',
  'appointments:create',
  'appointments:write',
  'loyalty:read',
  'products:read',
  'chain_loyalty:read',
  'chain_loyalty:configure',
  'chain_loyalty:transact',
] as const;

/**
 * Names this server had to invent because the v3 P0 catalog has no domain for
 * them yet. They follow the same `domain:action` convention, and they are the
 * first thing to revisit when the API team publishes the final vocabulary.
 *
 * - `analytics:*` — the analytics pack reads `/locations/{id}/analytics/**`,
 *   which is out of the P0 slice entirely. Some of it is money-shaped (the
 *   day-end report, loyalty results) and may well end up behind `finance:read`
 *   or a split of it; mapping it onto `finance:read` today would be worse than
 *   an honest placeholder, because that name means "cash registers and
 *   financial accounts" (PM2), not "reports".
 * - `api:read` — the universal executor reaches every documented GET across
 *   every domain under ONE tool name, so no per-domain scope can describe it.
 *   See `TOOL_SCOPES` for why it is mapped coarsely and what closes the gap.
 */
const LOCAL_PLACEHOLDER_SCOPES = [
  'analytics:read',
  'analytics:write',
  'api:read',
] as const;

export const KNOWN_SCOPES = [
  ...V3_CATALOG_SCOPES,
  ...LOCAL_PLACEHOLDER_SCOPES,
] as const;

export type ToolScope = (typeof KNOWN_SCOPES)[number];

/** Scope names that are NOT from the v3 catalog — surfaced for the PR/tests. */
export const PLACEHOLDER_ONLY_SCOPES: readonly ToolScope[] =
  LOCAL_PLACEHOLDER_SCOPES;

// ==========================================================================
// The platform vocabulary (the one that actually arrives)
// ==========================================================================

/**
 * The scope names the OAuth proxy really issues for this server today.
 *
 * Observed end to end through the OAuth proxy in front of this server: every
 * route that reaches this service is declared with the pair
 * `mcp:pro:read` / `mcp:pro:write` — the staff lane (Google OIDC, identity
 * forwarded) and the customer lane (Altegio identity provider); the read-only
 * views declare `mcp:pro:read` alone. The proxy filters a token's requested
 * scope down to the route's declared list and forwards the surviving value as
 * the `x-mcp-auth-scope` header (the customer lane forwards the OAuth
 * session's grant, or the route's own list for a raw Altegio user token). The
 * literal string arriving at `tools/call` is therefore
 * `"mcp:pro:read mcp:pro:write"` — or `"mcp:pro:read"` alone when the token
 * was granted read only.
 *
 * This vocabulary is coarse by construction: one pair of grades per *service*,
 * because a route's scope list is service-wide and the consent screen is
 * all-or-nothing (ADR-001 D6). It is also temporary — it disappears the day
 * Altegio v3 issues tokens in the `domain:action` vocabulary above, and this
 * section is deleted with it.
 */
const PLATFORM_SCOPE_READ = 'mcp:pro:read';
const PLATFORM_SCOPE_WRITE = 'mcp:pro:write';

/** The full platform vocabulary for this service, in ascending order of power. */
export const PLATFORM_SCOPES: readonly string[] = Object.freeze([
  PLATFORM_SCOPE_READ,
  PLATFORM_SCOPE_WRITE,
]);

const PLATFORM_SCOPE_SET: ReadonlySet<string> = new Set(PLATFORM_SCOPES);

/**
 * The v3 domains this server reasons about — derived from `KNOWN_SCOPES`, so a
 * new requirement widens it automatically. Used only for recognition (is this
 * name one of ours?), never for satisfaction.
 */
const KNOWN_V3_DOMAINS: ReadonlySet<string> = new Set(
  KNOWN_SCOPES.map((scope) => scope.slice(0, scope.lastIndexOf(':')))
);

// ==========================================================================
// The map: tool -> required scope(s)
// ==========================================================================

/**
 * What one tool's execution requires. `null` means "no scope gates this tool";
 * an array means every listed scope must be present (a composite tool that
 * writes across domains is only as safe as its widest reach).
 */
type ScopeRequirement = ToolScope | readonly ToolScope[] | null;

/**
 * **The single place tool permissions are declared.**
 *
 * Every tool this server can execute appears exactly once, disabled ones
 * included (`scopes.test.ts` fails the build on a missing or unknown entry, so
 * a new tool cannot reach production unmapped). No tool definition names a
 * scope: `defineTool` fills `ToolDefinition.requiredScopes` from here by tool
 * name, so renaming a scope is an edit in this file and nowhere else.
 *
 * Mapping decisions worth knowing:
 *
 * - **Positions and schedules are team-member writes.** The v3 catalog puts
 *   PO1–PO5 and T6/T7 under `team_members:read`/`team_members:write` and says
 *   explicitly that no `positions:*` scope is created — positions are a
 *   dictionary of the team-member domain.
 * - **Resources are location reads** (catalog R1: "ресурсы = инвентарь
 *   локации, отдельный scope не заводим"), and so are the settings tools:
 *   appointment defaults, online-booking settings and booking forms are all
 *   location settings (L1/L2).
 * - **Service ↔ team-member links are service writes.** All four go to
 *   `POST|PUT|DELETE /locations/{id}/services/{service_id}/team_members…`, and the
 *   catalog notes staff bindings travel in the body of S3/S4.
 * - **`appointments_create` needs `appointments:create`, not
 *   `appointments:write`.** The catalog makes `create` an action-scope that is
 *   never implied by `write` (AP1 vs AP4–AP6).
 * - **`locations_remove_user` needs `team_members:manage_access`** — the high-
 *   risk scope for T8–T12, never implied by `team_members:write` ("write
 *   карточки сотрудника ≠ раздача логинов").
 * - **`auth_login` / `auth_logout` are ungated.** They obtain the V1
 *   user token itself; gating the act of authenticating on a scope the token
 *   would have to already carry is circular. They are withheld from the public
 *   HTTP surface by `PASSWORD_LOGIN_TOOLS` instead.
 * - **The onboarding wizard's local-state tools are ungated** — start, resume,
 *   status and preview touch the checkpoint file and the caller's own pasted
 *   text, never the Altegio API.
 *
 * Two gaps this map cannot close, recorded rather than hidden:
 *
 * - **`clients:read_contact` is not expressed.** In v3 it gates *fields*
 *   (phone, email) inside a response, not the endpoint, and V1 has no such
 *   redaction — so a caller with `clients:read` still sees whatever V1
 *   returns. Enforcing it as an endpoint scope would over-restrict; pretending
 *   it is enforced would be worse. It belongs to the V3 adapter work.
 * - **`api_call_operation` is coarse.** One tool name reaches every
 *   documented GET, so it is mapped to the `api:read` placeholder: a caller
 *   scoped to `clients:read` alone is refused the executor outright rather
 *   than being handed a route around its own scope. The real fix is resolving
 *   the scope per catalog operation at call time, which needs the final
 *   vocabulary first.
 */
export const TOOL_SCOPES: Readonly<Record<string, ScopeRequirement>> = {
  // --- Auth: establishes the credential, so it cannot require one ----------
  auth_login: null,
  auth_logout: null,

  // --- Universal executor --------------------------------------------------
  // Catalog metadata only: these two describe the API, they never read
  // business data, and refusing them would break discovery for every caller.
  api_search_operations: null,
  api_describe_operation: null,
  api_call_operation: 'api:read',

  // --- The caller's own profile ---------------------------------------------
  // Reads nothing but the identity the credential already proves; a v3 scope
  // for "self" does not exist, and refusing it would leave a host unable to
  // learn the person's interface language on a narrowly granted token.
  users_get_current: null,

  // --- Location and its settings -------------------------------------------
  locations_list: 'locations:read',
  locations_diagnose_access: 'locations:read',
  locations_update: 'locations:write',
  settings_get_appointment_calendar: 'locations:read',
  settings_update_appointment_calendar: 'locations:write',
  settings_get_online_booking: 'locations:read',
  settings_update_online_booking: 'locations:write',
  booking_forms_list: 'locations:read',
  booking_forms_create: 'locations:write',
  booking_forms_delete: 'locations:write',
  resources_list: 'locations:read',

  // --- Team members, positions, schedules ----------------------------------
  team_members_list: 'team_members:read',
  team_members_create: 'team_members:write',
  team_members_update: 'team_members:write',
  team_members_delete: 'team_members:write',
  positions_list: 'team_members:read',
  positions_create: 'team_members:write',
  schedules_get: 'team_members:read',
  schedules_create: 'team_members:write',
  schedules_update: 'team_members:write',
  schedules_delete: 'team_members:write',

  // --- Access management (dangerous, never implied by team_members:write) ---
  locations_remove_user: 'team_members:manage_access',

  // --- Services and categories ---------------------------------------------
  services_list: 'services:read',
  services_create: 'services:write',
  services_update: 'services:write',
  services_delete: 'services:write',
  services_link_team_member: 'services:write',
  team_members_link_services: 'services:write',
  services_update_team_member_link: 'services:write',
  services_unlink_team_member: 'services:write',
  service_categories_list: 'services:read',
  service_categories_delete: 'services:write',

  // --- Appointments ---------------------------------------------------------
  appointments_list: 'appointments:read',
  appointments_preview_attendance: 'appointments:read',
  appointments_apply_attendance: 'appointments:write',
  appointments_create: 'appointments:create',
  appointments_update: 'appointments:write',
  appointments_delete: 'appointments:write',
  appointments_list_tags: 'appointments:read',
  appointments_create_tag: 'appointments:write',

  // --- Group events ---------------------------------------------------------
  // The v3 P0 catalog has no events domain. An event is a timetable slot
  // clients book appointments into, so it rides on the appointments scopes:
  // reading and managing events is `appointments:read` / `:write`, and booking
  // clients creates appointments, which needs the explicit `:create` grant.
  // Duplicating an event can copy its bookings, so it needs both.
  events_list: 'appointments:read',
  events_get: 'appointments:read',
  events_list_dates: 'appointments:read',
  events_list_services: 'appointments:read',
  events_list_duplication_strategies: 'appointments:read',
  events_create: 'appointments:write',
  events_update: 'appointments:write',
  events_delete: 'appointments:write',
  events_duplicate: ['appointments:write', 'appointments:create'],
  events_create_duplication_strategy: 'appointments:write',
  events_update_duplication_strategy: 'appointments:write',
  events_delete_duplication_strategy: 'appointments:write',
  events_book_clients: 'appointments:create',
  events_update_appointment: 'appointments:write',
  events_reschedule_appointment: 'appointments:write',

  // --- Memberships -----------------------------------------------------------
  // Membership types and sold memberships belong to a chain, and the v3
  // catalog keeps chain grants apart from location ones: reading them is
  // `chain_loyalty:read`, the types are `chain_loyalty:configure`, and
  // freezing or correcting a sold membership's validity or balance is
  // `chain_loyalty:transact` ("ручные операции, правка баланса и срока"). One
  // client's memberships are found through a location client card, so that
  // read needs the location scopes instead.
  memberships_list_chains: 'chain_loyalty:read',
  memberships_list_types: 'chain_loyalty:read',
  memberships_get_type: 'chain_loyalty:read',
  memberships_list: 'chain_loyalty:read',
  memberships_list_for_client: ['clients:read', 'loyalty:read'],
  memberships_create_type: 'chain_loyalty:configure',
  memberships_update_type: 'chain_loyalty:configure',
  memberships_archive_type: 'chain_loyalty:configure',
  memberships_delete_type: 'chain_loyalty:configure',
  memberships_freeze: 'chain_loyalty:transact',
  memberships_unfreeze: 'chain_loyalty:transact',
  memberships_set_balance: 'chain_loyalty:transact',
  memberships_set_validity: 'chain_loyalty:transact',

  // --- Client base ----------------------------------------------------------
  clients_search: 'clients:read',
  clients_get_membership_purchases: [
    'clients:read',
    'loyalty:read',
    'products:read',
  ],
  clients_list_comments: 'clients:read',
  clients_add_comment: 'clients:write',
  clients_list_files: 'clients:read',
  clients_upload_file: 'clients:write',
  clients_get_segment_report: 'clients:read',
  clients_list_profiles: 'clients:read',
  clients_get_card: 'clients:read',
  clients_get_visit_history: 'clients:read',
  clients_lookup: 'clients:read',
  clients_delete: 'clients:write',

  // --- Analytics (placeholder domain; six of these are disabled today) ------
  analytics_get_overview: 'analytics:read',
  analytics_get_daily_series: 'analytics:read',
  analytics_get_appointments_breakdown: 'analytics:read',
  analytics_get_receptionist_performance: 'analytics:read',
  analytics_get_loyalty_program_results: 'analytics:read',
  analytics_get_forecast: 'analytics:read',
  analytics_get_day_end_report: 'analytics:read',
  analytics_get_daily_summary: 'analytics:read',
  analytics_get_team_workload: 'team_members:read',
  analytics_get_team_member_occupancy: 'analytics:read',
  analytics_get_client_visit_stats: 'analytics:read',
  analytics_get_client_sales: 'analytics:read',
  analytics_get_client_retention: 'analytics:read',
  analytics_get_client_forecast: 'analytics:read',
  analytics_get_service_profitability: 'analytics:read',
  analytics_get_service_mix_trend: 'analytics:read',
  analytics_get_client_service_penetration: 'analytics:read',
  analytics_get_team_member_sales: 'analytics:read',
  analytics_get_team_member_capacity: 'analytics:read',
  analytics_get_client_reactivation_candidates: 'analytics:read',
  analytics_get_group_event_performance: 'analytics:read',
  analytics_get_product_sales: 'analytics:read',
  analytics_get_cash_flow_breakdown: 'analytics:read',
  analytics_get_profit_and_loss_statement: 'analytics:read',
  analytics_get_client_cash_receipts: 'analytics:read',
  analytics_get_client_payer_cohorts: 'analytics:read',
  analytics_get_capacity_heatmap: 'analytics:read',
  analytics_get_revenue_leakage: 'analytics:read',
  analytics_get_team_member_service_matrix: 'analytics:read',
  analytics_get_inventory_reorder_risks: 'analytics:read',
  analytics_list_report_templates: 'analytics:read',
  analytics_list_report_fields: 'analytics:read',
  analytics_run_report: 'analytics:read',
  analytics_list_saved_reports: 'analytics:read',
  analytics_run_saved_report: 'analytics:read',
  analytics_delete_assistant_report: 'analytics:write',

  // --- Onboarding wizard ----------------------------------------------------
  onboarding_start: null,
  onboarding_resume: null,
  onboarding_status: null,
  onboarding_preview_data: null,
  onboarding_add_positions: 'team_members:write',
  onboarding_add_team_members_batch: 'team_members:write',
  onboarding_set_schedules: 'team_members:write',
  onboarding_add_categories: 'services:write',
  onboarding_add_services_batch: 'services:write',
  onboarding_import_clients: 'clients:write',
  onboarding_create_test_appointments: 'appointments:create',
  // Rollback deletes whatever the named phase created, across four domains.
  // A composite destructive tool requires every scope it can reach: being
  // over-strict here costs a caller one extra grant, being under-strict would
  // let a services-only token delete imported clients.
  onboarding_rollback_phase: [
    'team_members:write',
    'services:write',
    'clients:write',
    'appointments:write',
  ],
};

const NO_SCOPES: readonly ToolScope[] = Object.freeze([]);

/**
 * The scopes a tool's execution requires, `[]` when nothing gates it.
 *
 * A tool absent from the map also returns `[]` — deliberately permissive at
 * runtime, because the coverage test already makes an unmapped tool a build
 * failure, and failing closed on an unknown name would turn a forgotten map
 * entry into a production outage instead of a red pipeline.
 */
export function requiredScopesFor(toolName: string): readonly ToolScope[] {
  const requirement = TOOL_SCOPES[toolName];
  if (requirement == null) return NO_SCOPES;
  return typeof requirement === 'string' ? [requirement] : requirement;
}

// ==========================================================================
// Satisfaction: two vocabularies, one rule, stated here and nowhere else
// ==========================================================================

/**
 * Whether a granted set satisfies one required scope.
 *
 * **The coexistence rule.** Requirements in `TOOL_SCOPES` are written in the
 * *v3* vocabulary (`domain:action`), which no token carries yet. Grants
 * arriving on `x-mcp-auth-scope` are written in the *platform* vocabulary
 * (`mcp:pro:read` / `mcp:pro:write`), which is the only thing issued today.
 * Both are read here; a name belonging to neither grants nothing, and — when
 * the whole grant is of that kind — imposes nothing either
 * (`grantIsRecognised`).
 *
 * **v3 — the target vocabulary, not yet issued.** Exactly one implication, the
 * one the catalog ratified (decision A8/F-13): **`X:write` covers `X:read`**
 * for the same domain, so a grant of `clients:write` is also a grant of
 * `clients:read`. Nothing else is implied, and the catalog is explicit why:
 *
 *  - `read_contact` is a separate axis of sensitivity — `clients:write` does
 *    not let you see a phone number;
 *  - the action-scopes `create`, `capture`, `refund` and `manage_access` need
 *    an explicit grant, so `appointments:write` does not cover
 *    `appointments:create`, and `team_members:write` does not cover
 *    `team_members:manage_access`;
 *  - the level is part of the domain name, so `chain_services:write` cannot
 *    satisfy `services:read` — they are simply different domains here.
 *
 * **Platform — temporary, coarse, and the only live input.**
 * `mcp:pro:read` satisfies a requirement whose action is `read`, and nothing
 * else. `mcp:pro:write` satisfies **every** requirement, action-scopes
 * included.
 *
 * *Why `mcp:pro:write` covers `appointments:create`, `analytics:write` and
 * `team_members:manage_access`, which v3 deliberately keeps out of `:write`.*
 * The v3 split is meaningful because a v3 token can express it: a caller may
 * hold `appointments:write` and be denied `appointments:create`. The platform
 * vocabulary cannot express it — there are two grades for the entire service
 * and no third grant anyone can be issued. Refusing to imply the action-scopes
 * would therefore not be strictness, it would be a permanently dead tool:
 * `appointments_create` and `onboarding_create_test_appointments` would be
 * unreachable for every caller on every address, forever — the same failure
 * this rule exists to undo, only narrower. The consent a user actually gave
 * for `mcp:pro:write` reads "bookings, staff, clients and services (read and
 * write)", a full change grant on the service, which is precisely what
 * creating an appointment is. `manage_access` is the uncomfortable member and
 * is admitted with open eyes: `locations_remove_user` is already withheld from
 * the default `/mcp` view and reachable only where a deployment chose to serve
 * it, so the narrowing that matters for it is the address, not this rule. When
 * v3 issues tokens that carry the fine distinction, this branch stops being
 * consulted — the grant will be in the vocabulary above.
 */
export function scopeSatisfied(
  granted: ReadonlySet<string>,
  required: ToolScope
): boolean {
  if (granted.has(required)) return true;

  const separator = required.lastIndexOf(':');
  if (separator <= 0) return false;
  const domain = required.slice(0, separator);
  const action = required.slice(separator + 1);

  // v3 vocabulary: the single ratified implication.
  if (action === 'read' && granted.has(`${domain}:write`)) return true;

  // Platform vocabulary: one grade for the whole service.
  if (granted.has(PLATFORM_SCOPE_WRITE)) return true;
  if (action === 'read' && granted.has(PLATFORM_SCOPE_READ)) return true;

  return false;
}

/** Whether one granted name belongs to a vocabulary this file can reason about. */
function isRecognisedScope(scope: string): boolean {
  if (PLATFORM_SCOPE_SET.has(scope)) return true;
  const separator = scope.lastIndexOf(':');
  if (separator <= 0) return false;
  return KNOWN_V3_DOMAINS.has(scope.slice(0, separator));
}

/**
 * Whether the granted set speaks a vocabulary this server can act on.
 *
 * `false` means the token carries no scope this build can map. The execution
 * gate refuses such a grant. The proxy already enforces audience and strips
 * client-supplied identity headers, so an unknown vocabulary indicates
 * deployment drift; operators must update this map before rollout.
 */
export function grantIsRecognised(granted: ReadonlySet<string>): boolean {
  for (const scope of granted) {
    if (isRecognisedScope(scope)) return true;
  }
  return false;
}

/** Required scopes the granted set does not cover, in declaration order. */
export function missingScopes(
  granted: ReadonlySet<string>,
  required: readonly ToolScope[]
): ToolScope[] {
  return required.filter((scope) => !scopeSatisfied(granted, scope));
}

// ==========================================================================
// The gate
// ==========================================================================

/** How many granted scopes the refusal text lists before summarising. */
const MAX_LISTED_GRANTS = 12;

function formatGranted(granted: ReadonlySet<string>): string {
  const all = [...granted].sort();
  if (all.length === 0) return 'nothing';
  if (all.length <= MAX_LISTED_GRANTS) return all.join(', ');
  const shown = all.slice(0, MAX_LISTED_GRANTS).join(', ');
  return `${shown} (+${all.length - MAX_LISTED_GRANTS} more)`;
}

/**
 * The refusal a caller reads when its token is too narrow.
 *
 * Every word is ours. The upstream API is never reached on this path, so there
 * is no Altegio error text to pass through — the rule from the untrusted-data
 * work holds trivially here. The granted names come from the proxy's own
 * header and are validated against the OAuth scope-token grammar before they
 * are stored, so echoing them back cannot smuggle markup into the result.
 *
 * It has to be actionable, and "try again" is not an action: hosts do not
 * re-authorise on a mid-session denial (Claude Code closed that issue as "not
 * planned" in April 2026), so a step-up does not exist to point at. What is
 * left that actually works is a person widening the grant and reconnecting —
 * so that is what the text says, together with the advice not to retry.
 */
export function scopeRefusalMessage(
  toolName: string,
  missing: readonly ToolScope[],
  granted: ReadonlySet<string>
): string {
  const plural = missing.length === 1 ? '' : 's';
  return [
    `Nothing was done: this connection is not authorised to run ${toolName}.`,
    ``,
    `Missing permission${plural}: ${missing.join(', ')}.`,
    `This connection currently has: ${formatGranted(granted)}.`,
    ``,
    `Do not retry — the answer will not change within this session, and this ` +
      `server cannot ask for a wider token. To get the operation done, the ` +
      `person who connected this integration has to re-authorise it with the ` +
      `missing permission${plural} and reconnect. Until then, keep to the ` +
      `tools covered by the permissions listed above, and tell them plainly ` +
      `which permission${plural} the task needs.`,
  ].join('\n');
}

/**
 * Grants already reported as unrecognised, so the warning below fires once per
 * distinct grant instead of once per tool call. Bounded: the key is built from
 * validated scope tokens, but nothing upstream promises a small alphabet.
 */
const warnedUnrecognisedGrants = new Set<string>();
const MAX_WARNED_GRANTS = 32;

function warnUnrecognisedGrantOnce(granted: ReadonlySet<string>): void {
  const key = [...granted].sort().join(' ');
  if (warnedUnrecognisedGrants.has(key)) return;
  if (warnedUnrecognisedGrants.size >= MAX_WARNED_GRANTS) {
    warnedUnrecognisedGrants.clear();
  }
  warnedUnrecognisedGrants.add(key);
  logger.warn(
    { grantedCount: granted.size },
    'x-mcp-auth-scope carries no vocabulary this build knows; ' +
      'scope enforcement will refuse gated calls'
  );
}

/**
 * Enforce one tool's scope requirement for the current request.
 *
 * Returns `undefined` when the call may proceed. An absent grant remains the
 * local/stdio compatibility path; once a proxy declares a grant, an empty,
 * malformed or unknown vocabulary fails closed.
 */
export function checkToolScopes(options: {
  readonly toolName: string;
  readonly required: readonly ToolScope[];
  /** Granted scopes, or `undefined` when the caller declared none. */
  readonly granted: ReadonlySet<string> | undefined;
}): ToolResult | undefined {
  const { toolName, required, granted } = options;
  if (granted === undefined || required.length === 0) return undefined;

  // Warn once for diagnostics, but fail closed below. The proxy strips
  // client-supplied auth headers and forwards a vocabulary this build knows;
  // an unknown non-empty grant is therefore configuration drift, not a caller
  // that should silently become unrestricted.
  if (granted.size > 0 && !grantIsRecognised(granted)) {
    warnUnrecognisedGrantOnce(granted);
  }

  const missing = missingScopes(granted, required);
  if (missing.length === 0) return undefined;

  return {
    content: [
      {
        type: 'text' as const,
        text: scopeRefusalMessage(toolName, missing, granted),
      },
    ],
    isError: true,
  };
}
