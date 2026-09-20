# Legacy endpoint discovery playbook

Use this playbook when a valuable owner or administrator workflow is missing
from the public API, especially while an equivalent V3 contract is pending. It
turns backend and ERP-web research into a temporary, testable MCP capability
without making the legacy route part of the agent-facing contract.

The durable product is the canonical MCP tool. The legacy route, HTML layout or
workbook is a replaceable adapter implementation.

## 1. Start with a decision, not a route

Write the business question before searching code. Good candidates help a
location owner or administrator make a recurring decision, for example:

- which clients should be reactivated;
- where scheduled capacity is unused;
- which services or products contribute most;
- what inventory needs reordering;
- where money moved during a period.

Record the expected dimensions, measures, filters and next action. Do not add a
tool merely because a report exists. Prefer task-shaped tools that answer one
decision over thin wrappers around report pages.

Check the existing surface first:

1. Search tool names and descriptions in `src/tools/definitions/`.
2. Search the generated catalog with `altegio_search_operations` or
   `src/generated/catalog.json`.
3. Pull and inspect the v1 and V3 preview OpenAPI specifications.
4. Read the analytics coverage, glossary and relevant source-audit documents.

If documented JSON already supplies the required facts, use it. HTML or
workbook parsing is a temporary fallback, not the default.

## 2. Find candidate sources in `biz.erp`

The route inventory is the broad map. Keep its output in the gitignored
`.inventory/` directory because this repository is public:

```bash
npm run api:inventory
```

For a focused investigation, search in this order:

1. Route registrations under
   `../biz.erp/src/Application/Http/Routing/Routes/`.
2. API and page controllers under
   `../biz.erp/src/Application/Http/Controllers/` and
   `../biz.erp/src/Application/Http/PageControllers/`.
3. Services, renderers, tables and exports used by the controller.
4. Templates and frontend calls that reveal table columns, paging and filter
   names.
5. Permission checks, feature flags and domain-zone behavior.

Useful searches, adjusted to the owner's vocabulary and its legacy synonyms:

```bash
rg -n -i "retention|workload|turnover|sales.analysis|annual.report" \
  ../biz.erp/src/Application/Http/Routing/Routes \
  ../biz.erp/src/Application/Http/Controllers \
  ../biz.erp/src/Application/Http/PageControllers

rg -n "<route-fragment>|<controller-class>" ../biz.erp/src

rg -n -i "access|permission|feature.flag|start_date|end_date|page|limit" \
  ../biz.erp/src/path/to/the/controller \
  ../biz.erp/src/path/to/its/service
```

Search both canonical and legacy terms: location/company/salon,
team-member/staff/master/employee, appointment/record, product/goods, and so
on. Legacy names are discovery inputs only; they must not escape the adapter.

## 3. Trace the complete source contract

Do not infer the contract from the visible table alone. Trace every layer and
write down:

- HTTP method and exact path;
- whether the response is JSON, a JSON envelope containing HTML, plain HTML,
  BIFF8/XLS or XLSX;
- all accepted filters, defaults, sentinels and inclusive/exclusive date rules;
- upstream pagination, totals and maximum practical result size;
- access rights, feature flags, license checks and the status returned when
  access is missing;
- whether the requested period can be silently changed;
- stable identifiers present in links, data attributes, adjacent chart data or
  exports;
- localization of dates, decimal separators, thousands separators and labels;
- whether totals overlap dimensions and therefore must not be added;
- privacy-sensitive fields and whether masking is preserved;
- mutations or saved-report side effects hidden behind a nominally reporting
  route.

Read the controller's filter builder and permission branches, then the service
or table that calculates each measure. A column title is not a definition.
For every metric, establish its numerator, denominator, period, unit and
whether it is authoritative or derived.

## 4. Score and reject candidates

Prefer a candidate when it has all of the following:

- a recurring business question with clear demand;
- a read-only, location-scoped source available to ordinary business users;
- useful filters and a bounded result;
- stable identifiers for rows that will be referenced later;
- metrics whose meaning can be proven from backend code;
- a safe stateless authentication path;
- a plausible future V3 replacement behind the same canonical contract.

Reject or postpone it when:

- it is for super-users, support, security, marketplace administration or the
  public booking persona;
- it relies on a browser cookie, interactive session or browser automation;
- it creates saved reports, queues an unbounded export or mutates business
  data as a side effect;
- an all-time or clamped result could be mislabeled as the requested period;
- identities can only be guessed from non-unique display names;
- permissions expose sensitive fields that cannot be reliably withheld;
- the source is unbounded or partial without detectable pagination;
- its numbers cannot be given a precise business definition.

An unavailable field stays `null` with an explicit coverage reason. Never
manufacture an identifier, silently drop rows or substitute a neighboring
metric.

