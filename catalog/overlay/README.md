# Curation overlay

The overlay is the human-authored half of the API catalog (ADR-001 D4). The
OpenAPI spec in `../../../biz.erp.api.docs` says what an operation **is**; the
overlay says how this product **exposes** it — tool name, domain, tier, facets,
description, hidden parameters, canonical parameter names, result projection and
the executor write allowlist.

```
../biz.erp.api.docs (b2b-v1, b2b-v3)   +   catalog/overlay/*.yaml
                              │
                    scripts/catalog/build.mjs
                              ▼
                   src/generated/catalog.json     (committed, reviewed in PRs)
```

## Files

| File | Purpose |
| --- | --- |
| `_schema.yaml` | Field-by-field format reference with an annotated example. Files starting with `_` are documentation and are **not** read by the build. |
| `existing-tools.yaml` | The operations already covered by the hand-written tools in `src/tools/definitions/` — their tool names and domains, so a future generated pack never claims a name that is already taken. |
| `<domain>.yaml` | One file per domain as packs get curated. |

## Shape

Each data file is keyed by `operationId` — the identifier from the OpenAPI spec,
unique across the v1 and v3 specs and verified as such by the build:

```yaml
version: 1
operations:
  get_team_member_list:
    domain: team_members
    tier: core
    facets: [ops, catalog]
    tool_name: get_staff
    description: List the team members of a location with positions and ratings.
    hidden_params: [internal_flag]
    param_renames:
      staff_id: team_member_id
    projection: [id, name, specialization]
    write_allowed: false
    notes: Hand-written tool; the generated pack must not claim this name.
```

Every field is optional. Fields not listed in `_schema.yaml` fail the build, as
does an invalid `tier` or a duplicate `operationId` across overlay files. An
entry whose `operationId` is absent from the specs is reported as a warning —
that is the drift signal when the spec repository renames or drops an operation.

## Rules

- **Canonical terminology only** in anything the model reads (`tool_name`,
  `description`, `param_renames` targets, `projection` field names):
  `location`, `team_member`, `appointment`, `visit`, `client`, `service`,
  `products`, `membership`, `gift_card`, `client_account`, `receptionist`,
  `analytics`. Spec-native `operationId`s and real HTTP paths stay verbatim —
  they are identifiers, not prose.
- **`param_renames` is a naming decision, not a translation layer.** V1 accepts
  the canonical aliases (`location_id`, `team_member_id`, `appointment_id`,
  `product_id`) on the wire alongside the legacy names, so a rename only changes
  what the model is told to send.
- **`write_allowed` is the executor write allowlist** (ADR-001 D2) and defaults
  to false. The current executor refuses every non-GET operation regardless, so
  setting it today only records intent.
- **`projection` keeps results inside the size budget** (ADR-001 D8). Prefer a
  short allowlist of fields with ids over a whole API object.

## Workflow

```bash
git -C ../biz.erp.api.docs pull origin master   # spec first, always
npm run catalog:build                           # rebuild src/generated/catalog.json
npm run catalog:check                           # what CI runs: fails if the committed file is stale
```

`catalog:check` is a no-op with a notice when the spec repository is not present
(CI does not clone it), so a contributor without the private spec checkout can
still run the full quality gate.

See `docs/architecture/catalog.md` for the pipeline and for how generated packs
will consume the catalog.
