# Task brief — Analytics pack for Altegio Pro MCP

- **For:** a new, clean Claude Code session in `/Users/ypetrou/Developer/altegio-pro-mcp`.
- **Depends on:** [ADR-001](../architecture/2026-09-07-mcp-platform-architecture.md) (platform architecture). This task is the first domain pack built under it.
- **Local research artifact (not committed, repo is public):** `.inventory/analytics-endpoints-inventory.md` — endpoint-by-endpoint inventory of the backend with controller paths, permissions, request/response shapes and caveats. Read it in full before designing anything. If the file is missing, regenerate the inventory from `../biz.erp` (routes in `src/Application/Http/Routing/Routes/api/api.php`, controllers under `Api/Analytics`, `Api/AnalyticsConstructor`, `Api/Reports`, `PageControllers/Web/Yclients/Salon/Analytics/PageAnalyticsController.php`).

## 0. Goal and non-goals

**Goal.** Give a business owner or receptionist working inside one location a complete analytics surface through MCP: key metrics with period comparison, daily series, breakdowns, receptionist performance, loyalty program results, day-end report, team member workload, per-client visit statistics, and the report builder (Analytics Constructor) with its 24 templates and 4 datasets — all expressed in **canonical product terminology**, never in the legacy API vocabulary.

**Non-goals.** Chain-level analytics, inventory/stock reports, payroll period sheets, reviews and ratings statistics, online booking funnel, cash-account balances — these exist only behind the ERP web session (see §2C) and must not be faked. Do not build the full catalog generator from ADR-001 D4; build the minimum this pack needs (§4.7).

## 1. Terminology — the non-negotiable rule

Every tool name, parameter, result field, description, resource and prompt uses the canonical vocabulary. Legacy API names are mapped once, inside the adapter, and never leak outward.

**Sources of truth, in precedence order:**
1. `../biz.erp/docs/product-glossary.md` — canonical English terms and forbidden synonyms.
2. `../biz.erp/docs/translations/glossary/terminology.md` — localized forms and additional metric names; grep it for the metric words below before inventing one.
3. `../biz.erp.api.docs/docs/en/b2b-v3/openapi.yaml` — V3 object types (`location`, `team_member`, `service`, `client`, `appointment`, `visit`, `payment`, `position`, `resource`).
4. ADR-001 §5 tool design rules.

**Mapping table (legacy → canonical). Extend it in `src/capabilities/analytics/vocabulary.ts`; the table is the single place where legacy words are allowed.**

| Legacy in API / code | Canonical (use everywhere) | Notes |
|---|---|---|
| `company`, `salon`, `salonId` | `location`, `location_id` | |
| `staff`, `master`, `employee`, `master_id`, `staff_id` | `team_member`, `team_member_id` | v1 accepts `team_member_id` as an alias on the wire (`ApiParamAliasRegistry`); prefer it |
| `user_id` (ERP user who created the appointment) | `created_by_user_id` | describe as "location user (usually a receptionist) who created the appointments" |
| `administrator` analytics | `receptionist` | glossary: Receptionist, not Administrator |
| `record`, `records` | `appointment`, `appointments` | |
| `visit` | `visit` | the paid/attended grouping of appointments — keep |
| `attendance`, `record_status` | `visit_status` | enum: `pending`, `confirmed`, `arrived`, `no_show`, `cancelled` — verify exact set against `CTTRecord::$attendanceStatuses` and V3 `appointment` status |
| `fullness`, `workload` (percent) | `occupancy`, `occupancy_percent` | `workload` per team member per day = `occupancy_percent` too |
| `income_*` in sales analytics | `revenue_*` | revenue = money from services, products, memberships, gift cards, client account top-ups |
| Income / Expenses in financial transactions dataset | `income`, `expenses` | glossary section "Income and Expenses" — cash-flow, not sales |
| `income_average`, average check, AOV | `average_bill` (decide once; check `terminology.md`) | document the formula: (revenue + top-ups) / (unique visits + visit-less appointments + product-sale documents) |
| `goods`, `good` | `products`, `product` | |
| `abonement` | `membership` | |
| `certificate` | `gift_card` | |
| `deposit`, `refill` | `client_account`, `client_account_top_up` | glossary: Client Account, never Deposit |
| `loyalty card`, `loyalty program` | `loyalty_card`, `loyalty_program` | unchanged |
| `z_report`, Z-report | `day_end_report` | docs already call it "day-end report" |
| `statistic(s)` | `analytics` | |
| `stat_access`, `reports_access` … | `analytics_access_right` in messages | say "the user has no Analytics access right in this location" |
| `activity`, `group event` | `group_event` | |
| `RFM overall` | `forecast` (revenue and visits forecast vs actual) | the endpoint is a forecast comparison, not RFM segmentation — do not call it RFM |

