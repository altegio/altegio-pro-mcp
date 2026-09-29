# OpenAPI Specification

The tool catalog (`src/generated/catalog.json`) and the spec-compliance tests are
built from the Altegio B2B OpenAPI specification. The public reference is
published at <https://developer.alteg.io/api>; the build reads a local checkout
of the specification repository.

## Location of the specification

Set `ALTEGIO_API_DOCS` to the root of the checkout. Without the variable the
build looks for a sibling directory named `biz.erp.api.docs` next to this
repository. Inside the checkout the build reads:

- `docs/en/b2b-v1/openapi.yaml` — V1, the live API for what V2 does not cover
  (path items under `docs/en/paths/**`, schemas under `docs/en/schemas/**`)
- `docs/en/b2b-v2/openapi.yaml` — V2, the live JSON:API tree the ERP web client
  uses and the canonical contract wherever it covers a capability. The build
  retires each V1 operation that V2 replaces (see
  [the catalog](docs/architecture/catalog.md#v2-supersedes-v1)); V2 reads are
  callable through the executor
- `docs/en/b2b-v3/openapi.yaml` — V3 preview, described in the catalog but not
  callable yet

The checkout is read-only for this project. Corrections to the specification
belong in the specification repository.

## Commands

```bash
npm run catalog:build   # rebuild src/generated/catalog.json
npm run catalog:check   # CI gate; skipped with a notice when no checkout is found
npm run api:inventory   # spec inventory, written to the gitignored .inventory/
```

Pull the latest specification before rebuilding the catalog, and commit the
regenerated `src/generated/catalog.json` in the same pull request. Never edit the
generated file by hand.
