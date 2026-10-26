# Testing

Use the committed lockfile and a supported Node.js version:

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run catalog:check
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

The catalog check requires an OpenAPI checkout. Set `ALTEGIO_API_DOCS` to its
root; without it, the check reports a skip. Tests still validate the committed
catalog. Regenerate with `npm run catalog:build` after reviewing spec changes.
The surface check is self-contained; regenerate with `npm run surface:build`.

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

After a clean build, inspect `npm pack --dry-run --json`. The package must contain
both runtime documentation resources and the generated catalog, and must exclude
test helpers, fixtures, credentials, and local agent state.
