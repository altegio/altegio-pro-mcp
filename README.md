# Altegio.Pro MCP Server

> Official MCP server by [Altegio](https://github.com/altegio) organization

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-green)](https://modelcontextprotocol.io)

MCP server for Altegio.Pro business management API - B2B integration for salon/spa owners and administrators.

**Target users:** Business owners managing their Altegio locations
**Authentication:** public HTTP uses Altegio OAuth; local stdio can use `altegio_login` or a pre-seeded user token
**Focus:** Administrative B2B operations only (no public booking features)

## Features

- **95 tools served (101 defined, 6 withheld from every view)** — including a 28-tool analytics pack, a 3-tool API explorer and 12 onboarding wizard tools for first-time setup
- **Administrative writes** for staff, services, appointments, schedules, clients, categories, booking forms, and location users
- **Analytics**: key metrics, profit-and-loss and cash-flow views, capacity heatmaps, revenue leakage, team-member × service analysis, product/inventory decisions, retention, forecasts and day-end reporting
- **Location settings**: appointment calendar, online booking, booking forms, resources
- **Universal API executor**: search, describe and call any of the 317 documented API operations, even the ones without a dedicated tool
- **Conversational onboarding** with bulk CSV/JSON import and automatic checkpoint/resume
- **Dual transport:** stdio for Claude Desktop, HTTP for cloud deployments
- **TypeScript** with full type safety and comprehensive automated tests
- **Auto-deploy CI/CD** via VM cron (git pull + docker compose rebuild every 2 min)
- **Rate limiting** and **retry logic** with exponential backoff
- **Secure credential storage** in `~/.altegio-mcp/`

## Available Tools

**95 tools served (101 defined, 6 withheld from every view)**, organized by category
for complete business management. Which of them a given address serves, and why,
is the generated table in
[`docs/architecture/tool-surface.md`](docs/architecture/tool-surface.md).

### 🔐 Authentication
- `altegio_login` - Authenticate with email/password
- `altegio_logout` - Clear stored credentials

### 🏢 Location Management
- `list_locations` - Get managed locations (requires auth)
- `update_location` - Rename or change a location's address, city, contacts, coordinates, or business type
- `diagnose_location_access` - Diagnose the current user's location access and effective rights after a 403

### 👥 Staff Management
- `get_staff` - View staff members with admin details
- `create_staff` - Add new staff member
- `update_staff` - Modify staff member details
- `delete_staff` - Remove staff member

### 📋 Positions Management
- `get_positions` - List location positions/roles
- `create_position` - Create new position (Manager, Stylist, etc.)

The documented public V1 API only supports listing and quick creation. Position
update/delete are intentionally not exposed; internal V2 routes are out of scope.

### 🛎️ Services Management
- `get_services` - View all services with configuration
- `get_service_categories` - View service categories
- `create_service` - Add new service
- `update_service` - Modify service details
- `delete_service` - Permanently delete a service
- `link_service_team_member` - Link a team member to a service so they can perform it (required before booking that service)
- `update_service_team_member` - Change a team member's session length / tech card for a service
- `unlink_service_team_member` - Remove a team member ↔ service link
- `link_team_member_services` - Bulk-link one team member to many services at once
- `delete_service_category` - Permanently delete a service category

### 📅 Schedule Management
- `get_schedule` - View staff member work schedules
- `create_schedule` - Set staff member work hours
- `update_schedule` - Modify work schedule
- `delete_schedule` - Remove schedule entry

### 📖 Appointments Management
- `get_appointments` - View appointments
- `create_appointment` - Create client appointment
- `update_appointment` - Modify existing appointment
- `delete_appointment` - Cancel appointment
- `appointments_attendance_preview` / `appointments_attendance_apply` - Preview up to 20 attendance changes, then apply by visit group with human confirmation; linked appointments may change and earlier groups cannot be rolled back after failure

### ⚙️ Location Settings
- `get_appointment_settings` / `update_appointment_settings` - Appointment calendar defaults (record type, group capacity)
- `get_online_booking_settings` / `update_online_booking_settings` - Online booking behavior
- `get_booking_forms` / `create_booking_form` / `delete_booking_form` - Online booking widgets

### 👤 Clients and Location Access
- `clients_search`, `clients_get_segment_report`, `clients_list_profiles`, `clients_get_card`, `clients_get_visit_history`, `clients_lookup` - Search, report on and inspect the client base
- `clients_delete` - Permanently delete a client
- `clients_get_membership_purchases` - Verify membership identity and linked sale evidence; sale date and nominal value are conditional, paid amount is null without item attribution
- `clients_list_comments` / `clients_add_comment` - Read or add client card text comments, including form URLs as text
- `clients_list_files` - Read uploaded file metadata and download links
- `clients_upload_file` - Attach one completed file to a client card using raw base64 bytes in an MCP tool call (strictly below 12 MiB)
- `remove_location_user` - Revoke a user's access to one location; requires the user ID twice as an explicit safeguard

### 🪑 Resources
- `get_resources` - List cabinets/equipment (read-only; API has no create)

### 🧭 API Explorer (universal executor)

Three tools cover the **whole documented Altegio API** — 320 operations — so a
question that no dedicated tool answers is still answerable, the day the spec
changes and before anyone curates a tool for it. They are backed by
[`src/generated/catalog.json`](docs/architecture/catalog.md), built from the
corporate OpenAPI specs, so they make no spec or network lookups of their own.

- `altegio_search_operations` - Find the operations behind a business question
  ("loyalty card balance", "cash register shifts"). Returns up to 10 operations
  with `operationId`, method, canonical path, summary and domain, and names the
  curated tool when one already exists — **prefer that tool**. Filters: `domain`,
  `method`, `include_preview` (V3 contract), `limit`.
- `altegio_describe_operation` - The full contract of one operation: parameters
  with types and requiredness, request body, response shape, auth requirement,
  deprecation, spec source, and which legacy parameter names are accepted under
  canonical ones (`staff_id` is accepted as `team_member_id`).
- `altegio_call_operation` - Execute a documented **read**. Canonical parameter
  names are accepted (`location_id`, `team_member_id`, `appointment_id`,
  `product_id`), required parameters are validated against the catalog, and the
  result comes back projected and inside a ~4k-token budget with a
  "narrow the query" hint when it had to be truncated.

**Reads only.** A `POST`, `PUT`, `PATCH` or `DELETE` operation is refused with a
pointer to the curated tool: writes go through the curated surface, and executor
writes require the allowlist from [ADR-001](docs/architecture/2026-09-07-mcp-platform-architecture.md)
D2. V3 preview operations are described but not callable — the live API does not
serve them yet. A delegated Altegio identity, direct user token or local
`altegio_login` session is required.
### 📊 Analytics
**Read-only reporting for one location.** Every tool takes `location_id` first and
either a `period` preset (`today`, `yesterday`, `this_week`, `last_week`,
`this_month`, `last_month`, `last_30_days`, `this_quarter`, `last_quarter`,
`this_year`) or an explicit `date_from` + `date_to` pair in `YYYY-MM-DD`. Presets
resolve in the location's own timezone, ranges over 365 days are refused before
the call, and amounts come back in major units with a source currency label or code.

- `analytics_get_overview` - Key metrics with a comparison to the previous period of equal length: revenue (total, services, products), average check, occupancy, appointments by outcome, and new / returning / active / lost clients
- `analytics_get_daily_series` - One metric family day by day as compact `[date, value]` pairs: `revenue`, `appointments` (including online bookings), `occupancy` (with the no-show share of working time) or `clients`
- `analytics_get_appointments_breakdown` - Appointments split by `source` (online booking, client app, receptionist, API) or by `visit_status` (`waiting`, `confirmed`, `arrived`, `no_show`, `cancelled`), with counts and shares
- `analytics_get_receptionist_performance` - Front-desk numbers: clients booked, appointments closed, revenue attributed, and the rebooking rate after a visit and after a no-show
- `analytics_get_loyalty_program_results` - One loyalty program's clients (new vs already known), returns, revenue and per-team-member results
- `analytics_get_forecast` - Revenue and visit forecast next to the actuals; explains itself when the module is off for the location
- `analytics_get_day_end_report` - Day-end totals: clients, appointments, services and products sold, memberships and gift cards, takings per account (cash vs card) and write-offs. Per-client detail is off by default and never carries names or phone numbers
- `analytics_get_team_member_occupancy` - Day-by-day occupancy for up to ten named team members
- `analytics_get_client_visit_stats` - One client's attended and missed visits, spend and client-account balance
- `analytics_get_client_sales` - Source-paginated revenue, average check and visits by client; contacts are opt-in
- `analytics_get_client_retention` - New, returning, eligible-to-return and returned clients by team member
- `analytics_get_client_forecast` - Per-client forecast export with predicted visits, return window and revenue; contacts are opt-in
- `analytics_get_service_profitability` - Revenue, costs, compensation and contribution result by service or service category
- `analytics_get_service_mix_trend` - Monthly attended service-line value by service, current category, team member or unambiguously assigned appointment resource; exact page scan or refusal
- `analytics_get_client_service_penetration` - Distinct attended clients, target-service adoption, source/target overlap, delivered-value cohorts and paged client IDs for source-only candidates; no contacts
- `analytics_get_team_member_sales` - Services, products, revenue, future appointments and worked-hour efficiency by team member
- `analytics_get_profit_and_loss_statement` - Posted income and expense categories, sales-stream memo figures and service contribution, with explicit missing-cost disclosure instead of an unproven net-profit label
- `analytics_get_customer_cash_receipts` - Reconciled monthly net cash receipts by service, product, client-account top-up and other posted income streams
- `analytics_get_client_payer_cohorts` - Bounded, reconciled cash-basis payer cohorts and paged stable client IDs across up to 12 complete months; requires unrestricted finance history
- `analytics_get_capacity_heatmap` - Scheduled, booked, completed-utilized and idle hours by hour, weekday or date-hour, with peak and underused buckets
- `analytics_get_revenue_leakage` - No-show, cancellation, unpaid-risk and discount signals plus optional unbooked-capacity opportunity; unlike estimates are never summed into a false total
- `analytics_get_team_member_service_matrix` - Genuine team-member × service cells with revenue, contribution and share metrics, bounded ranking and explicit unavailable dimensions
- `analytics_get_inventory_reorder_risks` - Stock velocity, days of cover, deterministic reorder risk and quantity from configurable lead-time and safety-stock assumptions
- `analytics_get_team_member_capacity` - Working, booked and idle hours, occupancy and upcoming appointments
- `analytics_get_client_reactivation_candidates` - Universal inactive-client audience with an inclusive last-visit cutoff, prior visits/spend qualification, stable client ids and canonical client filters; contacts opt-in
- `analytics_get_group_event_performance` - Capacity, booked/attended/paid participants and appointment value; aggregate occupancy metrics
- `analytics_get_product_sales` - Product or category sales, quantity, total cost and total markup; permission-aware product costs, category costs withheld
- `analytics_get_cash_flow_breakdown` - Signed movements by payment item, day and returned cash-account/type columns

The curated legacy-report adapters read the same stable reports as the
authenticated ERP web application while equivalent V3 endpoints are pending.
They are read-only, stateless, location-scoped, inject the current request's
user token without a cookie session, sanitize localized report content and cap
pagination. The decision tools combine those reports only with documented
read endpoints and expose provenance, formulas, completeness and unavailable
fields. They are available on the analytics, finance, read-only and stdio
surfaces, not the default `/mcp` view.

**The report builder is switched off.** Six tools
(`analytics_list_report_templates`, `analytics_list_report_fields`,
`analytics_run_report`, `analytics_list_saved_reports`,
`analytics_run_saved_report`, `analytics_delete_assistant_report`) are defined
and tested but served on no view, including stdio. Verified against production
on 2026-09-17: the report-data endpoint answers `400` for every report even with
a valid period override and a mart in `success`, because the backend flag
`new_query_builder_analytics_constructor` is off; the legacy data route accepts
no filters and ignores the report's stored period, so its rows are all-time data
under the requested period's label; a new report's first mart build always fails
and only an hourly upstream sweep repairs it; and the delete route needs the
`analytics_constructor_access` user right, which neither an owner's OAuth token
nor the marketplace system user carries. The reasons, the evidence and the
one-line re-enable step live in
[`src/tools/disabled-tools.ts`](src/tools/disabled-tools.ts). The curated
legacy-report and decision tools above cover stable client, retention,
service-profitability, team-member-sales, capacity, group-event, product,
cash-flow, operating-ledger and inventory views without creating saved reports;
reactivation instead composes the documented client-base search. Arbitrary
custom tables and complete statutory statements are
declined through `altegio://analytics/coverage` instead of answered with
incomplete or unfiltered data.

**Access rights.** Analytics needs the Analytics access right in the location;
the day-end report needs the finance reporting right and occupancy needs access
to the work schedule. A user
who may only see their own numbers can still call
`analytics_get_receptionist_performance` with their own `created_by_user_id`.
Not everything the web interface shows is reachable through the API — the
`altegio://analytics/coverage` resource lists the gaps and the closest
alternative for each.

### 🚀 Onboarding Wizard
**Conversational first-time setup assistant:**
- `onboarding_start` - Initialize setup session
- `onboarding_resume` - Resume interrupted setup
- `onboarding_status` - Check progress
- `onboarding_add_positions` - Bulk create positions/roles (run before staff)
- `onboarding_add_staff_batch` - Bulk import staff (CSV/JSON)
- `onboarding_add_categories` - Bulk create service categories
- `onboarding_add_services_batch` - Bulk import services (CSV/JSON)
- `onboarding_set_schedules` - Set staff work schedules
- `onboarding_import_clients` - Import client database
- `onboarding_create_test_appointments` - Generate sample data
- `onboarding_preview_data` - Validate before import
- `onboarding_rollback_phase` - Undo specific phase

All write operations require an authenticated Altegio user. See the
[Onboarding Guide](docs/ONBOARDING_GUIDE.md) for first-time setup workflows and
[Demo-management API contract notes](docs/DEMO_MANAGEMENT_CONTRACTS.md) for
documented limitations and live-API discrepancies.

## Facets

Every tool lives on one surface. A **facet** is a fixed, filtered view of that
surface served on its own HTTP sub-path, for hosts that cap how many tools may
be active at once. A facet never changes what a tool does, carries no separate
credential and is not a product boundary ([ADR-001](docs/architecture/2026-09-07-mcp-platform-architecture.md) D3).

A facet answers *how many tools fit in this host's context*. The separate
question — *what may this agent do at all* — is answered by the
[read-only address](#the-read-only-address-mcpreadonly) below, which is a
different kind of view and not a seventh facet.

**Which tool is served where, and why:**
[`docs/architecture/tool-surface.md`](docs/architecture/tool-surface.md) — one
generated table over every tool × every view. Eight mechanisms decide where a
tool appears and whether the call it receives runs (the report-builder closure,
the default view's excluded prefixes, excluded names and re-admitted names, the
password-login switch, the read-only rule, token scopes and the human
confirmation). Each is justified on its own terms and none is collapsed into the
others, so the table is where they are *joined*: every cell carries a machine
value for why the tool is served or withheld, plus the gates that still refuse
the call. Regenerate it with `npm run surface:build` after anything that moves a
tool; `npm run surface:check` and the test suite fail when it is stale.

| Endpoint | Serves |
|---|---|
| `/mcp` | **Every tool except the analytics pack**, plus its entry point `analytics_get_overview` — the default view, minus password login and `remove_location_user` (see below) |
| `/mcp/ops` | Appointments (the daily work; clients and journal tools join as they land) |
| `/mcp/catalog` | Services, service categories, team members, positions, work schedules, resources, location settings |
| `/mcp/finance` | Analytics (visits, payments and payroll join as they land) |
| `/mcp/marketing` | Base tools only for now (loyalty, notifications and chain tools join as they land) |
| `/mcp/analytics` | The analytics pack (the report-builder tools are served nowhere) |
| `/mcp/onboarding` | The 12 onboarding walkthrough tools |

Rules:

- Every facet always serves `list_locations` — nearly every tool needs a
  `location_id`.
- **Password login is off the HTTP surface by default.** `altegio_login` tells
  the model to ask the user for an email and a password; on the public endpoint,
  which authenticates through OAuth and never needs them, that is a standing
  prompt-injection target. `altegio_login` and `altegio_logout` are therefore
  served on no HTTP path unless `ALTEGIO_EXPOSE_PASSWORD_LOGIN=true`, and a call
  to one is refused rather than merely hidden. stdio always has them.
- **Access management is off the default view.** `remove_location_user` grants
  and revokes access to a location — a dangerous right no integration receives
  by default — so `/mcp` does not carry it. It stays on `/mcp/catalog` and on
  stdio.
- Membership is declared once in [`src/tools/facets.ts`](src/tools/facets.ts) as
  explicit tool names plus tool-name prefixes (`analytics_*`, `onboarding_*`),
  and the index is computed once at startup. `tools/list` is therefore identical
  for every connection to a given path and deterministically ordered (category,
  then name), as MCP 2026-07-28 requires.
- Calling a tool the facet does not serve returns a `MethodNotFound` error that
  names the paths which do serve it.
- An unknown facet path answers `404` with a JSON-RPC shaped error listing the
  available facets.
- **stdio exposes everything** — `src/index.ts` uses the unfiltered `all` view,
  which has no HTTP route. Facets are an HTTP concern only.
- Customer addresses are `https://mcp.alteg.io/pro` and
  `https://mcp.alteg.io/pro/<facet>` — the proxy maps them onto `/mcp` and
  `/mcp/<facet>`. The earlier `https://mcp.alteg.io/public/pro/mcp…` forms
  still work as aliases. Staff use `https://mcp.altegio.dev/pro/mcp…`.

Set `MCP_DEFAULT_FACET_EXCLUDE_ONBOARDING=true` to drop the onboarding
walkthrough from `/mcp` and serve it only on `/mcp/onboarding`. It is off by
default: turning it on is a visible change for current clients of `/mcp`.

Set `ALTEGIO_EXPOSE_PASSWORD_LOGIN=true` to serve `altegio_login` and
`altegio_logout` on the HTTP views. It is off by default. Turn it on only for
the closed staff deployment behind Google OIDC (`hd=alteg.io`), where a password
login is still how a V1 user token is obtained — never on the public endpoint.
stdio serves the unfiltered `all` view and always has both tools, whatever this
variable says.

## The read-only address (`/mcp/readonly`)

```
https://mcp.alteg.io/pro/readonly
```

The same server, the same credential, the same protocol — a surface that only
reads. Every tool that creates, updates or deletes is absent from `tools/list`,
and calling one anyway is **refused**, not silently ignored: the model gets a
`MethodNotFound` error naming the full address of the complete surface and
telling it to report the change it wanted rather than retry.

**Who it is for.** Not the business owner — they connect an agent to the full
surface. This address exists for the caller with no human watching the loop:

- autonomous agents running on a schedule,
- a shared agent several people in a team send tasks to,
- a third-party or unaudited agent someone wants to give business context to,
- chain-wide reporting and analysis, which is entirely read work,
- our own internal builds.

It is documented here, for developers and enterprise deployments. It is
deliberately not offered during onboarding or in the marketplace, where the
right default is the full surface.

**Why a separate URL and not a header or a checkbox.** A separate URL is a
separate OAuth protected resource, which is exactly how GitHub, Linear, Sentry,
Stripe, Notion, Atlassian and Slack restrict an agent, and every host already
understands it. A request header such as `X-MCP-Readonly` was considered and
rejected: nothing enforces a header the caller sets for itself, Claude Desktop
does not send one, and honouring it would make `tools/list` differ between two
connections to the *same* resource, which ADR-001 D7 forbids.

**What it is worth — read this part, it depends on the token.** The address by
itself is a **guardrail**: it constrains what this MCP server offers and will
do, not what the credential can do. With a full token behind the session,
nothing at the Altegio API rejects a write performed with it, and a person can
still ask the same agent to call the API directly, outside MCP.

What changes that is the **scope of the token**, and it no longer waits for
Altegio v3. The OAuth proxy in front of this server already issues tokens
carrying `mcp:pro:read` alone, and this server now [enforces
them](#token-scopes-the-boundary-when-the-token-is-narrow) on execution:

- **Token scoped to `mcp:pro:read`** — a real boundary. Every write tool is
  refused on *every* address, `/mcp` included, before the handler runs and
  before anything reaches Altegio. The read-only address then adds tidiness
  (the write tools are not listed at all) on top of a guarantee that already
  holds.
- **Token carrying `mcp:pro:write`, or no scopes at all** — a guardrail, as
  above. The value is still real: it lets the consent screen stay *all or
  nothing* — no per-scope checkboxes for a user to reason about — while a
  deployment that wants a non-writing agent has somewhere to point it.

So the honest summary is: the address narrows the surface, the token narrows
the rights, and the two together are what makes a read-only agent enforceable.
Point an agent here *and* connect it with a read-scoped token when you need the
guarantee.

**How membership is decided.** From each tool's own `readOnlyHint` annotation,
computed at startup — never from a list kept by hand. A pack that lands next
month is classified by the annotation its author wrote, and a tool that does not
declare `readOnlyHint: true` is treated as a write. A test fails the build if
anything without that annotation ever appears on this view.

The view also differs from `/mcp` in one direction: it carries the **whole
analytics pack**, which the default view holds back for context budget. Every
analytics tool only reads, and chain-wide analysis is a named audience here.

Sessions on this address get their own `initialize` instructions, which state
that the surface only reads and that asking the user to switch to the full
address makes sense only if the user actually wants an agent that can change
their data — never as a way around a refusal the model has just hit.

Set `MCP_PUBLIC_BASE_URL` if the deployment is reached at a different address
(the default is the customer address `https://mcp.alteg.io/pro`; the staff lane
keeps `/mcp` and sets `https://mcp.altegio.dev/pro/mcp`). It is used only to
name addresses in the refusal and in the instructions.

## Destructive operations require a human

Eleven tools delete something: `delete_staff`, `delete_service`,
`delete_service_category`, `delete_schedule`, `delete_appointment`,
`delete_booking_form`, `clients_delete`, `unlink_service_team_member`,
`remove_location_user`, `onboarding_rollback_phase` and the withheld
`analytics_delete_assistant_report`. They all carry `destructiveHint: true`,
but that annotation is only a hint: MCP forbids clients from relying on
annotations for security decisions, and on an autonomous agent with no human in
the loop it protects nothing. The server therefore asks for confirmation
itself, before the API call, whatever the host is configured to do.

**On a host that supports elicitation** (`elicitation` declared at
`initialize`) the server sends an `elicitation/create` form naming the concrete
object and what happens to it — resolving the ID to a name through the API
first, so the operator reads *"Delete team member — team member Ivan Petrov,
Stylist, id 123, at location 4564"*, not *"are you sure?"*. The operation runs
only on an explicit accept. A decline, a cancel, or a host that advertises
elicitation and then fails to deliver the prompt all stop the call, and no
token is issued on that path.

**On a host that does not support it** the call would otherwise hang, so the
first call performs nothing and returns the same consequence text plus a
one-time `confirmation_token`; the caller repeats the identical call with that
token to proceed. The token is an HMAC over the tool name and the exact
arguments, keyed per process, so it cannot be guessed, expires after 10
minutes, and cannot be replayed against another target — a token for client 5
never authorises deleting client 7. A token that does not verify is refused
rather than silently ignored.

Every outcome that is not an approval — confirmation required, operator
declined, prompt undeliverable, token invalid — comes back as an `isError`
result, the same channel the executor uses to refuse a write. The tool did not
do what it was asked, and a model must not be able to read "cancelled" as
"deleted".

`confirmation_token` is an optional argument on every one of these tools'
published schemas, on every connection: `tools/list` must not vary with client
capabilities (ADR-001 D7). The declaration lives on the tool definition as
`confirm` ([`src/tools/factory.ts`](src/tools/factory.ts)); the gate itself is
enforced in one place, the `tools/call` handler in
[`src/tools/registry.ts`](src/tools/registry.ts), and the mechanism lives in
[`src/tools/confirmation.ts`](src/tools/confirmation.ts). Nothing is stored
server-side.

## Token scopes (the boundary, when the token is narrow)

The v3 authorization RFC settled that the real access boundary is the **scope
of the token** — not the endpoint address, and not the tool annotations, which
MCP forbids clients from treating as a security decision. A separate HTTP path
only helps a deployment pick a profile of rights; it restricts nothing by
itself. Every tool declares what its execution requires, and the `tools/call`
handler checks it before anything else the call does.

**Two vocabularies meet here**, and the rule for reconciling them lives in one
file, [`src/tools/scopes.ts`](src/tools/scopes.ts):

| Vocabulary | Who writes it | Status |
| --- | --- | --- |
| `mcp:pro:read`, `mcp:pro:write` | the OAuth proxy — `routes.json` declares these on the customer `/pro` route (alias `/public/pro`) and the staff `/pro/mcp` route, and forwards the granted subset as `x-mcp-auth-scope` | **live today**, temporary |
| `locations:read`, `clients:write`, … | this server's tool requirements, in the v3 `domain:action` convention | the target; no token carries them yet |

`mcp:pro:write` satisfies every requirement — the platform vocabulary has two
grades for the whole service and cannot express `create` or `manage_access`
separately, so refusing those would make `create_appointment` permanently
unreachable rather than strictly guarded. `mcp:pro:read` satisfies only
requirements whose action is `read`, which is what makes a read-scoped token a
real boundary. Inside the v3 vocabulary the single ratified implication holds
and nothing more: `X:write` covers `X:read`, while `create`, `manage_access`,
`refund` and `capture` need an explicit grant.

Four properties are deliberate:

- **Execution only.** `tools/list` is never filtered by the caller's scopes —
  one path, one tool list, for every connection (ADR-001 D7). A tool a caller
  cannot run is still listed, and explains itself when called.
- **No declared scopes means no restriction.** Local stdio sends no
  `x-mcp-auth-scope`, and the gate is a no-op for it. Both proxy lanes do send
  one: the staff lane forwards the token's granted subset, and the customer lane
  (`/pro`, alias `/public/pro`) forwards the Altegio OAuth session's grant, or
  the route's own list (`/pro/readonly`: `mcp:pro:read`) for a caller that
  connects with a raw Altegio user token.
- **A declared but unusable grant fails closed.** Once the proxy sends the
  header, an empty or malformed grant, or one carrying only names this build
  cannot map, authorises nothing; the gate logs the unrecognised grant once.
  Vocabulary drift is an operator error to fix, never wider access.
- **The refusal is in band.** It is an `isError` tool result naming the missing
  permission and what a person has to do about it — never an HTTP 403, which
  would drop the session. Hosts do not re-authorise on a mid-session denial, so
  the message says not to retry and routes the caller to a human instead.

> ⚠️ **The v3 names are placeholders.** Their shape follows the ratified v3
> convention (`domain:action`) and most are taken verbatim from the v3 scope
> catalog, but that catalog is explicitly not final and the API team owns the
> names. What is enforceable today is the `mcp:pro:*` column; the table below
> is the map those grants are resolved against.

| Tools                                                                                                                             | Required scope                                                            |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `list_locations`, `diagnose_location_access`, `get_resources`, `get_*_settings`, `get_booking_forms`                                                          | `locations:read`                                                          |
| `update_location`, `update_*_settings`, `create_booking_form`, `delete_booking_form`                                              | `locations:write`                                                         |
| `get_staff`, `get_positions`, `get_schedule`                                                                                      | `team_members:read`                                                       |
| `create_staff`, `update_staff`, `delete_staff`, `create_position`, `create_schedule`, `update_schedule`, `delete_schedule`        | `team_members:write`                                                      |
| `remove_location_user`                                                                                                            | `team_members:manage_access`                                              |
| `get_services`, `get_service_categories`                                                                                          | `services:read`                                                           |
| `create_service`, `update_service`, `delete_service`, `delete_service_category`, the four service ↔ team-member link tools        | `services:write`                                                          |
| `get_appointments`, `appointments_attendance_preview`                                                                                                                | `appointments:read`                                                       |
| `create_appointment`                                                                                                              | `appointments:create`                                                     |
| `update_appointment`, `delete_appointment`, `appointments_attendance_apply`                                                                                        | `appointments:write`                                                      |
| `clients_search`, `clients_get_segment_report`, `clients_list_profiles`, `clients_get_card`, `clients_get_visit_history`, `clients_lookup`, `clients_list_comments`, `clients_list_files` | `clients:read`                                                            |
| `clients_get_membership_purchases` | `clients:read` + `loyalty:read` + `products:read` |
| `clients_delete`, `clients_add_comment`, `clients_upload_file`                                                                                                                  | `clients:write`                                                           |
| `analytics_*` reads                                                                                                               | `analytics:read` _(placeholder domain — no v3 scope exists yet)_          |
| `altegio_call_operation`                                                                                                          | `api:read` _(placeholder — one tool reaches every documented GET)_        |
| `altegio_login`, `altegio_logout`, `altegio_search_operations`, `altegio_describe_operation`, the wizard's local-state tools      | none                                                                      |

The onboarding wizard's write phases take the scope of what they create
(`onboarding_import_clients` → `clients:write`, and so on);
`onboarding_rollback_phase` requires all four write scopes it can reach, since
one tool name deletes across four domains.

`clients:read_contact` is a separate axis that gates _fields_ rather than
endpoints, which V1 cannot express and this server therefore does not pretend
to enforce.

The map is one file — [`src/tools/scopes.ts`](src/tools/scopes.ts) — so a
rename when the vocabulary is approved is a single edit, and so is deleting the
`mcp:pro:*` rule once v3 tokens carry the fine-grained names. No tool
definition spells a scope out: `defineTool` fills `requiredScopes` from the map
by tool name, and a test fails the build if a tool is missing an entry.

## Resources and prompts

Besides tools, the server serves MCP **resources** (documents a session can read
instead of guessing) and **prompts** (named workflows a person picks in a host).
Both are available on every facet and on stdio.

| Resource URI | Content |
|---|---|
| `altegio://docs/product-logic` | The product model: chains and locations, team members and clients, the service catalog, scheduling and booking, the visit and payment lifecycle, loyalty, finance and inventory |
| `altegio://docs/glossary` | The canonical vocabulary — the approved term for every concept and the synonyms never to use |
| `altegio://docs/onboarding-guide` | The onboarding walkthrough guide: phase order, accepted CSV and JSON shapes, resuming and rolling back |
| `altegio://docs/clients-segmentation` | Client-base filters, outcome codes and worked segment recipes |
| `altegio://analytics/glossary` | Exact definitions and invariants for every analytics metric |
| `altegio://analytics/coverage` | Supported questions, known API gaps and the closest safe alternatives |
| `altegio://analytics/playbook` | Diagnostic order, decompositions, question-to-tool routing and benchmarks |
| `altegio://analytics/data-model` | Sources and relationships behind appointments, visits, clients and financial ledgers |
| `altegio://analytics/report-fields/{dataset}` | Resource template pointing to the live field catalogue for one report-builder dataset |
| `altegio://reports/{location_id}/{run_id}.csv` | Temporary full CSV for a truncated report result |

| Prompt | What it does |
|---|---|
| `onboarding_walkthrough` | Guides a first-time location setup through the onboarding tools in the order that leaves the digital schedule working. Optional `location_id`; without it the walkthrough lists the locations and asks |
| `analytics_location_health_check` | End-to-end location diagnosis from headline metrics to the largest actionable leak |
| `analytics_monthly_review` | Monthly operating review with trends, sources, visit outcomes and drivers |
| `analytics_team_member_review` | Team-member revenue and occupancy review |
| `analytics_compare_periods` | Explicit period-versus-period comparison and driver analysis |

Both are driven by small registries — [`src/resources/registry.ts`](src/resources/registry.ts)
and [`src/prompts/registry.ts`](src/prompts/registry.ts) — so a tool pack adds
its own resources or prompts by exporting one module and adding a single import
line to `src/resources/index.ts` or `src/prompts/index.ts`. `resources/list` is
ordered by URI and `prompts/list` by name.

The core markdown documents are read from `docs/` at runtime; set
`ALTEGIO_DOCS_DIR` if a deployment keeps them elsewhere.

The `initialize` result also carries a server `instructions` paragraph naming
the domains available today, the facets and the packs being added. Override it
with `MCP_SERVER_INSTRUCTIONS`.

## Quick Start

### Prerequisites

- Node.js >= 20.17 (ESM JSON import attributes)
- Altegio Partner Token from [developer.alteg.io](https://developer.alteg.io)

### Installation

```bash
git clone https://github.com/altegio/altegio-pro-mcp.git
cd altegio-mcp
npm install
cp .env.example .env
# Edit .env and add ALTEGIO_API_TOKEN
npm run build
```

### Claude Desktop Setup

1. Build the server: `npm run build`
2. Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "altegio-pro": {
      "command": "node",
      "args": ["/absolute/path/to/altegio-mcp/dist/index.js"],
      "env": {
        "ALTEGIO_API_TOKEN": "your_partner_token"
      }
    }
  }
}
```

3. Restart Claude Desktop

See [CLAUDE_DESKTOP_SETUP.md](CLAUDE_DESKTOP_SETUP.md) for detailed setup.

## Onboarding Wizard

**New in v2.0:** Conversational assistant for first-time platform setup. Import staff, services, and clients through natural language or bulk CSV upload.

### Quick Onboarding Flow

```typescript
// 1. Login and start
altegio_login({ email: "owner@salon.com", password: "..." })
onboarding_start({ location_id: 123456 })

// 2. Create categories
onboarding_add_categories({
  location_id: 123456,
  categories: [
    { title: "Hair Services" },
    { title: "Nail Services" }
  ]
})

// 3. Import staff (CSV or JSON)
onboarding_add_staff_batch({
  location_id: 123456,
  staff_data: `name,specialization,phone
Alice Johnson,Senior Stylist,+1234567890
Bob Smith,Nail Technician,+1234567891`
})

// 4. Add services
onboarding_add_services_batch({
  location_id: 123456,
  services_data: [
    { title: "Haircut", price_min: 50, duration: 60 },
    { title: "Manicure", price_min: 30, duration: 45 }
  ]
})

// 5. Import clients
onboarding_import_clients({
  location_id: 123456,
  clients_csv: `name,phone,email
Sarah Miller,+1234560001,sarah@example.com
John Davis,+1234560002,john@example.com`
})

// 6. Generate test appointments
onboarding_create_test_appointments({ location_id: 123456, count: 5 })

// 7. Check progress
onboarding_status({ location_id: 123456 })
```

**Key Features:**
- **Checkpoint/Resume:** Automatically recovers from errors or interruptions
- **Hybrid Input:** Accept JSON arrays or CSV strings
- **Preview Mode:** Validate data before importing (`onboarding_preview_data`)
- **Rollback:** Undo specific phases (`onboarding_rollback_phase`)
- **Progress Tracking:** View completion status (`onboarding_status`)

**Time Savings:** 5-10 minutes vs 30+ minutes manual setup

See [docs/ONBOARDING_GUIDE.md](docs/ONBOARDING_GUIDE.md) for complete guide with CSV templates, error handling, and troubleshooting.

### Local Docker Testing

```bash
# Create .env with your API token
echo "ALTEGIO_API_TOKEN=your_partner_token" > .env

# Start with Docker Compose (recommended)
docker compose -f docker-compose.local.yml up --build -d

# Health check
curl http://localhost:8080/health

# View logs
docker compose -f docker-compose.local.yml logs -f

# Stop
docker compose -f docker-compose.local.yml down
```

Or run standalone:

```bash
docker build -t altegio-mcp:local .
docker run --rm -p 8080:8080 --env-file .env -e PORT=8080 altegio-mcp:local
```

The MCP endpoint is available at `http://localhost:8080/mcp` (Streamable HTTP transport). See [TESTING.md](TESTING.md) for the full MCP protocol testing guide.

### Production Deployment

Automatic deployment to `mcp-servers` VM on PR merge to `main`. A cron job pulls latest `main` every 2 minutes and rebuilds if changed.

Public endpoint: `https://mcp.alteg.io/pro`

Users authorize with their own Altegio account during connection. For richer
product answers, add the public Knowledge MCP alongside it:
`https://mcp.alteg.io/knowledge`.

See [CI-CD.md](CI-CD.md) for details.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ALTEGIO_API_TOKEN` | Yes | - | Partner API token |
| `ALTEGIO_API_BASE` | No | `https://api.alteg.io/api/v1` | API base URL |
| `ALTEGIO_LEGACY_WEB_BASE` | No | `https://app.alteg.io` | Temporary authenticated ERP report base URL. Set `https://yclients.com` for a YCLIENTS deployment. |
| `ALTEGIO_USER_TOKEN` | No | - | Pre-seeded user token (stdio single-user only) |
| `CREDENTIALS_DIR` | No | `~/.altegio-mcp` | Directory for stored user tokens |
| `REQUIRE_DELEGATED_IDENTITY` | No | `false` | HTTP mode: require a proxy-verified identity per request |
| `ALTEGIO_EXPOSE_PASSWORD_LOGIN` | No | `false` | HTTP mode: serve `altegio_login`/`altegio_logout`. Closed staff deployments only — never the public endpoint. stdio always serves them |
| `MCP_DEFAULT_FACET_EXCLUDE_ONBOARDING` | No | `false` | Drop `onboarding_*` from the default `/mcp` facet |
| `MCP_SERVER_INSTRUCTIONS` | No | built-in | Override the `initialize` instructions paragraph |
| `MCP_PUBLIC_BASE_URL` | No | `https://mcp.alteg.io/pro` | Public address of the complete surface; views are this plus `/<view>` (`/readonly`, `/ops`, …). Only used to name addresses in text a model reads: instructions, the read-only refusal and the out-of-facet hint. Behind a proxy that keeps `/mcp`, set e.g. `https://mcp.altegio.dev/pro/mcp` |
| `ALTEGIO_DOCS_DIR` | No | `<pkg>/docs` | Where the `altegio://docs/*` markdown documents are read from |
| `LOG_LEVEL` | No | `info` | `debug\|info\|warn\|error` |
| `NODE_ENV` | No | `development` | `development\|production` |
| `RATE_LIMIT_REQUESTS` | No | `200` | Max requests per minute |

### Authentication & identity

How the user token behind `altegio_login` is stored depends on the transport:

- **stdio (Claude Desktop, `npm start`) — single user.** `altegio_login` writes
  one token to `<CREDENTIALS_DIR>/credentials.json` and every tool call uses it.
  This is unchanged from previous releases.
- **Public HTTP (`mcp.alteg.io/pro`, alias `/public/pro`) — Altegio OAuth.** The platform
  authorizes the user with their own Altegio account and forwards only that
  user's delegated token and allowed location scope. No `altegio_login` call or
  server-side password storage is involved.
- **Internal HTTP (`mcp.altegio.dev/pro/mcp`) — per delegated identity.** The deployment sits
  behind the platform's OAuth 2.1 proxy, which forwards the verified caller as
  `x-mcp-auth-*` headers. Each request acts strictly as *its own* identity: the
  token from `altegio_login` is stored per identity
  (`<CREDENTIALS_DIR>/credentials-<hash>.json`) and resolved from the current
  request's identity on every tool call. One caller can never read or write with
  another caller's token, and `altegio_logout` clears only the caller's own token.

Set **`REQUIRE_DELEGATED_IDENTITY=true`** in the HTTP deployment (it is enabled
in production). With it on, a request that arrives without a proxy-verified
identity gets no user token — every authenticated tool returns
`Not authenticated. Call altegio_login first.` and `altegio_login` is refused
for that request.

The legacy internal login store is ephemeral; public OAuth and direct-token
connections do not depend on it and survive MCP server redeploys.

- **HTTP with a direct token — many clients, no login.** A caller that already
  holds a client's Altegio user token (e.g. a marketplace app's technical-user
  token) can send it per request in the **`X-Altegio-User-Token`** header. When
  present it is used as the `User <token>` part of the upstream `Authorization`
  header directly, taking precedence over any stored/identity token — so one
  long-lived deployment can act for many different Altegio clients by sending a
  different token per request, with **no `altegio_login` and no delegated Google
  identity**. Nothing is persisted for these requests, and this path is honored
  even when `REQUIRE_DELEGATED_IDENTITY=true` (the token itself is the
  authorization). The token never appears in logs or tool responses.

## Development

```bash
npm install          # Install dependencies
npm run dev          # Dev mode with hot reload
npm run build        # Build TypeScript
npm test             # Run tests
npm run test:watch   # Watch mode
npm run lint         # Check code style
```

### Project Structure

```
catalog/
  overlay/       # Curation overlay: tier, facets, tool names, projections
scripts/
  catalog/       # build.mjs: OpenAPI + overlay -> src/generated/catalog.json
src/
  config/        # Configuration and validation
  generated/     # catalog.json (committed, generated - do not edit by hand)
  api/           # AltegioApi ports and the v1 adapters behind them
  capabilities/  # Domain use cases, vocabulary, projections
  providers/     # API clients (altegio-client.ts)
  prompts/       # Prompt registry + modules (onboarding.prompts.ts)
  resources/     # Resource registry + modules (docs.resources.ts, glossary.ts)
  tools/         # MCP tool handlers & registry
    facets.ts    # Static facet membership (ADR-001 D3)
  tools/executor/# Universal executor: catalog index, search, describe, call
  resources/     # MCP resource data and handlers
  prompts/       # MCP prompt definitions
  types/         # TypeScript interfaces
  utils/         # Logging, errors, helpers
  __tests__/     # Jest unit tests
  index.ts       # stdio server entry
  http-server.ts # HTTP server entry (/mcp and /mcp/<facet>)
  server.ts      # Shared MCP server setup

catalog/
  extended/      # Hand-written stubs for allowlisted undocumented endpoints
```

Regenerate the catalog after pulling the spec repository:

```bash
npm run catalog:build   # rewrite src/generated/catalog.json
npm run catalog:check   # CI gate: fails if the committed catalog is stale
```

See [docs/architecture/catalog.md](docs/architecture/catalog.md) for the
pipeline and the overlay format.

### Testing

- **More than 1,100 tests** covering authentication, all tools, facets and `tools/list` ordering, resources and prompts, the API catalog and executor, analytics golden fixtures and the terminology guard, error handling and pagination
- **Opt-in live suite** for analytics — records real API payloads from the demo location (4564) into `src/api/v1/__tests__/fixtures/live/`; the hand-built fixtures next to it drive the unit tests and are not overwritten:

```bash
ALTEGIO_E2E=1 \
ALTEGIO_PARTNER_TOKEN=... ALTEGIO_TEST_LOGIN=... ALTEGIO_TEST_PASSWORD=... \
CREDENTIALS_DIR=/tmp/altegio-mcp-live \
npx jest analytics-live
```

  The partner token has its own variable here because the shared Jest setup pins
  `ALTEGIO_API_TOKEN` to a dummy value for every other suite. The suite is
  read-only and reuses a maintained assistant-owned report for builder checks.
- **Opt-in legacy-report live suite** — reads and parses the temporary ERP
  reports without recording or printing client data:

```bash
ALTEGIO_E2E=1 \
ALTEGIO_PARTNER_TOKEN=... ALTEGIO_USER_TOKEN=... \
CREDENTIALS_DIR=/tmp/altegio-mcp-live \
npx jest legacy-analytics-live
```

- **Jest** for unit tests with mocked API responses
- **Test isolation** with temporary credentials directory
- Run: `npm test` or `npm run test:coverage`
- See [TESTING.md](TESTING.md) for local Docker and MCP protocol testing

## Integrations

- **Claude Desktop:** Native stdio transport (recommended)
- **Other MCP Clients:** Streamable HTTP transport via Cloud Run URL (MCP spec 2025-11-25 with tool annotations and structured output)

## API Reference

Base URL: `https://api.alteg.io/api/v1`
Documentation: [developer.alteg.io/api](https://developer.alteg.io/api)
Generated catalog of every documented operation: [docs/architecture/catalog.md](docs/architecture/catalog.md)

**Authentication:**
- Partner token: `Authorization: Bearer {token}`
- User token: append `, User {token}` to the `Authorization` header (resolved
  automatically from OAuth, a direct request token or `altegio_login`)

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for:
- Development setup
- Coding standards (TypeScript, Prettier, ESLint)
- Testing guidelines
- Commit conventions

Quick contribution flow:
1. Fork and create feature branch
2. Add tests for new features
3. Ensure `npm test` and `npm run lint` pass
4. Submit PR with clear description

## License

MIT License - see [LICENSE](LICENSE) file

## Support

- **Issues:** [GitHub Issues](https://github.com/altegio/altegio-pro-mcp/issues)
- **Discussions:** [GitHub Discussions](https://github.com/altegio/altegio-pro-mcp/discussions)
- **Altegio API:** [support.alteg.io](https://support.alteg.io)

## Acknowledgments

Built with [Model Context Protocol](https://modelcontextprotocol.io) by Anthropic and [Altegio API](https://developer.alteg.io) for salon/spa management.