Forbidden in any outward-facing identifier or text: `staff`, `master`, `employee`, `company`, `salon`, `record`, `goods`, `abonement`, `certificate`, `deposit`, `fullness`, `administrator`, `statistics`, `z_report`. Add a unit test that scans every tool name, input/output schema property and description for these words.

## 2. Source endpoints

All calls: `Authorization: Bearer <partner>, User <user>`, `Accept: application/vnd.api.v2+json`. Send `Accept-Language: en` so label-only series come back in English and can be mapped to canonical enums.

### 2A. Documented in the spec (`../biz.erp.api.docs/docs/en/paths/analitycs/*`, `z-report/*`)

| Endpoint | What | Notes |
|---|---|---|
| `GET /company/{location_id}/analytics/overall` | 8 KPI blocks: revenue total / services / products, average bill, average services bill, occupancy, appointments by status, clients new / returning / lost — each with previous-period value and `change_percent` | params `date_from`, `date_to` (`YYYY-MM-DD`, inclusive, ≤ 365 days), `team_member_id`, `position_id`, `user_id`. Money as **strings** in major units + `currency` object. Previous period = same length immediately before. Lost clients threshold = per-location setting, default 60 days. New/returning are deduplicated by phone. Permission `reports_access` or `reports_basic_metrics_access` |
| `GET …/analytics/overall/charts/income_daily` | daily revenue series: total / services / products | **raw array, no envelope**; series carry `slug` |
| `GET …/charts/records_daily` | daily appointments: total / online / from new clients | raw array; series have **no slug**, only localized labels — positional order is the contract |
| `GET …/charts/fullness_daily` | daily occupancy %: booked / no-show share | raw array; slugs `fullness_spent`, `fullness_no_show` |
| `GET …/charts/record_source` | appointments by source (pie) | label-only |
| `GET …/charts/record_status` | appointments by visit status (pie) | label-only |
| `GET …/analytics/loyalty_programs/{visits,income,staff}` | loyalty program results: clients new/old/total, revenue, per team member | `loyalty_program_id` required |
| `GET /reports/z_report/{location_id}` | day-end report: totals, takings per account, discounts, per-client detail | dates in **`d.m.Y`**; `master_id`, `account_id`, `status`; silently clamps to today without `finances_z_report_no_limit_today_access`; permission `finances_z_report_access` or `finances_access`; requires active license; `currency` is a bare string |

### 2B. Undocumented — allowed only through `catalog/extended/analytics.yaml` stubs + golden tests (ADR-001 D4)

