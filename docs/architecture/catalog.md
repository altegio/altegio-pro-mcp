# The API catalog

The catalog is the single source of truth for what this server can reach in the
Altegio API. It is generated at build time from the corporate OpenAPI specs plus
a human curation overlay, committed to the repository, and reviewed in pull
requests like any other code.

See [ADR-001](2026-09-07-mcp-platform-architecture.md) D2 (tool tiers), D4
(catalog) and D8 (context economy) for the decisions behind it.

## Pipeline

```
../biz.erp.api.docs                      catalog/overlay/*.yaml
  docs/en/b2b-v1/openapi.yaml   +          domain, tier, facets, tool_name,
  docs/en/b2b-v3/openapi.yaml              description, hidden_params,
  (read-only, never modified)              param_renames, projection,
            │                              write_allowed
            └──────────────┬───────────────────────┘
                           ▼
                 scripts/catalog/build.mjs
                           ▼
               src/generated/catalog.json          (committed)
                           │
        ┌──────────────────┴──────────────────┐
        ▼                                     ▼
  src/tools/executor/                  src/generated/packs/*.ts
  search · describe · call             (later: generated domain tools)
```

The build reads both specs, resolves `$ref`-ed path items and local/relative
schema refs, and writes one entry per operation:

| Field | Notes |
| --- | --- |
| `operationId` | Spec-native identifier; unique across both specs (the build fails on a clash). |
| `method`, `path` | The real HTTP method and path, with the spec's own parameter spelling. |
| `displayPath` | The same path with legacy segments renamed to canonical ones (`{record_id}` → `{appointment_id}`). What the model is shown; `path` is what gets called. |
| `summary`, `description`, `tags`, `domain` | `domain` comes from the OpenAPI tag, or from the overlay when it overrides it. |
| `deprecated`, `security` | Auth requirement and scheme names. |
| `parameters` | Name, `in`, required, one-line description, shallow schema. Transport plumbing (`Accept`, `Authorization`, `Content-Type`, `User-Token`) is dropped by name — several V1 path files declare those as *query* parameters, two of them misspelled. |
| `requestBody`, `response` | Dereferenced to a bounded depth (see below). The V1 `{success, data, meta}` envelope is unwrapped, so the schema describes the payload a caller actually receives. |
| `source`, `status` | `v1` is live; `v3` is the preview contract, carrying `x-altegio-status`. |
| `curation` | Whatever the overlay says about this operation. |

### Bounded depth (D8)

Schemas are dereferenced to `MAX_SCHEMA_DEPTH` levels. Anything deeper collapses
to `{"x-truncated": true}`; a reference cycle collapses to `{"x-circular": …}`.
A schema that still serializes to more than `MAX_SCHEMA_BYTES` is rebuilt one
level shallower until it fits, and the level it settled on is recorded as
`x-depth-limited`. This is what keeps an `altegio_describe_operation` result
inside the per-result token budget.

A `properties` map is not itself a depth level — otherwise truncation would erase
whole field lists instead of the objects behind them.

### Determinism

`catalog.json` is written by a custom serializer with a stable key order:
catalog-structure keys in the order a reviewer reads them, everything else
alphabetically. Free-form maps whose keys are data (`schema`, `properties`,
`param_renames`, `canonicalAliases`) sort alphabetically throughout. Operations
sort by source, then path, then method. Two builds of the same inputs therefore
produce a byte-identical file, which is what makes `catalog:check` a meaningful
drift gate and the diffs reviewable.

## Running the build

```bash
git -C ../biz.erp.api.docs pull origin master   # spec first, always
npm run catalog:build                           # rewrite src/generated/catalog.json
npm run catalog:check                           # what CI runs: fail if the committed file is stale
```

Flags: `--docs <path>` (spec repository), `--overlay <dir>`, `--out <file>`,
`--check`, `--quiet`. An explicit `--docs`, or `ALTEGIO_API_DOCS`, is
authoritative — if the spec is not there the build reports it missing rather
than quietly using another checkout. Without either, the build looks for a
`biz.erp.api.docs` sibling of the repository root or of any ancestor, which is
what makes it work inside a git worktree.

### Behaviour without the spec repository

