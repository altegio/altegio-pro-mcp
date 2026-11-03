# Testing

Use the committed lockfile with Node.js 26.13.0 (npm 11.20.0), or the
Node.js 24.22.2 compatibility runtime. Install Python 3 for the synthetic
archive-safety tests; Docker is needed only for container checks:

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run surface:check
```

`npm run test:coverage` adds coverage reporting. `npm run test:watch` runs Jest
in watch mode. Default tests use mocked upstream responses and local HTTP
servers; no real credentials or business data are needed.

Jest transpiles without type checking; `npm run typecheck` checks the sources
and, through `tsconfig.test.json`, the tests. A full run uses two workers and
replaces a worker once its heap passes 384 MB, about 1.5 GB in all. Every test
file loads its own copy of the server, and V8 frees old copies only near its
heap limit, so one long-lived process grows to gigabytes: avoid `--runInBand`
and a raised `--maxWorkers` for the whole suite.

Public catalog generator tests always run using synthetic fixtures, including
negative overlay cases, refs, supersession and determinism. The additional
real-spec drift test uses `describe.skip` unless `ALTEGIO_API_DOCS` explicitly
selects an available snapshot. `npm run catalog:check` exits 2 when unavailable,
not success. See [OPENAPI.md](OPENAPI.md) for the pinned trusted check. The
surface check is self-contained; regenerate with `npm run surface:build`.

Trusted catalog changes additionally require the explicit Docker containment
checks (synthetic inputs only):

```sh
docker build --file scripts/catalog/Dockerfile --tag catalog-sandbox .
node scripts/catalog/test-sandbox.mjs catalog-sandbox
```

They verify host-side equality, drift rejection, non-root/read-only/network
containment, private and excessive output, timeout cleanup and rejected links.
Public fixtures also cover stale-head/status identity, OIDC acquisition failure
and optimized-Python archive guards. An actual successful trusted-main run is
required before activating the private status; local success does not prove
hosted archive access. See [OPENAPI.md](OPENAPI.md#trusted-pinned-spec-gate).

Coverage floors protect the reviewed baseline: 90% statements, 75% branches,
88% functions and 91% lines. Coverage runs once on Node 26 in CI; behavioral
regressions and scope/refusal tests matter more than percentages. Lint probes
exercise actual ESLint rules against unsafe promises and JavaScript mistakes.

Every test must supply an isolated `testDir` or temporary `CREDENTIALS_DIR`.
For an isolated full run, create a directory with `mktemp -d`, set
`CREDENTIALS_DIR` to a child path and remove only that temporary directory after
the run. Never use the live credential store or enable live flags to make a unit
test pass.

## Live integration tests

Live suites (`*-live.test.ts`) are explicitly opt-in: they run only with
`ALTEGIO_E2E=1` and call the real API. Read the header of each suite before
running it. Use a dedicated disposable location and credentials with
appropriate rights. Never enable live flags in default CI.

```sh
ALTEGIO_E2E=1 CREDENTIALS_DIR=/tmp/altegio-mcp-live \
  ALTEGIO_API_TOKEN=… ALTEGIO_USER_TOKEN=… ALTEGIO_E2E_LOCATION_ID=… … \
  npx jest --runInBand --testPathPatterns='-live\.test\.ts$'
