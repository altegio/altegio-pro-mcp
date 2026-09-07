# API inventory

Measures how much of the Altegio API is documented, and where the undocumented
surface lives. Numbers feed [ADR-001](../../docs/architecture/2026-09-07-mcp-platform-architecture.md)
and the catalog build; they are not used at runtime.

All output goes to `.inventory/` (gitignored). This repository is public and the
backend route map is internal — never commit the generated TSV files.

## 1. Documented operations (spec repository)

```bash
git -C ../biz.erp.api.docs pull origin master
npm run api:inventory            # → .inventory/documented-ops.tsv
```

Prints paths and operations per spec (`public`, `b2b-v1`, `b2b-v2`, `developers`,
`b2b-v3`) and the v1 breakdown by tag.

## 2. Backend routes (private backend checkout, optional)

```bash
php scripts/api-inventory/dump-slim-routes.php .inventory/backend-routes.tsv \
  ../biz.erp/src/Application/Http/Routing/Routes/api/api.php \
  ../biz.erp/src/Application/Http/Routing/Routes/api/api_legacy.php \
  ../biz.erp/src/Application/Http/Routing/Routes/api/booking.php \
  ../biz.erp/src/Application/Http/Routing/Routes/api/backoffice.php
```

The script loads each route file with a stub `$app` that records group prefixes
and route registrations; no framework bootstrap or database is required.

## 3. Compare

```bash
node scripts/api-inventory/compare-routes.mjs   # → .inventory/undocumented-v1.tsv
```

Reports backend `/api/v1` routes without a documented operation (grouped by
route file and by leading path segments) and documented operations without an
exact backend match (aliases such as `{location_id}` vs `{salonId}` are
normalized; remaining mismatches need review).