| Endpoint | What | Notes |
|---|---|---|
| `GET …/analytics/overall/charts/clients_daily` | daily clients total / new / returning | slugs `clients_total`, `clients_new`, `clients_returned` |
| `GET …/analytics/administrator/{clients_scheduled, records_closed, income, visited_clients_rescheduled, canceled_clients_rescheduled}` | receptionist performance: clients booked by receptionists, appointments closed, revenue attributed, rebooking rate after a visit, rebooking rate after a no-show | `date_from`/`date_to`, optional `user_id`; `include=*_daily`; permission `reports_access` or `reports_admins_access`, or the receptionist's own `user_id` |
| `GET …/analytics/rfm/overall` | revenue and visits **forecast vs actual** (BTYD model) | optional `start_date`/`end_date`; behind feature flag `ANALYTICS_RFM`; empty container when no prediction — not an error |
| `GET …/staff/workload` | per-day occupancy for one team member | `start_date`/`end_date` required; payload has no team member id — call once per `team_member_id`; permission `timetable_access` |
| `GET /api/v2/locations/{location_id}/clients/{client_id}/attendances_statistic` | per-client visit statistics: successful / failed visits, spent, paid, client account balance, last visit | JSON:API resource; internal v2 — wrap read-only |
| `GET …/analytics_reports` | catalogue of built-in report names | discovery only; its URLs point at web pages |
| **Analytics Constructor (gen-2)** `GET/POST …/analytics_constructor/reports`, `GET/POST …/reports/{id}`, `POST …/reports/{id}/data`, `GET …/reports/{id}/filter_options/{filter_id}`, `GET …/analytics_constructor/columns`, `GET …/report_templates`, `GET …/template_suggestions` | report builder: 4 datasets (`olap_services_goods` = sales, `olap_financial_transactions`, `olap_loyalty`, `olap_masters_schedules` = team member schedules), 565 visible columns (≈ 165 curated `is_default`, the rest are mechanical `_sum/_avg/_count…` variants), 24 templates (17 static, 7 dynamic by day/week/month/year), filters with operators, runtime period override via `/data` `filters[{id, operator, value:{from,to}}]` | `/data` is **unbounded** (no pagination); permission `reports_access` returns **404, not 403**; `columns` and `report_templates` endpoints have no permission check (do not rely on it); requires active license; gen-2 has no delete — reports created by the MCP stay visible in the user's constructor |
| Gen-1 `…/ac/*` | legacy builder with sorting, `select_function`, delete, synchronous Excel | use only if gen-2 is disabled for the location (feature flag `isNewQueryBuilderAnalyticsConstructor`); otherwise ignore |

### 2C. Not reachable through the API (web session only) — do not attempt, list them in the resource `altegio://analytics/coverage`

Sales by team member / by service / by client pages, team-member dynamics, workload matrix, client retention cohorts page (the **"Client retention" constructor template** covers most of it), reviews and ratings, per-client RFM factors, finance dashboard and cash-account balances, account-period and annual finance reports, inventory turnover and write-off analysis, payroll period sheets, online booking funnel (does not exist anywhere), client segments (Altegio staff only).

## 3. Target tool surface (`analytics_` pack)

All tools are read-only (`readOnlyHint: true`, `openWorldHint: true`), take `location_id` first, accept either `date_from` + `date_to` (`YYYY-MM-DD`, inclusive) or a `period` preset (`today`, `yesterday`, `this_week`, `last_week`, `this_month`, `last_month`, `last_30_days`, `this_quarter`, `last_quarter`, `this_year`), resolved in the **location's timezone**, and refuse ranges over 365 days with an actionable message.