```

Credentials and fixture ids come from the environment, never from a file in
this public repository:

| Variable                                               | What it is                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `ALTEGIO_API_TOKEN`, `ALTEGIO_USER_TOKEN`              | Partner and user tokens with rights at the location                                    |
| `ALTEGIO_E2E_LOCATION_ID`                              | The disposable test location                                                           |
| `ALTEGIO_E2E_CLIENT_ID`                                | A client with no reachable phone or email: arrived appointments can message the client |
| `ALTEGIO_E2E_TEAM_MEMBER_ID`, `ALTEGIO_E2E_SERVICE_ID` | A team member who provides a priced service with no Bill of Materials                  |
| `ALTEGIO_E2E_OPERATION_TEAM_MEMBER_ID`                 | A team member who may record inventory operations                                      |
| `ALTEGIO_E2E_PRODUCT_ID`, `ALTEGIO_E2E_INVENTORY_ID`   | A cheap plain product and a sale inventory that holds it                               |
| `ALTEGIO_E2E_CONSUMABLES_INVENTORY_ID`                 | The consumables inventory                                                              |
| `ALTEGIO_E2E_ACCOUNT_ID`                               | A cash register used only by tests                                                     |
| `ALTEGIO_E2E_EVENT_SERVICE_ID`                         | Optional: a service the team member runs as group events                               |
| `ALTEGIO_E2E_MEMBERSHIP_PRODUCT_ID`                    | Optional: a product that sells a membership activated on the first visit               |

Without an optional id, the runs that need it are skipped.

Rules the suites follow, and a new suite must follow too:

- Every write is reverted by the suite that made it, and the suite checks the
  location reads back as before: financial transactions and inventory
  documents are deleted, payments cancelled, consumables cleared, appointments
  deleted. A write without a reversal (a client account deposit, for one) is
  not tested.
- Writes go through `tools/call` of a host without forms, so they exercise the
  confirmation token; `src/__tests__/helpers/live.ts` has the host and the
  disposable appointment.
- Appointments are created by the suite, in the past, for the client above,
  with notifications off. Never point a suite at an existing appointment: a
  consumables change detaches its Bill of Materials for good.
- One run at a time per location: the suites compare stock and amounts due, so
  another writer on the same product or register makes them fail.
- A known defect is an `it.failing` test with a comment naming it. When the
  defect is fixed that test fails; make it a plain `it`.

Not covered live: the refusal for an appointment custom field required on
arrival. The flag is set only in the chain's custom field settings in Altegio,
not through the API.

### Scheduled run

`.github/workflows/live.yml` runs every live suite nightly (03:17 UTC) and on
demand from the Actions tab, on `main` of this repository only; it never runs
for a pull request. It stays inert until a maintainer:

1. creates the `live-e2e` environment, with deployments allowed from `main`
   only;
2. adds the environment secrets `ALTEGIO_E2E_PARTNER_TOKEN`,
   `ALTEGIO_E2E_USER_TOKEN` and every `ALTEGIO_E2E_*` id in the table above;
3. sets the repository variable `LIVE_E2E_ENABLED` to `true`.

The log and the job summary are public. Jest runs silent and
`src/__tests__/helpers/live-reporter.cjs` prints test names and short, masked
failure lines only; run a failing suite locally for its details.

## Transport checks

Run `npm run dev:http` or the container described in [CI-CD.md](CI-CD.md).
`GET /health` checks the process. The transport integration suites exercise MCP
initialization, sessions, tool calls, views, identity isolation, and refusals
against a local server using the installed SDK.

## Tool-selection evals

`npm run eval` runs realistic owner and administrator requests through a real
MCP host against a local server and scores whether the agent reaches the right
tool with arguments it accepts, once per view. It is opt-in, needs a host CLI
and the live credentials, and sends a read-only grant, so writes are chosen and
scored but never run. See [evals/README.md](evals/README.md). A change to the
compact listing (what `/mcp` lists by default), the dispatcher or a description
it searches attaches a fresh summary to its pull request.

## Release artifact checks

Build and stamp the exact checkout, then test the tarball from a separate
consumer directory and the container through a loopback-published port:

```sh
npm run build
node scripts/smoke/stamp-build.mjs "$(git rev-parse HEAD)"
mkdir -p /tmp/altegio-release-check
npm pack --ignore-scripts --pack-destination /tmp/altegio-release-check
node scripts/smoke/package.mjs /tmp/altegio-release-check/*.tgz "$(git rev-parse HEAD)"
docker build --build-arg COMMIT_SHA="$(git rev-parse HEAD)" -t altegio-pro-mcp:check .
node scripts/smoke/container.mjs altegio-pro-mcp:check "$(git rev-parse HEAD)"
npx tsx examples/basic-usage.ts
```

The package check verifies file exclusions, source/lockfile provenance, real MCP
initialization, current documented tool/prompt names and byte-exact Markdown
resources from an installed package. The container check verifies Node 26,
UID 1001, OCI revision, `/health` version/commit, published-port reachability
and the same MCP resources. Its synthetic upstream points to a closed loopback
port.
All identities are synthetic; neither probe calls a business API.

CI saves and reloads the image and tests that same image ID. Node 24 installs the
same tarball built on Node 26 after checking its digest. Release promotion follows
[RELEASING.md](RELEASING.md); no npm/image publication is implied.
