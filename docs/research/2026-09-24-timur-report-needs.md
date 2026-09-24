# Timur's report examples: API and MCP design

Source: the service-penetration PDF and three screenshots supplied privately on
2026-09-24. This note records report structure and data semantics, not clinic
data or a transcript. The report's recommendations are analysis output, not
implementation instructions or verified causal claims.

## Decisions the reports support

| Example | Dimensions and filters | Measures and next action |
| --- | --- | --- |
| Revenue Report | Month, service category → service, team member, year | Delivered service value, product sales and their separate totals; inspect category trends. |
| Device Revenue Report | Month, assigned device resource → service, other service category, team member, trailing twelve months | Delivered service value and service lines; inspect utilization and sales mix by device. |
| Service Penetration 12mo | Service group (device resource or category), service, client spending cohort, rolling year | Distinct attended clients, share of active clients, service lines/visits, collected cash and delivered value as separate measures; identify overlapping and unserved client groups. |
| Business Advisor | Free text over verified report outputs | A versioned, source-linked narrative with explicit assumptions; the screenshot also lists competitor-pricing and top-customer reports, whose formulas and external sources were not supplied. |

The screenshot labels `manual_cost` on attended appointments, adjusted for
packages, as accrual revenue. Treat it as **delivered service value** until
Altegio defines and validates an accounting recognition rule. The PDF instead
calls service payments, product sales, client-account top-ups and miscellaneous
income **total incoming cash**. A top-up is cash received before a later
service; adding its later redemption to cash again would double count. Neither
measure is interchangeable with the existing MCP service-profitability report's
cash/card revenue or with a statutory P&L.

The PDF uses two different client populations: clients with at least one
attended visit as the service-penetration denominator, and clients with an
incoming transaction as the spending-cohort base. Preserve both counts and
label every percentage's denominator. Count each client only once per group,
even when they have several service lines. Co-occurrence and larger spending
among adopters describe association; they do not establish incremental
revenue from a cross-sell. Scenario uplift must remain an explicit assumption.

## What exists today

- Documented V1 `GET /records/{location_id}` supports date filtering and
  pagination and returns client and service IDs, attendance, `manual_cost`,
  `cost`, `first_cost`, amounts, and resource-instance IDs. It exposes sensitive
  client fields and requires a large, multi-page scan for a year of activity.
- Documented V1 `GET /services/{location_id}` returns category and current
  price; the V2 service relationship exposes linked resources. Current links
  and current prices cannot prove which device was used or what price applied
  on a historical visit. An assigned device and a used device are distinct.
- The existing MCP `analytics_get_service_profitability` groups by service or
  category, and `analytics_get_team_member_service_matrix` groups by team member
  and service. Their revenue semantics differ from the screenshots. Neither
  returns a monthly device series or client penetration. `clients_get_segment_report`
  and `clients_list_profiles` improve client retrieval but do not calculate
  service-group adoption.
- The Analytics Constructor report-data route currently fails in production;
  its legacy fallback ignores the requested period. Its six MCP tools remain
  disabled, so they cannot be used as a generic-report shortcut.
- No verified, bounded source was found for service-line aggregates by
  historical resource *and* stable client IDs across a full year. Building the
  clinic's report through hundreds of appointment pages and client joins inside
  one MCP call would be slow and could silently omit data at the existing page
  cap. A partial report must never be presented as complete.

## Proposed API contract (not a live operation)

Provide a location-scoped, permission-checked analytics read model over the
underlying appointment/visit, service, resource and payment facts. The API team
should publish the final V3 paths and names with the backend; this proposal
does not add preview-only operations to the executable OpenAPI catalog.

1. **Delivered service lines.** Query by inclusive local dates, team member,
   service, category and resource; return stable appointment, visit, client,
   service and historical category IDs, service-line identity and quantity,
   attendance, local delivery date, resource instance and parent resource IDs,
   the price-list value at delivery, `manual_cost`, the collected/write-off
   amount and package allocation with separate nullable fields. Define each
   amount in integer currency minor units. Never derive historical price from
   today's service catalog. Make unknown allocations explicit.
