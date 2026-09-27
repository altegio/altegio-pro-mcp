# API inventory

Measures how much of the Altegio API is documented. The numbers feed
[ADR-001](../../docs/architecture/2026-09-07-mcp-platform-architecture.md) and
the catalog build; they are not used at runtime.

All output goes to `.inventory/` (gitignored). Keep it that way: this
repository is public, and inventories of undocumented routes observed from the
product's web client must never be committed.

## Documented operations (spec repository)

```bash
git -C "$ALTEGIO_API_DOCS" pull origin master
npm run api:inventory            # → .inventory/documented-ops.tsv
```

`ALTEGIO_API_DOCS` points at a checkout of the Altegio API OpenAPI repository
(the same variable the catalog build uses; `--docs <path>` overrides it). The
script prints paths and operations per spec (`public`, `b2b-v1`, `b2b-v2`,
`developers`, `b2b-v3`) and the v1 breakdown by tag.

## Undocumented operations

Undocumented routes are discovered black-box, by observing the product's web
client, and are recorded only as allowlisted stubs with golden fixtures in
`catalog/extended/`. The method is described in
[`legacy-endpoint-discovery.md`](../../docs/architecture/legacy-endpoint-discovery.md).
