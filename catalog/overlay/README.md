# Curation overlay

The overlay is the human-authored half of the API catalog (ADR-001 D4). The
OpenAPI spec in `../../../biz.erp.api.docs` says what an operation **is**; the
overlay says how this product **exposes** it — tool name, domain, tier, facets,
description, hidden parameters, canonical parameter names, result projection and
the executor write allowlist.

```
../biz.erp.api.docs (b2b-v1, v2, v3)  +   catalog/overlay/*.yaml
                              │
                    scripts/catalog/build.mjs
                              ▼
                   src/generated/catalog.json     (committed, reviewed in PRs)
```

## Files

| File                  | Purpose                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_schema.yaml`        | Field-by-field format reference with an annotated example. Files starting with `_` are documentation and are **not** read by the build.                                                    |
| `existing-tools.yaml` | The operations already covered by the hand-written tools in `src/tools/definitions/` — their tool names and domains, so a future generated pack never claims a name that is already taken. |
| `<domain>.yaml`       | One file per domain as packs get curated.                                                                                                                                                  |

## Shape

Each data file is keyed by `operationId` — the identifier from the OpenAPI spec,
unique across the specs and verified as such by the build. A V2 id is used
without the spec's `_v2` suffix:

```yaml
version: 1
operations:
  list_team_members:
    domain: team_members
    tier: core
    facets: [ops, catalog]
    tool_name: team_members_list
    supersedes: [get_team_member_list]
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
- **V2 is canonical; V1 fills the gaps.** When V1 and V2 both offer a
  capability, curate the V2 operation. If the V1 twin has a different
  `operationId`, name it under `supersedes`; a twin with the same id is retired
  without being listed. Curation left on a retired V1 operation fails the build.
  Keep a V1 operation only when V2 lacks what it does, and say why in `notes`.
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