| Tool | Purpose | Source | Result (canonical) |
|---|---|---|---|
| `analytics_get_overview` | key metrics for a period with comparison to the previous period; optional filter by `team_member_id`, `position_id`, `created_by_user_id` | overall | `{period, previous_period, revenue:{total,services,products}, average_bill, average_services_bill, occupancy_percent, appointments:{total,completed,pending,cancelled, previous_total, change_percent}, clients:{total_in_base,new,returning,active,lost, …}, currency}` with `change_percent` next to every comparable metric |
| `analytics_get_daily_series` | one metric family as a daily series: `metric ∈ revenue \| appointments \| occupancy \| clients` | 4 charts | `{metric, series:[{key, points:[[date, value]]}]}` with canonical keys (`revenue_total`, `appointments_online`, `occupancy_no_show_percent`, `clients_returning`, …); dates as `YYYY-MM-DD` in location time |
| `analytics_get_appointments_breakdown` | appointments by `source` or by `visit_status` | 2 pies | `[{key, label, count, share_percent}]`; `key` mapped to canonical enum where recognizable, else `other` with original label |
| `analytics_get_receptionist_performance` | clients booked, appointments closed, revenue, rebooking rate after visit and after no-show; per receptionist or all; optional daily series | 5 administrator endpoints | one object per receptionist with the five metrics and previous-period values |
| `analytics_get_loyalty_program_results` | new vs existing clients, retention, revenue, per team member for a loyalty program | 3 loyalty endpoints | compact object; requires `loyalty_program_id` (tell the model to use the loyalty tools or `list_loyalty_programs` if absent — check what exists) |
| `analytics_get_forecast` | revenue and visits forecast vs actual | rfm/overall | `{prediction_date, revenue:{forecast, actual}, visits:{forecast, actual}, by_period:[…]}`; explain unavailability when the feature is off |
| `analytics_get_day_end_report` | day-end totals: clients, appointments, visits, services and products sold, memberships, gift cards, takings per account, discounts; optional detail | z_report | totals + `takings_by_account`, `write_offs`; `include_details=false` by default (per-client detail is large and contains personal data); convert dates to `d.m.Y` inside the adapter; surface the "clamped to today" case explicitly |
| `analytics_get_team_member_occupancy` | daily occupancy for one or several team members | staff/workload (one call per member) | `[{team_member_id, points:[[date, occupancy_percent]]}]` |
| `analytics_get_client_visit_stats` | visit statistics for one client | v2 attendances_statistic | `{client_id, visits:{successful, failed}, spent, paid, client_account_balance, last_visit_at}` |
| `analytics_list_report_templates` | the 24 constructor templates with canonical names and what each answers | report_templates | `[{template_id, name, kind: static\|dynamic, dataset, answers}]` |
| `analytics_list_report_fields` | fields of one dataset: curated metrics and dimensions by default, `include_derived=true` for the mechanical aggregates | columns (proxied, renamed) | `[{field_key, title, kind: metric\|dimension\|granularity, data_type, aggregation}]`; `field_key` is a canonical slug (`team_member_name`, `products_revenue`, `membership_sales_count`) mapped from `column_name` by the vocabulary module; the UUID stays internal |
| `analytics_run_report` | run a template or an ad-hoc report: `template_id` **or** `{dataset, fields[], group_by[], granularity?}` + `filters[]` + period | constructor create/update + `/data` | compact table `{columns:[{key,title}], rows:[…], totals:{…}, row_count, truncated}`; hard cap (e.g. 200 rows) and, when truncated, a `resource_link` to the full CSV |
| `analytics_list_saved_reports` / `analytics_run_saved_report` | the user's own constructor reports, run with a period override | reports list / data | same table shape |

**Report ownership rule for `analytics_run_report`.** Gen-2 has no delete and every created report appears in the user's constructor. Keep exactly one MCP-owned report per (location, template or ad-hoc signature), named `[Altegio Assistant] <name>`, created on first use and updated in place; pass the period as a runtime `/data` filter override, never by creating a new report. Document this in the tool description.

**Resources** (register with the low-level handlers already used by the server, or `McpServer.registerResource` if you move to the high-level API):
- `altegio://analytics/glossary` — metric definitions in plain language (average bill formula, lost-client threshold, previous-period rule, phone-based deduplication, occupancy definition, what "receptionist performance" counts).
- `altegio://analytics/report-fields/{dataset}` — the canonical field catalogue (same data as the tool, for hosts with code execution).
- `altegio://analytics/coverage` — what is and is not available through the API (§2C), so the model never promises a report it cannot produce.
- `altegio://reports/{location_id}/{run_id}.csv` — full report output behind `resource_link`, in-memory with a short TTL (single-container deployment today; note the limitation).

**Prompts:** `analytics_monthly_review` (overview + revenue series + breakdown + top templates), `analytics_team_member_review` (occupancy + sales by team member template), `analytics_compare_periods`.

