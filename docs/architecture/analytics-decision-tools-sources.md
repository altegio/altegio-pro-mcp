# Source audit: task-oriented analytics tools

Audited against `biz.erp.api.docs` master and the read-only `biz.erp` checkout
on 2026-09-19. These tools do not call the disabled Analytics Constructor.

## `analytics_get_profit_and_loss_statement`

| Source                                                   | Format                 | Filters                                       | Permission / flag                                                                             | Used for                                                                                                                |
| -------------------------------------------------------- | ---------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `GET /finances_reports/annual_report/{location_id}/`     | Authenticated ERP HTML | `date_from`, `date_to`                        | `finances_year_report_access`; redirects when the report-builder feature hides system reports | Posted income/expense categories and the source result. Category IDs come from transaction links; labels are untrusted. |
| `GET /reports/z_report/{location_id}`                    | Documented JSON        | dotted start/end dates on the wire            | day-end/finance reporting right; can be clamped to today                                      | Service, product, membership and gift-card sales memo split.                                                            |
| `GET /analytics_services/services_search/{location_id}/` | JSON envelope + HTML   | period, team member, category, grouping, page | Sales-by-services report right                                                                | Service cash/card revenue, client-account use, consumables, attributed compensation and source contribution.            |

The finance report defines posted income, expenses and its signed result. The
MCP does not add the sales memo split to posted income, which would double
count. `net_profit` and location-wide `gross_result` stay null: retail product
cost, taxes, rent completeness, external payroll and unposted expenses cannot
be proven complete. Service consumables and attributed compensation are shown
as direct service costs; indirect costs stay null because finance categories do
not carry a reliable direct/indirect classification. Category output is capped
at 500 entries with explicit coverage metadata.

The day-end source does not echo an authoritative effective period. Its memo is
used only when returned dated detail proves the requested period (or the request
is exactly today). Detail outside the request marks the response `clamped` and
records its effective range; historical output without dated evidence is
`unverified`, so all memo amounts are withheld instead of being mislabeled.

## `analytics_get_capacity_heatmap`

| Source                                      | Format                 | Filters                                    | Permission / flag       | Used for                                                             |
| ------------------------------------------- | ---------------------- | ------------------------------------------ | ----------------------- | -------------------------------------------------------------------- |
| `GET /company/{location_id}/staff/schedule` | Documented JSON        | period, repeated team-member IDs, includes | timetable access        | Working intervals; stable team-member IDs.                           |
| `GET /records/{location_id}`                | Documented JSON, paged | period, page/count, deleted rows           | appointment read access | Appointment intervals, outcomes, service prices and team-member IDs. |

The MCP unions overlapping intervals per team member before aggregation.
Scheduled hours are the denominator; booked hours include source busy intervals
(appointments and group events) plus every non-cancelled appointment, while
completed utilization includes arrived appointments only.
Appointments outside a schedule are reported as uncovered and never turn
unscheduled time into “idle”. `date_hour` is limited to 31 days, the roster to
25 people and appointments to 10 pages of 300.
Intervals whose end is earlier than their start cross midnight and are split
between the two local dates before aggregation; the same rule applies to source
busy intervals.

## `analytics_get_revenue_leakage`

| Source                                      | Format                 | Filters                                                                                | Permission / flag       | Used for                                                                                     |
| ------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `GET /records/{location_id}`                | Documented JSON, paged | period, deleted rows, finance include; status is filtered locally from canonical state | appointment read access | No-show/cancelled/arrived state, paid-in-full flag, booked and pre-reduction service prices. |
| `GET /services/{location_id}`               | Documented JSON        | location                                                                               | service read access     | Stable service-to-category mapping only when category filtering is requested.                |
| `GET /company/{location_id}/staff/schedule` | Documented JSON        | period and team-member IDs                                                             | timetable access        | Optional unbooked scheduled capacity.                                                        |

No-show, cancellation and completed-but-not-marked-paid amounts are estimates
from retained booked prices, never recognized revenue. When service and
category filters are present, amounts include only service lines satisfying all
filters. Service discounts are an observed reduction. A reliable outstanding
balance and loyalty-specific write-off split are absent from the appointment
source, so they remain null or are explicitly unavailable. Observed and
estimated concepts are never summed.
The schedule source cannot filter capacity by service. Therefore a request with
service or service-category filters returns the capacity-opportunity category as
explicitly unavailable instead of applying whole-roster capacity to a narrower
service population.

## `analytics_get_team_member_service_matrix`

| Source                                                   | Format               | Filters                                     | Permission / flag              | Used for                                                                                                                            |
| -------------------------------------------------------- | -------------------- | ------------------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `GET /analytics_services/services_search/{location_id}/` | JSON envelope + HTML | period, one team member, one category, page | Sales-by-services report right | Genuine team-member × service rows with stable service ID, service-line count, revenue, consumables, compensation and contribution. |
| `GET /staff/{location_id}`                               | Documented JSON      | location                                    | team-member read access        | Stable team-member ID/name/position roster.                                                                                         |

The source is called for at most ten selected team members with concurrency
three and at most five 100-row pages each. It genuinely groups by service under
the team-member filter; independent totals are never cross-joined. Distinct
appointments, clients, durations, exact-pair occupancy and return behavior are
not in the source and stay null. Service-category ID is only known when that
stable ID was supplied as a source filter.

## `analytics_get_inventory_reorder_risks`

| Source                                         | Format                         | Filters                                                              | Permission / flag                 | Used for                                                                                                                                |
| ---------------------------------------------- | ------------------------------ | -------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /storages/turnover/search/{location_id}/` | JSON envelope + localized HTML | period, one inventory, one product category, one supplier, page/size | `storages_turnover_report_access` | Stable product ID, title, supplier label, unit, opening/current stock, received/sold units, average stock and source turnover measures. |

Average daily sales, days of cover, risk and suggested reorder quantity are
deterministic MCP derivations documented in the tool output. The source uses
compatible sale units for stock and sales and supports fractional and negative
quantities. Without an inventory filter it returns its all-visible-inventories
aggregate. Product code, reserved/available split, last sale date and authorized
cost/stock value are absent and stay null. The tool never mutates inventory or
creates an order.

## Output contract and provenance

All five tools publish closed JSON Schema 2020-12 output contracts down to every
nested row, formula, coverage and provenance object. Fixture-produced results
must validate; undeclared nested fields and missing required nested fields are
rejected in tests. Structured provenance uses stable canonical source ids such
as `posted_finance_ledger`, `team_member_schedule`, `appointments`,
`service_contribution_report` and `inventory_turnover_report`; raw internal
routes remain an adapter/documentation concern.
