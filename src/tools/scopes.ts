/**
 * Token scopes: what a tool's execution requires, and the gate that checks it.
 *
 * **Why this exists.** The v3 authorization RFC settled that the real access
 * boundary is the scope of the token, not the endpoint address and not the
 * tool annotations: MCP forbids clients from treating annotations as a
 * security decision, and a separate HTTP path only helps a deployment pick a
 * profile of rights — it does not restrict anything on its own. Today this
 * server has no boundary at all. The OAuth proxy already forwards the caller's
 * granted scopes as `x-mcp-auth-scope`, and until now nothing read it.
 *
 * **What this is, honestly.** Plumbing, not a live boundary. The scope names
 * below are PLACEHOLDERS: their shape follows the ratified v3 convention
 * (`domain:action`, snake_case domain taken from the resource name in the URL)
 * and most of them are copied verbatim from the v3 scope catalog, but the
 * catalog is explicitly not final and the API team owns the names. Renaming is
 * a one-file edit here, by design — no tool definition spells a scope out.
 *
 * **Three rules this file obeys.**
 *
 * 1. *Execution only.* The check runs in `tools/call` and nowhere else.
 *    `tools/list` must stay identical for every connection to one path
 *    (ADR-001 D7), so the tool list is never filtered by the caller's scopes.
 *    A tool a caller cannot execute is still listed, and says why when called.
 * 2. *No scopes declared means no restriction.* Every deployment today — the
 *    public HTTP endpoint, stdio, the closed Google-OIDC one — sends no
 *    `x-mcp-auth-scope`, so `getRequestScopes()` is `undefined` and the gate
 *    steps aside. It starts enforcing by itself the day tokens carry scopes.
 * 3. *The refusal is in-band.* It is an `isError` tool result, the same
 *    channel as the confirmation gate and `ExecutorRefusalError` — never an
 *    HTTP 403, which would drop the session, and never a protocol error the
 *    host may swallow before the model sees why.
 */
import type { ToolResult } from './tool-result.js';

// ==========================================================================
// Vocabulary (placeholder — pending approval by the API team)
// ==========================================================================

/**
 * Scope names taken verbatim from the v3 P0 scope catalog
 * (`biz.erp/docs/research/api-standardization/v3-plan/scope-catalog.md`,
 * status "обновлено 2026-09-01, не финал"). Only the ones this server's tools
 * actually need are listed; the catalog carries more (`visits:*`,
 * `payments:*`, `finance:read`, `loyalty:read`, `products:read`,
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
] as const;

/**
 * Names this server had to invent because the v3 P0 catalog has no domain for
 * them yet. They follow the same `domain:action` convention, and they are the
 * first thing to revisit when the API team publishes the final vocabulary.
 *
 * - `analytics:*` — the analytics pack reads `/company/{id}/analytics/**`,
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
 *   `POST|PUT|DELETE /company/{id}/services/{service_id}/staff…`, and the
 *   catalog notes staff bindings travel in the body of S3/S4.
 * - **`create_appointment` needs `appointments:create`, not
 *   `appointments:write`.** The catalog makes `create` an action-scope that is
 *   never implied by `write` (AP1 vs AP4–AP6).
 * - **`remove_location_user` needs `team_members:manage_access`** — the high-
 *   risk scope for T8–T12, never implied by `team_members:write` ("write
 *   карточки сотрудника ≠ раздача логинов").
 * - **`altegio_login` / `altegio_logout` are ungated.** They obtain the V1
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
 * - **`altegio_call_operation` is coarse.** One tool name reaches every
 *   documented GET, so it is mapped to the `api:read` placeholder: a caller
 *   scoped to `clients:read` alone is refused the executor outright rather
 *   than being handed a route around its own scope. The real fix is resolving
 *   the scope per catalog operation at call time, which needs the final
 *   vocabulary first.
 */
