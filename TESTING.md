# Testing

Use the committed lockfile and a supported Node.js version:

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test -- --runInBand
npm run build
npm run catalog:check
npm run surface:check
```

`npm run test:coverage` adds coverage reporting. `npm run test:watch` runs Jest
in watch mode. Default tests use mocked upstream responses and local HTTP
servers; no real credentials or business data are needed.

The catalog check requires an OpenAPI checkout. Set `ALTEGIO_API_DOCS` to its
root; without it, the check reports a skip. Tests still validate the committed
catalog. Regenerate with `npm run catalog:build` after reviewing spec changes.
The surface check is self-contained; regenerate with `npm run surface:build`.

## Live integration tests

Live suites are explicitly opt-in. Read the environment guards at the top of
`src/__tests__/*live.test.ts` and `src/api/v1/__tests__/analytics-live.test.ts`
before running them. Use a dedicated disposable location and credentials with
appropriate rights. Appointment suites create and remove real entities; cleanup
can fail when upstream access is lost. Never enable live flags in default CI.

## Transport checks

Run `npm run dev:http` or the container described in [CI-CD.md](CI-CD.md).
`GET /health` checks the process. The transport integration suites exercise MCP
initialization, sessions, tool calls, views, identity isolation, and refusals
against a local server using the installed SDK.

## Release artifact checks

After a clean build, inspect `npm pack --dry-run --json`. The package must contain
both runtime documentation resources and the generated catalog, and must exclude
test helpers, fixtures, credentials, and local agent state.
