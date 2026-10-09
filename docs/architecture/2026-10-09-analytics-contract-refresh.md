# Analytics contract refresh — 2026-10-09

The comparison used the published API documentation at `7bcfc643` (master),
including the new operations in #137 and filters in #136. The documentation
checkout was on another session's branch; a read-only `git archive` snapshot
under `.inventory/api-docs` supplied the catalog build and contract checks.

| Documented source | MCP capability | Decision |
| --- | --- | --- |
| `GET /locations/{location_id}/team_members/workload` | `analytics_get_team_workload`, `analytics_get_team_member_occupancy` | Selected-team aggregate and existing per-person percentages |
| `GET /locations/{location_id}/team_members/working_days` | `analytics_get_team_workload` | Working dates for exactly the same selection |
| `GET /reports/day_report/{location_id}/{date}` | `analytics_get_daily_summary` | Verified one-day booked/completed/cash summary |
| Appointment list filters | `appointments_list` | Team member, client, creator, event, creation dates, change timestamps, deleted rows |
| Transaction `changed_after`, payment methods, appointment changes, client loyalty, chain services | Updated operation catalog | Documented reads available through the existing scoped executor; no extra curated wrappers |

The remaining new operations duplicate appointments, manage duplication strategies,
or send payment links. They do not provide analytical facts and are not added to
the read-centric analytics surface. Existing client-search filters already cover
the newly documented request contract. V2 has no new analytics endpoint; V3
remains preview and cannot be called through the executor.

## Source evidence and semantics

Read-only calls on 2026-10-09, using the application's existing authorized test
location, returned all three new sources with HTTP 200. Committed fixtures contain
only numeric metrics and dates, with no client or team-member names or contacts.
The workload source returned `0.69`, `0.77`, `0.72` for the first three days of
October. It also returned October 10 for a request ending October 9; the adapter
excludes that extra row and reports the count.

The previous occupancy adapter treated fractions as percentages: `0.69` became
`0.69%`. Individual occupancy now multiplies by 100 once (`69%`); aggregate
workload deliberately exposes `booked_share` in 0…1. Missing measurements remain
unknown. Out-of-range shares and duplicate/invalid dates fail instead of silently
changing units. Working dates are union dates of the visible selected team,
not a per-person work schedule. Neither source proves idle hours or bookable slots.
The aggregate tool accepts at most 50 distinct IDs and 93 days, with identical
selection parameters on both source requests.

The daily summary returned the requested local day in `date_iso`. A mismatch
fails without returning mislabeled metrics. `completed_sales_value` already
includes products; `booked_services_value` and `cash_received` belong to different
populations/ledgers. A difference does not prove unpaid appointments. Its client
count is distinct clients with appointments, not clients who attended. The source
does not supply currency or define the unit of `average_workload`; currency is
null and that workload value is explicitly unclassified. Use a same-location
overview to establish currency, and the day-end tool for payment-account detail.

## Verification

Regression checks execute the complete curated handlers against the recorded
sources, validate their output schemas, selectors, date coverage, nulls and tenant
scope, and forward the appointment filters. Existing individual-occupancy tests
pin conversion to percent. Daily-review and quiet-day prompts state these rules.
The analytics agent adds checked Monty reference recipes and golden scenarios;
only successful execution can save a recipe as an owner-encrypted workflow.

Regenerate and verify the catalog with the explicit documentation snapshot:

```sh
ALTEGIO_API_DOCS=.inventory/api-docs npm run catalog:build
ALTEGIO_API_DOCS=.inventory/api-docs npm run catalog:check
ALTEGIO_API_DOCS=.inventory/api-docs npm test -- --runInBand
```