## 5. Capture the investigation

Keep raw route inventories and sanitized response captures in `.inventory/`.
Commit only the durable contract evidence:

- an `extended` catalog entry for every undocumented route used;
- source-shaped, sanitized golden fixtures;
- a source-audit document containing filters, permissions, formulas and
  limitations;
- the canonical vocabulary mapping;
- tests that pin the route and parsed contract.

Use this candidate record while investigating:

| Field                | Required content                                        |
| -------------------- | ------------------------------------------------------- |
| Owner question       | The decision the tool enables                           |
| Existing alternative | Current MCP tool or documented API, if any              |
| Source               | Route, controller, service/renderer and response format |
| Access               | Permissions, feature flags, license and persona         |
| Filters              | Canonical filters and exact legacy mapping              |
| Measures             | Formula, unit, period and authority                     |
| Dimensions           | Stable IDs, labels and hierarchy                        |
| Bounds               | Pagination, byte limits and narrowing strategy          |
| Privacy              | Contact or financial fields and withholding rule        |
| Failure modes        | Redirects, clamping, empty states and layout drift      |
| V3 migration         | Intended future operation or capability                 |
| Decision             | Implement, postpone or reject, with reason              |

## 6. Build a temporary legacy adapter

Follow the same boundary used by the analytics pack:

1. Define canonical request and result types in the domain API port.
2. Put paths, legacy parameter names, numeric codes and markup knowledge only
   in the v1 adapter and parser.
3. Keep calculations and cross-source composition in the capability layer.
4. Publish a task-shaped tool with a closed input and output schema.
5. Add the route to `catalog/extended/` and the tool-to-source mapping.
6. Add the tool to the intended static facets and scope map.

JSON is preferred. For legacy ERP-web reports, use the existing stateless
`requestLegacyWebReport` transport. It injects the request-scoped user token as
`user_hash`, omits cookies, refuses redirects and keeps credential-bearing URLs
out of errors. Altegio uses `https://app.alteg.io`; a YCLIENTS deployment must
select `https://yclients.com` explicitly.

Parsers must:

- enforce declared byte limits before and while reading;
- accept only known source structures and fail loudly on drift;
- normalize supported locales deliberately;
- preserve upstream pagination and authoritative totals;
- sanitize every source-controlled label as untrusted data;
- withhold contacts by default and preserve source masking;
- return a narrowing instruction instead of truncating silently.

## 7. Design the canonical MCP contract

The tool boundary uses the product glossary and matches neighboring MCP tools:

- `location_id`, `team_member_id`, `appointment`, `product`, `membership` and
  the other V3 concepts;
- one shared name for the same measure across tools;
- ISO dates and currency codes;
- major-unit decimal amounts for analytics results;
- explicit enums rather than source numeric codes;
- complete nested JSON Schema properties, nullability and enums;
- canonical provenance identifiers, never raw legacy route strings.

Descriptions must state what the metric means, which neighboring tool to use
for a different question, and any important limitation. Distinguish observed
amounts, source totals and MCP estimates. Do not combine overlapping or
conceptually different values into a misleading grand total.

Keep the canonical contract stable when V3 arrives. Replace the adapter, not
the tool name or business vocabulary.

## 8. Verification ladder

Every new legacy-backed capability passes all layers:

1. Parser fixtures for every supported layout and locale.
2. Adapter tests for exact path, filters, authentication, redirects,
   permissions, size bounds and secret-safe errors.
3. Capability tests for formulas, identity ambiguity, missing fields and
   period correctness.
4. A terminology scan that includes property names, descriptions and primitive
   strings inside enum arrays.
5. Validation of fixture-produced `structuredContent` against the published
   output schema, including nested objects.
6. Surface, scope, catalog and untrusted-text coverage tests.
7. An opt-in bounded live smoke on the demo location with real delegated auth.
8. Post-merge verification of the production commit, effective legacy origin,
   container health and authenticated public health endpoint.

Run the repository gates:

```bash
npm test -- --runInBand
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run catalog:check
npm run surface:check
npm audit --omit=dev
```

Live tests report pass, skip and fail separately. A permission-gated feature is
not a parser success; an empty but valid report is not a failure. Never print or
persist credentials or client data.

## 9. Proven examples

- `2026-09-19-next-legacy-analytics.md` documents capacity, group events,
  product sales and cash flow.
- `analytics-decision-tools-sources.md` documents the composite P&L, capacity
  heatmap, revenue leakage, team-member/service matrix and inventory reorder
  tools.
- `catalog/extended/analytics.yaml` records their undocumented source
  contracts.
- `src/api/v1/__tests__/legacy-analytics-live.test.ts` is the bounded live
  verification entry point.

These examples are evidence for the process, not a reason to assume another
report has the same permissions, filters or markup.
