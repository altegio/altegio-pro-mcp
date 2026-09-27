# Altegio.Pro MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A TypeScript [Model Context Protocol](https://modelcontextprotocol.io) server for
Altegio business owners, administrators, and team members. It provides
administrative B2B operations, client workflows, onboarding, and analytics.

**95 tools served (101 defined, 6 withheld from every view)** — see the generated
[tool surface](docs/architecture/tool-surface.md) for exact membership and gates.
The surface includes a 28-tool analytics pack, a 3-tool API explorer, and
12 onboarding wizard tools. The API explorer executes reads only; administrative
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
Local stdio can use `ALTEGIO_USER_TOKEN` or the `altegio_login` tool. Credentials
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
HTTP uses the SDK's Streamable HTTP transport and session handling.

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

The public vocabulary is **location**, **team member**, **appointment**, and
**client**. Team-member tools are `team_members_list`, `team_members_create`,
`team_members_update`, and `team_members_delete`; the onboarding batch is
`onboarding_add_team_members_batch`. See [CHANGELOG.md](CHANGELOG.md) for breaking
changes. Upstream V1 wire names remain inside adapters where required.

Reference lists of team members, services, categories, positions, resources, and
booking forms accept `page` (1-based) and `count` (default 25, maximum 300).
Output includes `items`, returned `count`, `page`, `page_size`, `next_page` (null
at the end), and exact `total`. Unpaged V1 reference lists are sorted by ID and
paged locally. Each request reads current data, so concurrent changes can shift
page boundaries.

Appointments and locations use upstream paging with the same defaults and
continuation fields. A full last page may require an extra empty request; no
unknown total is fabricated. Analytics and client tools expose source-specific
pagination, coverage, units, and limitations through their schemas.

Client contacts are opt-in where supported: pass `include_contacts: true` when
contact details are needed. Business names and comments are untrusted data.
Destructive tools require confirmation; a read-only annotation alone is not an
authorization boundary. Report download links are temporary, process-local, and
bound to their creating principal and permitted location.

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
