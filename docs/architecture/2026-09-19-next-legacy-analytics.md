# Temporary capacity, reactivation, events, products and cash-flow reports

This extends PR #55's existing request-scoped transport, typed adapter, bounded
readers, locale parser and capability boundary. Replace these adapter methods
with equivalent V3 operations when available; keep the canonical tool contracts.
No browser session, additional transport, writes or saved reports are involved.
All five tools join analytics, finance, readonly and stdio; the default view stays
unchanged. Scope policy remains `analytics:read`.

## Source verification

Read-only backend inspection: `fa3ee0923845e7ae000aba305cce4d802cd11111`.
Published v1 and V3 preview spec inspected after pull:
`987d6cada0a5b827775af0aeab69ceb291e180ec`. Neither spec exposes equivalent
complete report contracts. The web controllers return HTML search envelopes,
except the reactivation BIFF8 export. The capacity JSON chart returns daily
percentages for a single member, not this report's hour and day totals.
Undocumented routes and exact wire parameters are recorded in
`catalog/extended/analytics.yaml`; canonical parameters stop at the v1 adapter.

| Report | Source | Permissions and source semantics |
| --- | --- | --- |
| Capacity | `PageAnalyticsWorkloadController`, `analytics/workload_search` | Location editing plus workload-report access. Dates use `start_date`/`end_date`. Source seconds become rounded hours; idle hours may be negative. Adjacent graph rows contain stable member ids even when there is no chart button. Strip the decorative pie ratio before reading occupancy. Totals cover the returned report, not a separate calculation. |
| Reactivation | `AnalyticsLoyaltyProgramsController`, `AnalyticsLoyaltyProgramsExcelRenderer` | Loyalty analytics AND client-contact access are required by the export controller even if MCP withholds contacts. Required program id and ISO `date_from`/`date_to`. Eight workbook columns, no client id. Paid amount is lifetime original paid money plus additional payments, not period revenue. Contacts remain opt-in and masked values remain masked. Last visits have dates plus ambiguous comma-separated descriptions; do not split those into guessed identities. |
| Group events | `Dashboard/ActivitiesController`, `activities/search` | Dashboard appointment access. Source filters map team member, service, service category, label and all/active/deleted status. `CBoolParam`: all 0, deleted 1, active 2. Event links carry stable ids; member identity requires a unique name/position join. No service id is present. Date and creation time are localized display text. Amount is the sum of full appointment costs, not paid revenue. Dashboard cards are period-wide and absent on empty pages, so missing metrics are null. |
| Products | `SalonStoragesSalesAnalysisController`, `SalonStoragesSalesAnalysis`, `storages_reports/sales_analysis` | Sales-report access; cost-view permission removes three product columns. Export access is unnecessary. Supplier omitted maps to -1; 0 means no supplier. Cost is current actual unit cost multiplied by quantity, not historical cost or unit cost. Revenue includes real money and client-account payments. Product totals precede source pagination. Categories force page 1/999999 upstream, include hierarchy and paginate locally. Their HTML has no cost gate, so MCP always withholds category cost/markup values. |
| Cash flow | `PageFinancesReportsController`, `CTableReportPeriod`, `finances_reports/account_period/search` | Period-report access; no CSV permission. Requested accounts are filtered by the backend. Type is an extensible payment-item id, not an income/expense enum. Cash-account types are cash 0, cashless 1, all 2. HTML contains both account-type and authorized-account columns with localized day labels. Account ids and payment-item ids are absent unless the latter is supplied as a filter. Outflows keep their sign; balance is net movement, not account balance. A selected payment item removes aggregate rows. |

The cash-flow source's `movements_funds=2` filter tests only the cash subtotal,
which can hide nonzero cashless movements. The adapter requests all permitted
rows (`movements_funds=1`) and implements `include_zero_movement_rows=false`
locally over the returned amounts, preserving cashless-only movement. The
source's third account-type column is an unpopulated slot; the adapter exposes
cash and cashless values plus the authoritative overall row total. The extra
balance subtotal row is presentation only and is not another payment item.
Account and account-type dimensions overlap and must never be added together.

## Validation and limits

Synthetic source-shaped EN, RU and pt-BR fixtures pin layouts, numbers, cost
withholding, pagination, dynamic two-row headers and balance continuation rows.
Adapter tests pin all routes and filters; shared transport tests retain tenant,
authentication, redirects, size bounds and secret-safe failures. Capability
canaries cover every free-text field, including creator names and account labels.
Inputs cap pages, page sizes, id lists and canonical periods. Responses refuse
oversized answers with a narrowing instruction rather than quietly losing rows.

The live suite is opt-in. A real local-token report request returned an
authentication rejection during this implementation; the deployed backend has
only a partner token and no saved user token. No live report success is claimed.

## Discovery evaluation

Offline schema, terminology and question-routing review (2026-09-19):

| Owner question | Expected tool | Contract distinction checked |
| --- | --- | --- |
| Who has idle hours this month? | `analytics_get_team_member_capacity` | Hours and totals versus the daily occupancy tool |
| Which loyalty clients should we win back? | `analytics_get_client_reactivation_candidates` | Program required; lifetime paid; no guessed client ids |
| Do our classes fill and do attendees pay? | `analytics_get_group_event_performance` | Separate booked/attended/paid metrics and appointment value |
| Which products sell profitably? | `analytics_get_product_sales` | Quantity cost, permission withholding and category hierarchy |
| Where did cash move across accounts? | `analytics_get_cash_flow_breakdown` | Signed movement, overlapping dimensions, no closing balances |

All five routes are in the playbook; glossary/coverage and relevant review
prompts use the new capabilities. Terminology and JSON Schema 2020-12 checks run
with the full suite. This is a deterministic contract/discovery evaluation, not
a claim of a live model or production-data evaluation.