**Facets (minimal implementation of ADR-001 D3).** Adding 14 tools to the current 42 breaks Cursor's 40-tool cap. Implement static facets in the HTTP transport: `/mcp` (default) = existing tools + `analytics_get_overview` + `analytics_run_report`; `/mcp/analytics` = auth + `list_locations` + the whole pack. Facet membership lives in one static map; lists are computed once at startup and ordered deterministically. Stdio exposes everything. A follow-up (not this task) moves onboarding tools to `/mcp/onboarding` to get the default under 40.

## 4. Architecture requirements

1. **Port and adapter (ADR-001 D5).** Add `src/api/analytics-api.ts` (interface with canonical method names and DTOs) and `src/api/v1/analytics-adapter.ts` implementing it over the existing `AltegioClient.apiRequest` plumbing. Two response parsers: enveloped `{success,data,meta}` and the raw-array charts. All legacy field names die inside the adapter.
2. **Capability layer.** `src/capabilities/analytics/` — use cases (`getOverview`, `getDailySeries`, `runReport`…), `vocabulary.ts` (the mapping table of §1 plus `column_name → field_key`), `periods.ts` (presets, timezone resolution, 365-day guard), `projections.ts` (result shaping, rounding to 2 decimals, row caps, CSV rendering), `metrics-registry.ts` (name, definition, formula, source; feeds the glossary resource and tool descriptions).
3. **Tools** through the existing `defineTool` factory in `src/tools/definitions/analytics.tools.ts`, exported from the barrel. Zod 4 schemas with `.describe()` on every field, `outputSchema` for every tool, `title` in annotations. Descriptions start with what the owner gets, name neighbouring tools, and include the words people type (revenue, sales, occupancy, no-show, new clients, retention, receptionist, day-end report, P&L, cash vs card).
4. **Money and numbers in results:** numbers in major units exactly as the v1 API returns them (parse the string sums), always with `currency` (ISO code from the currency object; the bare string of the day-end report mapped the same way). Percentages as numbers. Add one sentence to ADR-001 §5.4 clarifying that the minor-units rule targets V3 write payloads, while analytics results use major units + currency.
5. **Errors.** Map permission failures (403, and the constructor's 404-for-permission) to "no Analytics access right in this location"; map 422 from the 365-day guard and validation to the next action; map feature-flag 403/404 for the forecast to "not enabled for this location". Never return raw backend messages with legacy words.
6. **Context economy (ADR-001 D8).** Daily series as `[date, value]` pairs; row cap + `resource_link`; per-client detail off by default; `structuredContent` always present alongside a short text summary.
7. **Catalog stubs and tests.** Create `catalog/extended/analytics.yaml` — OpenAPI path items for every §2B endpoint used (parameters, response schema as observed, `x-altegio-source: undocumented`, `x-altegio-permission`). Extend `src/tools/api-mapping.ts` and the spec-compliance test so a tool may map to an operation in the documented spec **or** in `catalog/extended/*.yaml`. Add golden tests: recorded, sanitized fixtures from the demo location for every §2A/§2B call, replayed in unit tests; an opt-in live suite (`ALTEGIO_E2E=1`) that re-records them. Test credentials: the docs repository keeps `ALTEGIO_TEST_LOGIN` / `ALTEGIO_TEST_PASSWORD` in `../biz.erp.api.docs/.env` (never copy values into this repo); the demo location used for production-safe read checks is id `4564`.
8. **Protocol and libraries (ADR-001 D7).** `@modelcontextprotocol/sdk` ^1.30 (protocol 2025-11-25); do not adopt the 2.0.0 beta here. Use `resource_link` content blocks (2025-06-18) for large outputs. Keep tool lists static per facet (no session-scoped mutation) and cross-call state as handles in arguments (`run_id`). Zod 4 native JSON Schema generation stays. Optional stretch, only after everything else passes: an MCP Apps view (`@modelcontextprotocol/ext-apps`, supported by Claude and ChatGPT) that charts `analytics_get_daily_series` — design the result shape so it can be attached later; do not block on it.
9. **Tool-search readiness.** Consistent `analytics_` prefix, keyword-rich descriptions, server `instructions` paragraph mentioning the analytics domain and the report builder.
10. **Evals.** Add 4–5 tasks to `../altegio-mcp-platform/evals/tasks/` for `/pro` (revenue last month vs previous, top team members by revenue via template, no-show share, receptionist rebooking rate, day-end totals for yesterday) — run them after the first deploy and attach the summary to the PR.

## 5. Step plan

1. Read: `CLAUDE.md`, ADR-001, `.inventory/analytics-endpoints-inventory.md`, `src/tools/factory.ts`, `src/tools/definitions/staff.tools.ts`, `src/providers/altegio-client.ts`, `src/tools/api-mapping.ts`, `src/tools/__tests__/spec-compliance.test.ts`, `../biz.erp/docs/product-glossary.md`, `../biz.erp/docs/translations/glossary/terminology.md` (grep metric words), `../biz.erp.api.docs/docs/en/paths/analitycs/*`.
2. Write `vocabulary.ts` + the forbidden-words test first; fix the canonical metric names (average bill, visit status enum) and record them in the glossary resource.
3. Adapter for §2A endpoints with fixtures; `analytics_get_overview`, `analytics_get_daily_series`, `analytics_get_appointments_breakdown`, `analytics_get_day_end_report`, `analytics_get_loyalty_program_results`.
4. §2B simple endpoints: receptionist performance, forecast, team member occupancy, client visit stats; extended catalog stubs + golden tests.
5. Report builder: fields catalogue with renaming, templates, `analytics_run_report` with ownership rule, row cap and `resource_link`, saved reports.
6. Resources, prompts, facets, `instructions`; README and CLAUDE.md tool counts; ADR §5.4 clarification.
7. Verification: `npm run lint`, `npm run typecheck`, `npm test`, live suite against the demo location, spec-compliance green; open a PR (branch from `main`; ADR-001 is on PR #21 — rebase or branch from it if not merged).

## 6. Definition of done

- Every tool, parameter, result field, description, resource and prompt passes the forbidden-words test; canonical names match the glossary.
- All §2A and used §2B endpoints have fixtures and a mapping entry; the spec-compliance test covers documented and extended operations.
- `/mcp` stays ≤ current tool count + 2; `/mcp/analytics` serves the full pack; stdio serves everything; `tools/list` order is deterministic.
- Results respect the size budget: no tool response above ~4k tokens without truncation + `resource_link`.
- Permission, feature-flag and range errors produce actionable messages; no legacy vocabulary leaks in any error.
- Lint, typecheck and tests green; live suite recorded once against location 4564; evals tasks added.

## 7. Decisions already taken vs open

**Taken (do not reopen):** one server and one audience; `analytics_` pack as generated-later domain pack; canonical vocabulary from the product glossary; V1 behind a port; SDK 1.x; report ownership rule; facets as static filtered lists.

**Open — ask the user only for these, with a recommendation:**
1. Canonical name for the average check metric (`average_bill` recommended) and the exact `visit_status` enum wording.
2. Whether `analytics_run_report` may create reports in the user's constructor at all (recommended: yes, one owned report per template/signature) or must be limited to templates and existing saved reports.
3. Row cap for report tables (recommended 200) and CSV TTL (recommended 30 minutes).
4. Whether the receptionist's own-metrics path (`created_by_user_id` = current user) should be exposed for non-owners.

## 8. Pointers

- Platform evals harness and rules: `../altegio-mcp-platform/evals/README.md`.
- V1 parameter aliases (`team_member_id`, `location_id`, `appointment_id`, `product_id` accepted by v1): `../biz.erp/src/Application/Http/Routing/ApiParamAliasRegistry.php`.
- Permission slugs and their meaning: `../biz.erp/src/More/Permissions/UserPermissions.php` (`reports_access`, `reports_basic_metrics_access`, `reports_admins_access`, `reports_loyalty_programs_access`, `finances_z_report_access`, `timetable_access`).
- Do not modify `../biz.erp.api.docs` or `../biz.erp`; undocumented endpoints worth publishing go into a list for the spec repository (ADR-001 §8.2).
