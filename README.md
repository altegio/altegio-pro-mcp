# Altegio.Pro MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A TypeScript [Model Context Protocol](https://modelcontextprotocol.io) server for
Altegio business owners, administrators, and team members. It provides
administrative B2B operations, client workflows, onboarding, and analytics.

**126 tools served (132 defined, 6 withheld from every view)** — see the generated
[tool surface](docs/architecture/tool-surface.md) for exact membership and gates.
The surface includes a 28-tool analytics pack, a 15-tool group events pack, a
13-tool memberships pack, a 3-tool API explorer, and 12 onboarding wizard tools. The API explorer executes reads only; administrative
writes use curated tools. The six unavailable report-builder tools are withheld
because their upstream report-data service is not usable.

## Connect

The maintained HTTP endpoint is `https://mcp.alteg.io/pro`. Add it as a remote MCP
server in your host and complete Altegio sign-in. Password-login tools are hidden
on HTTP by default. The read-only endpoint is
`https://mcp.alteg.io/pro/readonly`.

Named views are available at `https://mcp.alteg.io/pro/<facet>`:
`ops`, `catalog`, `finance`, `marketing`, `analytics`, and `onboarding`.
Views reduce the advertised tool set; they do not grant additional permissions.
A call to a tool outside its view is refused. Token scopes and upstream access
rights are enforced independently of view membership.

## Run locally

Requires Node.js 20.17 or later and npm. This package is not published to npm;
build from a checkout:

```sh
npm ci
cp .env.example .env
# Set ALTEGIO_API_TOKEN in .env.
npm run build
npm start
```

Obtain a partner token through [Altegio developer account](https://developer.alteg.io).
Local stdio can use `ALTEGIO_USER_TOKEN` or the `auth_login` tool. Credentials
are stored in the configured credential directory. Keep `.env` and credential
files outside version control.

For a desktop host, run `node` with the absolute path to `dist/index.js` and pass
`ALTEGIO_API_TOKEN` through the host's environment configuration. Stdio exposes the
complete served tool inventory. Protocol messages use stdout; logs use stderr.
See [desktop setup](CLAUDE_DESKTOP_SETUP.md) for an example.

For local HTTP development:

```sh
npm run dev:http
curl --fail http://localhost:3000/health
```

The local MCP route is `/mcp`, with `/mcp/<facet>` and `/mcp/readonly` variants.
HTTP uses the SDK's Streamable HTTP transport and session handling. All views
share `MCP_HTTP_MAX_SESSIONS` (default 512), including pending initializes. Tune
it against the container's JS heap budget; the internal 256 MiB old-space
deployment uses 256 sessions. Sessions expire after 30 idle minutes, with active
POST responses protected. At capacity, initialization returns 503 with
`Retry-After: 60`; expired IDs return 404 and require reinitialization.

## Self-hosting and authentication

The HTTP backend expects a trusted authentication proxy. It does not implement
an OAuth authorization server. Keep the backend listener private; strip
caller-supplied identity headers and forward only verified identity, credentials,
location scope, and OAuth grants. Never expose a shared server token as an
unauthenticated public service.

`MCP_PUBLIC_BASE_URL` names the externally reachable full MCP endpoint in tool
hints. For a local deployment this may be `http://localhost:3000/mcp`; it does not
configure routing or authentication. `ALTEGIO_EXPOSE_PASSWORD_LOGIN` defaults to
false for HTTP. `REQUIRE_DELEGATED_IDENTITY` can require proxy identity when the
chosen authentication flow supplies it.

See [.env.example](.env.example), the authoritative
[configuration schema](src/config/schema.ts), and [deployment](CI-CD.md).
The Docker image runs as a non-root user and includes the documents served as
MCP resources.

## Tool contracts

Tool inputs and structured outputs are published as JSON Schema. Curated tools
reject unknown top-level arguments rather than silently discarding misspelled
filters or update fields. Expected execution failures use MCP `isError` results.

The public vocabulary is **location**, **team member**, **appointment**,
**event**, **client**, **service** and **resource**. Team-member tools are
`team_members_list`, `team_members_create`, `team_members_update`, and
`team_members_delete`; the onboarding batch is
`onboarding_add_team_members_batch`. See [CHANGELOG.md](CHANGELOG.md) for breaking
changes. Upstream wire names remain inside adapters, and so does the API
version: a tool or catalog operation is one capability whichever version serves
it, V2 where it can and V1 only where V2 has no equivalent.

Group events — classes, workshops and other sessions many clients book into —
are the `events_*` pack: `events_list`, `events_get` (with the bookings),
`events_list_dates`, `events_list_services`, `events_create`, `events_update`,
`events_delete`, `events_duplicate`, the duplication patterns
(`events_list_duplication_strategies`, `events_create_duplication_strategy`,
`events_update_duplication_strategy`, `events_delete_duplication_strategy`),
`events_book_clients` (one client or up to 50, partial success reported per
client), `events_update_appointment` and `events_reschedule_appointment`.

Every collection result uses one pagination contract. Inputs are `page`
(1-based) and `page_size` (default 25, maximum 300 unless a tool documents a
lower cap). Output carries the rows in `items` and a `pagination` object with
`page`, `page_size`, `returned`, `total` (exact count, or `null` when the source
does not report one), `has_more` and `next_page` (`null` on the last page).
Unpaged V1 reference lists are sorted by id and paged locally; appointments and
locations use upstream paging, so a full last page can be followed by one empty
page and no unknown total is invented. Date-windowed histories return
`pagination.next_date_from` / `next_date_to` instead of a page number. Each
request reads current data, so concurrent changes can shift page boundaries.

Client contacts are opt-in where supported: pass `include_contacts: true` when
contact details are needed. Business names and comments are untrusted data.
Destructive tools request confirmation through MCP form elicitation. The prompt
names the target and consequences; the standard `accept` action approves it,
while `decline` or `cancel` leaves everything unchanged. No extra form field is
required. Clients without form elicitation receive a `confirmation_token` and
must repeat the identical call with it after the user agrees. A read-only
annotation alone is not an authorization boundary. Report download links are
temporary, process-local, and bound to their creating principal and permitted
location.

## Resources and prompts

MCP resources include the product model, glossary, onboarding guide, analytics
coverage, data model, and workflow guidance. Prompts guide onboarding and
analytics workflows. Discover the current inventory using `resources/list`,
`resources/templates/list`, and `prompts/list`.

## Development

```sh
npm run typecheck
npm run lint
npm run format:check
npm test -- --runInBand
npm run build
npm run catalog:check
npm run surface:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [TESTING.md](TESTING.md).
The generated catalog is committed so ordinary contributors do not need access
to a separate specification checkout. Set `ALTEGIO_API_DOCS` when rebuilding it;
see [OPENAPI.md](OPENAPI.md). Never edit generated artifacts by hand.

## License and support

[MIT](LICENSE). Report reproducible problems through
[GitHub Issues](https://github.com/altegio/altegio-pro-mcp/issues).

Hosted VM deployments can enable `GCP_STRUCTURED_LOGGING=true` to write bounded batches directly to Cloud Logging using their existing metadata service account. Entries expose root severity and indexed service, version, commit, request ID and outcome fields. Failed writes fall back to stderr with a 30-second retry cooldown; shutdown waits at most five seconds to flush. Local and stdio clients continue to use stderr.