export const TOOL_SCOPES: Readonly<Record<string, ScopeRequirement>> = {
  // --- Auth: establishes the credential, so it cannot require one ----------
  altegio_login: null,
  altegio_logout: null,

  // --- Universal executor --------------------------------------------------
  // Catalog metadata only: these two describe the API, they never read
  // business data, and refusing them would break discovery for every caller.
  altegio_search_operations: null,
  altegio_describe_operation: null,
  altegio_call_operation: 'api:read',

  // --- Location and its settings -------------------------------------------
  list_locations: 'locations:read',
  update_location: 'locations:write',
  get_appointment_settings: 'locations:read',
  update_appointment_settings: 'locations:write',
  get_online_booking_settings: 'locations:read',
  update_online_booking_settings: 'locations:write',
  get_booking_forms: 'locations:read',
  create_booking_form: 'locations:write',
  delete_booking_form: 'locations:write',
  get_resources: 'locations:read',

  // --- Team members, positions, schedules ----------------------------------
  get_staff: 'team_members:read',
  create_staff: 'team_members:write',
  update_staff: 'team_members:write',
  delete_staff: 'team_members:write',
  get_positions: 'team_members:read',
  create_position: 'team_members:write',
  get_schedule: 'team_members:read',
  create_schedule: 'team_members:write',
  update_schedule: 'team_members:write',
  delete_schedule: 'team_members:write',

  // --- Access management (dangerous, never implied by team_members:write) ---
  remove_location_user: 'team_members:manage_access',

  // --- Services and categories ---------------------------------------------
  get_services: 'services:read',
  create_service: 'services:write',
  update_service: 'services:write',
  delete_service: 'services:write',
  link_service_team_member: 'services:write',
  link_team_member_services: 'services:write',
  update_service_team_member: 'services:write',
  unlink_service_team_member: 'services:write',
  get_service_categories: 'services:read',
  delete_service_category: 'services:write',

  // --- Appointments ---------------------------------------------------------
  get_appointments: 'appointments:read',
  create_appointment: 'appointments:create',
  update_appointment: 'appointments:write',
  delete_appointment: 'appointments:write',

  // --- Client base ----------------------------------------------------------
  clients_search: 'clients:read',
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
  analytics_get_team_member_occupancy: 'analytics:read',
  analytics_get_client_visit_stats: 'analytics:read',
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
  onboarding_add_staff_batch: 'team_members:write',
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
// Satisfaction
// ==========================================================================

/**
 * Whether a granted set satisfies one required scope.
 *
 * Implements exactly one implication, the one the v3 catalog ratified
 * (decision A8/F-13): **`X:write` covers `X:read`** for the same domain, so a
 * grant of `clients:write` is also a grant of `clients:read`. Nothing else is
 * implied, and the catalog is explicit about why:
 *
 *  - `read_contact` is a separate axis of sensitivity — `clients:write` does
 *    not let you see a phone number;
 *  - the action-scopes `create`, `capture`, `refund` and `manage_access` need
 *    an explicit grant, so `appointments:write` does not cover
 *    `appointments:create`, and `team_members:write` does not cover
 *    `team_members:manage_access`;
 *  - the level is part of the domain name, so `chain_services:write` cannot
 *    satisfy `services:read` — they are simply different domains here.
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
  return action === 'read' && granted.has(`${domain}:write`);
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
 * Enforce one tool's scope requirement for the current request.
 *
 * Returns `undefined` when the call may proceed — which includes every caller
 * that declares no scopes at all — or the `isError` result to return instead
 * of executing the tool.
 */
export function checkToolScopes(options: {
  readonly toolName: string;
  readonly required: readonly ToolScope[];
  /** Granted scopes, or `undefined` when the caller declared none. */
  readonly granted: ReadonlySet<string> | undefined;
}): ToolResult | undefined {
  const { toolName, required, granted } = options;
  if (granted === undefined || required.length === 0) return undefined;

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