2. **Aggregated service mix.** Server-side month × category/service/resource
   groups with service-line count, distinct visit and client counts, delivered
   service value, price-list value and separate cash-receipt components. Return
   category totals and product sales separately so overlapping subtotals cannot
   be added twice. Support cursor pagination or a bounded response with exact
   totals, a snapshot/as-of marker and an explicit completeness state.
3. **Client penetration and cohorts.** Server-side group × cohort aggregates:
   active attended-client denominator; paying-client cohort denominator;
   distinct adopters; repeat visits; overlaps between selected groups; and
   exact non-adopter counts. Define cohort ranking, ties and zero/negative
   spend. A separate cursor-paginated target-list operation may return stable
   client IDs for an authorized campaign; contacts require their own right and
   explicit opt-in. Aggregates must not leak individual contacts.
4. **Cash receipts.** If the service-mix API references finance, expose
   transaction type and signed amount with refunds/reversals, stable payment
   ID, client ID where authorized, booking/visit linkage where real, and a
   deduplication rule. Client-account top-ups remain a separate cash stream;
   their later use is not a second cash receipt. Reconcile each period with
   the existing finance source.

For resource grouping, specify whether the dimension is **required resource**
(catalog configuration) or **actually assigned resource instance** on the
appointment. If multiple devices are linked or used for one service, either
return separate non-additive associations or publish a verified allocation
rule; do not multiply a line's value by the number of devices. Preserve an
`unattributed` group. Attendance, cancellation, deletion and return/refund
rules must be identical across totals and drill-down. Period boundaries use
the location timezone. Permission checks must apply before aggregation and
again on any client-level drill-down.

## MCP once the API is available

| Tool | Result | Why it removes custom logic |
| --- | --- | --- |
| `analytics_get_service_mix_trend` | Monthly category, service or actual-device series with a named amount basis and exact totals. | Replaces the two spreadsheet-style revenue views and their repeated joins. |
| `analytics_get_client_service_penetration` | Active and payer cohort denominators, group adoption, overlap and ranked gaps. | Replaces the PDF's penetration/cohort calculations. |
| `analytics_get_service_cross_sell_candidates` | Bounded, stable client IDs matching a cohort and a used/not-used service group; optional contact projection. | Makes the resulting segment actionable without name matching. |

All three should be read-only, location-scoped, period-bounded, use the
existing `analytics:read` gate and be available on the analytics and readonly
views. The candidate-list tool needs an additional contact-field gate once
V3 exposes it. Tool output should name the measure, denominator, currency,
timezone, source period, as-of marker and completeness; use a resource link
for large tables. The Business Advisor can then narrate these structured
results and show calculation provenance. It should keep factual results and
conversion/uplift scenarios in separate sections, with user-supplied
assumptions. No SQL generation or saved Analytics Constructor report is
required for these fixed questions.

## Delivery sequence and acceptance checks

1. API team settles metric and resource-allocation definitions against a
   representative clinic ledger, including prepaid courses, free services,
   refunds, multi-service appointments and multiple devices. Verify period
   totals and client counts against known source records.
2. Implement and publish the backend aggregate and client-target APIs with
   exact pagination/completeness and authorization. Add them to the V3 OpenAPI
   contract only when the backend route is real and available.
3. Implement the three canonical MCP tools over those operations. Pin formulas,
   resource grouping, cohort boundaries, paging and field-level privacy with
   fixtures and an authorized live smoke. Compare the two monthly screenshot
   views against the new measures on the same dates, documenting any expected
   difference due to accounting basis.

This sequencing avoids a public MCP tool whose answer looks complete but is
built from a partial appointment scan or a different revenue definition.
