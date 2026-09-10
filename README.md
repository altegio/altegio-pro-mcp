# Altegio.Pro MCP Server

> Official MCP server by [Altegio](https://github.com/altegio) organization

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-green)](https://modelcontextprotocol.io)

MCP server for Altegio.Pro business management API - B2B integration for salon/spa owners and administrators.

**Target users:** Business owners managing their Altegio locations
**Authentication:** All operations require user login (obtained via `altegio_login`)
**Focus:** Administrative B2B operations only (no public booking features)

## Features

- **71 MCP tools** including a 14-tool analytics pack, a 3-tool API explorer and 12 onboarding wizard tools for first-time setup
- **Administrative writes** for staff, services, appointments, schedules, clients, categories, booking forms, and location users
- **Analytics**: key metrics with period comparison, daily series, breakdowns, day-end report, report builder
- **Location settings**: appointment calendar, online booking, booking forms, resources
- **Universal API executor**: search, describe and call any of the 317 documented API operations, even the ones without a dedicated tool
- **Conversational onboarding** with bulk CSV/JSON import and checkpoint/resume
- **Dual transport:** stdio for Claude Desktop, HTTP for cloud deployments
- **TypeScript** with full type safety and comprehensive automated tests
- **Auto-deploy CI/CD** via VM cron (git pull + docker compose rebuild every 2 min)
- **Rate limiting** and **retry logic** with exponential backoff
- **Secure credential storage** in `~/.altegio-mcp/`

## Available Tools

**71 tools organized by category** for complete business management:

### 🔐 Authentication
- `altegio_login` - Authenticate with email/password
- `altegio_logout` - Clear stored credentials

### 🏢 Location Management
- `list_locations` - Get managed locations (requires auth)
- `update_location` - Rename or change a location's address, city, contacts, coordinates, or business type

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

### ⚙️ Location Settings
- `get_appointment_settings` / `update_appointment_settings` - Appointment calendar defaults (record type, group capacity)
- `get_online_booking_settings` / `update_online_booking_settings` - Online booking behavior
- `get_booking_forms` / `create_booking_form` / `delete_booking_form` - Online booking widgets

### 👤 Clients and Location Access
- `clients_search`, `clients_get_card`, `clients_get_visit_history`, `clients_lookup` - Search and inspect the client base
- `clients_delete` - Permanently delete a client
- `remove_location_user` - Revoke a user's access to one location; requires the user ID twice as an explicit safeguard

### 🪑 Resources
- `get_resources` - List cabinets/equipment (read-only; API has no create)

### 🧭 API Explorer (universal executor)

Three tools cover the **whole documented Altegio API** — 317 operations — so a
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
serve them yet. Authentication via `altegio_login` is required.
### 📊 Analytics
**Read-only reporting for one location.** Every tool takes `location_id` first and
either a `period` preset (`today`, `yesterday`, `this_week`, `last_week`,
`this_month`, `last_month`, `last_30_days`, `this_quarter`, `last_quarter`,
`this_year`) or an explicit `date_from` + `date_to` pair in `YYYY-MM-DD`. Presets
resolve in the location's own timezone, ranges over 365 days are refused before
the call, and amounts come back in major units with an ISO currency code.

- `analytics_get_overview` - Key metrics with a comparison to the previous period of equal length: revenue (total, services, products), average check, occupancy, appointments by outcome, and new / returning / active / lost clients
- `analytics_get_daily_series` - One metric family day by day as compact `[date, value]` pairs: `revenue`, `appointments` (including online bookings), `occupancy` (with the no-show share of working time) or `clients`
- `analytics_get_appointments_breakdown` - Appointments split by `source` (online booking, client app, receptionist, API) or by `visit_status` (`waiting`, `confirmed`, `arrived`, `no_show`, `cancelled`), with counts and shares
- `analytics_get_receptionist_performance` - Front-desk numbers: clients booked, appointments closed, revenue attributed, and the rebooking rate after a visit and after a no-show
- `analytics_get_loyalty_program_results` - One loyalty program's clients (new vs already known), returns, revenue and per-team-member results
- `analytics_get_forecast` - Revenue and visit forecast next to the actuals; explains itself when the module is off for the location
- `analytics_get_day_end_report` - Day-end totals: clients, appointments, services and products sold, memberships and gift cards, takings per account (cash vs card) and write-offs. Per-client detail is off by default and never carries names or phone numbers
- `analytics_get_team_member_occupancy` - Day-by-day occupancy for up to ten named team members
- `analytics_get_client_visit_stats` - One client's attended and missed visits, spend and client-account balance
- `analytics_list_report_templates` - The built-in report templates of the location, each with the question it answers
- `analytics_list_report_fields` - Canonical field keys of one report-builder dataset (`sales`, `financial_transactions`, `loyalty`, `team_member_schedules`)
- `analytics_run_report` - Run a template by id, or an ad-hoc report from a dataset, fields, `group_by` and an optional `day`/`week`/`month`/`year` granularity. Returns a table capped at 200 rows; a longer table is attached as a CSV resource link that lives for 30 minutes
- `analytics_list_saved_reports` / `analytics_run_saved_report` - Re-run a report the owner already has, for any period

**Report ownership.** The report builder has no delete, so `analytics_run_report`
keeps exactly one report per template or ad-hoc shape, named
`[Altegio Assistant] <name>`, created on first use and updated in place. The
period always travels as a per-run filter override, never as a new report. This
is the one analytics tool that is not marked read-only.

**Access rights.** Analytics needs the Analytics access right in the location;
the day-end report needs the finance reporting right, occupancy needs access to
the work schedule, and the report builder needs an active subscription. A user
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

All write operations require user authentication via `altegio_login`. See the
[Onboarding Guide](docs/ONBOARDING_GUIDE.md) for first-time setup workflows and
[Demo-management API contract notes](docs/DEMO_MANAGEMENT_CONTRACTS.md) for
documented limitations and live-API discrepancies.

## Facets

Every tool lives on one surface. A **facet** is a fixed, filtered view of that
surface served on its own HTTP sub-path, for hosts that cap how many tools may
be active at once. A facet never changes what a tool does, carries no separate
credential and is not a product boundary ([ADR-001](docs/architecture/2026-09-07-mcp-platform-architecture.md) D3).

| Endpoint | Serves |
|---|---|
| `/mcp` | **Every tool except the analytics pack**, plus its two entry points `analytics_get_overview` and `analytics_run_report` (59 tools) — the default view |
| `/mcp/ops` | Appointments (the daily work; clients and journal tools join as they land) |
| `/mcp/catalog` | Services, service categories, team members, positions, work schedules, resources, location settings |
| `/mcp/finance` | Analytics (visits, payments and payroll join as they land) |
| `/mcp/marketing` | Base tools only for now (loyalty, notifications and chain tools join as they land) |
| `/mcp/analytics` | The analytics pack and the report builder |
| `/mcp/onboarding` | The 12 onboarding walkthrough tools |

Rules:

- Every facet always serves `altegio_login`, `altegio_logout` and
  `list_locations` — no tool works before authentication, and nearly every tool
  needs a `location_id`.
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
- Publicly the paths are `https://mcp.alteg.io/pro/mcp` and
  `https://mcp.alteg.io/pro/mcp/<facet>` — the platform proxy strips the `/pro`
  prefix, so facets need no proxy change.

Set `MCP_DEFAULT_FACET_EXCLUDE_ONBOARDING=true` to drop the onboarding
walkthrough from `/mcp` and serve it only on `/mcp/onboarding`. It is off by
default: turning it on is a visible change for current clients of `/mcp`.

## Resources and prompts

Besides tools, the server serves MCP **resources** (documents a session can read
instead of guessing) and **prompts** (named workflows a person picks in a host).
Both are available on every facet and on stdio.

| Resource URI | Content |
|---|---|
| `altegio://docs/product-logic` | The product model: chains and locations, team members and clients, the service catalog, scheduling and booking, the visit and payment lifecycle, loyalty, finance and inventory |
| `altegio://docs/glossary` | The canonical vocabulary — the approved term for every concept and the synonyms never to use |
| `altegio://docs/onboarding-guide` | The onboarding walkthrough guide: phase order, accepted CSV and JSON shapes, resuming and rolling back |

| Prompt | What it does |
|---|---|
| `onboarding_walkthrough` | Guides a first-time location setup through the onboarding tools in the order that leaves the digital schedule working. Optional `location_id`; without it the walkthrough lists the locations and asks |

Both are driven by small registries — [`src/resources/registry.ts`](src/resources/registry.ts)
and [`src/prompts/registry.ts`](src/prompts/registry.ts) — so a tool pack adds
its own resources or prompts by exporting one module and adding a single import
line to `src/resources/index.ts` or `src/prompts/index.ts`. `resources/list` is
ordered by URI and `prompts/list` by name.

The two markdown documents are read from `docs/` at runtime; set
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

Public endpoint: `https://mcp.alteg.io/pro/mcp`

See [CI-CD.md](CI-CD.md) for details.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ALTEGIO_API_TOKEN` | Yes | - | Partner API token |
| `ALTEGIO_API_BASE` | No | `https://api.alteg.io/api/v1` | API base URL |
| `ALTEGIO_USER_TOKEN` | No | - | Pre-seeded user token (stdio single-user only) |
| `CREDENTIALS_DIR` | No | `~/.altegio-mcp` | Directory for stored user tokens |
| `REQUIRE_DELEGATED_IDENTITY` | No | `false` | HTTP mode: require a proxy-verified identity per request |
| `MCP_DEFAULT_FACET_EXCLUDE_ONBOARDING` | No | `false` | Drop `onboarding_*` from the default `/mcp` facet |
| `MCP_SERVER_INSTRUCTIONS` | No | built-in | Override the `initialize` instructions paragraph |
| `ALTEGIO_DOCS_DIR` | No | `<pkg>/docs` | Where the `altegio://docs/*` markdown documents are read from |
| `LOG_LEVEL` | No | `info` | `debug\|info\|warn\|error` |
| `NODE_ENV` | No | `development` | `development\|production` |
| `RATE_LIMIT_REQUESTS` | No | `200` | Max requests per minute |

### Authentication & identity

How the user token behind `altegio_login` is stored depends on the transport:

- **stdio (Claude Desktop, `npm start`) — single user.** `altegio_login` writes
  one token to `<CREDENTIALS_DIR>/credentials.json` and every tool call uses it.
  This is unchanged from previous releases.
- **HTTP (`mcp.alteg.io/pro`) — per delegated identity.** The deployment sits
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

> **After a deploy, HTTP callers must run `altegio_login` once more.** Tokens are
> stored on the container's ephemeral filesystem, so a redeploy clears them.

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

- **865 tests** (47 suites, 6 skipped live) covering authentication, all tools, facets and `tools/list` ordering, resources and prompts, the API catalog and executor, analytics golden fixtures and the terminology guard, error handling, pagination
- **Opt-in live suite** for analytics — records real API payloads from the demo location (4564) into `src/api/v1/__tests__/fixtures/live/`; the hand-built fixtures next to it drive the unit tests and are not overwritten:

```bash
ALTEGIO_E2E=1 \
ALTEGIO_PARTNER_TOKEN=... ALTEGIO_TEST_LOGIN=... ALTEGIO_TEST_PASSWORD=... \
CREDENTIALS_DIR=/tmp/altegio-mcp-live \
npx jest analytics-live
```

  The partner token has its own variable here because the shared Jest setup pins
  `ALTEGIO_API_TOKEN` to a dummy value for every other suite. Add
  `ALTEGIO_E2E_WRITE=1` to also exercise the assistant-owned report in the
  report builder.
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
- User token: `User-Token: {token}` (obtained via `altegio_login`)

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