The spec repository is private and CI does not clone it. When it is absent both
commands print a notice and exit 0 — `catalog:check` is **skipped with a notice
in CI**, and only fails when the spec *is* present and the committed catalog is
stale. Practically that means the drift gate runs on a developer machine (and in
the `scripts/catalog/__tests__/build.test.ts` suite, which skips the same way);
CI protects against nothing worse than a missed rebuild, which the reviewer sees
as an unexpected `catalog.json` diff.

## The overlay

`catalog/overlay/` is the human-authored half: the spec says what an operation
**is**, the overlay says how the product **exposes** it. Format reference and an
annotated example live in
[`catalog/overlay/_schema.yaml`](../../catalog/overlay/_schema.yaml); the rules
and workflow are in [`catalog/overlay/README.md`](../../catalog/overlay/README.md).

Fields: `domain`, `tier` (`core` | `pack` | `executor-only`), `facets`,
`tool_name`, `description`, `hidden_params`, `param_renames` (legacy → canonical,
e.g. `staff_id` → `team_member_id`), `projection` (result field allowlist),
`write_allowed`, `notes`. Every field is optional; an unknown field, an invalid
`tier` or a duplicate `operationId` fails the build, and an overlay entry that
matches no operation is reported as a warning — that is the drift signal when the
spec repository renames or drops an operation.

`catalog/overlay/existing-tools.yaml` records the operations already covered by
the hand-written tools (seeded from `src/tools/api-mapping.ts`) with their tool
names and domains, so a generated pack can never claim a name a hand-written
tool already owns.

## How the executor consumes it

`src/tools/executor/` reads `catalog.json` through a typed loader
(`catalog.ts`) and nothing else — no spec repository at runtime, no network:

- `search.ts` — weighted term index over `operationId`, summary, tags, domain,
  path and parameter names, with canonical/legacy vocabulary synonyms so a query
  in either glossary reaches the operation. Deterministic, hence testable.
- `describe.ts` — renders one entry as a contract: parameters with types and
  requiredness, request and response shapes, auth, deprecation, source/status,
  the curated tool that may already do the job, and the canonical-alias notes.
- `call.ts` — binds canonical parameter names onto the spec's spelling, validates
  against the catalog, builds path and query, and refuses anything that is not a
  documented V1 `GET`.
- `budget.ts` — the overlay `projection` allowlist and the result size budget.

`src/tools/definitions/executor.tools.ts` wraps those in three `defineTool`
definitions, so the executor is registered exactly like every other tool.

### Why no `ajv`

Parameter validation is a shallow type/enum check written by hand rather than a
JSON-Schema engine. The catalog stores path and query parameter schemas one level
deep, so every value the executor validates is a scalar or a list of scalars;
adding `ajv` + `ajv-formats` as runtime dependencies to a public server in order
to check `type: integer` is not a trade worth making. When the executor write
allowlist lands, request *bodies* will need real schema validation — that is the
point to reconsider, and the decision should be revisited then, not now.

## How generated packs will consume it

Packs are not generated yet. The intended shape (ADR-001 D4):

1. Curate a domain in `catalog/overlay/<domain>.yaml`: set `tier: pack`, a
   `tool_name` per operation, a description in the user's words, `hidden_params`,
   `param_renames` and a `projection`.
2. `scripts/catalog/build.mjs` gains an emitter that writes
   `src/generated/packs/<domain>.ts`: one `defineTool` per curated operation,
   with the Zod input schema derived from `parameters` + `requestBody` (minus
   `hidden_params`, renamed per `param_renames`), the curated description, MCP
   annotations from the method, and a handler that calls the `AltegioApi` port
   and applies the `projection`.
3. The generated modules are committed and reviewed, so `tools/list` is a diff.
4. `catalog:check` keeps them honest: an operation that changes or disappears in
   the spec fails the gate until the overlay is updated.

Until then, everything not covered by a hand-written tool is reachable through
the executor, which is the point of the third tier.

## Current numbers

Rebuild and read the summary line for the live figures:

```
$ npm run catalog:build
  v1  docs/en/b2b-v1/openapi.yaml → 260 operations
  v3  docs/en/b2b-v3/openapi.yaml → 57 operations
catalog: 317 operations, 25 curated, 30 domains, 1709 KB → src/generated/catalog.json
```

`catalog.json` is excluded from eslint and prettier (it is reviewed as data, and
prettier would reformat it and break the byte comparison) but is committed.
