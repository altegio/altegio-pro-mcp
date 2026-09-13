---
name: altegio-demo-locations
description: Curate, populate, clean, and verify realistic Altegio Pro demo locations through the hosted MCP. Use for demo-location setup, refresh, cleanup, or audit; do not use for ordinary production data maintenance.
---

# Altegio demo locations

Build a coherent, usable demo business rather than a collection of sample rows. A finished location must have a localized identity, active bookable specialists, a credible service catalog, service-to-team-member links, working schedules, clients, past and future appointments, booking settings, and analytics that survive a read-back through the hosted MCP.

## Context and authorization

- Read the repository `AGENTS.md` or `CLAUDE.md`, `/Users/ypetrou/.config/agent-workstation/WORKSTATION.md`, the current OpenAPI spec, product-logic docs, and ADR-001 before changing live data.
- Pull `../biz.erp.api.docs` as required by the repository workflow, but never edit it from this project.
- Prefer the hosted MCP at `https://mcp.alteg.io/public/pro/mcp`; use `https://mcp.alteg.io/public/pro/mcp/analytics` for the full analytics facet.
- Treat each `X-Altegio-Company-Id` scope as a separate session. Do not reuse a session scoped to one location for another location.
- Prove authentication with a real noninteractive read before mutation. Never print tokens or leave them in temporary scripts.
- Snapshot the target location before cleanup. Record IDs, names, active state, ownership, staff links, schedules, forms, clients, appointments, users, and resources.

For a documented direct V1 fallback, match the server's actual upstream authentication format:

```text
Authorization: Bearer <partner-token>, User <user-token>
Accept: application/vnd.api.v2+json
```

Use a direct fallback only when the operation is documented and the MCP write is missing or demonstrably broken. Keep the fallback narrow and verify the result again through MCP.

## Current standard demo locations

These are the maintained demo identities as of 2026-09-13. Verify them before assuming the state is unchanged.

|     ID | Identity                          | Intended model                                                  | Curated providers | Curated services |
| -----: | --------------------------------- | --------------------------------------------------------------- | ----------------: | ---------------: |
|   4564 | Ateliér Vltava \| Praha [TEST]    | Czech beauty studio: hair, color, nails, and skincare           |                 6 |               13 |
| 720441 | Brzytwa \| Kraków [TEST]          | Polish barbershop: haircuts, beard care, packages, and coloring |                 4 |               10 |
| 703092 | VONA beauty space \| Львів [TEST] | Compact Ukrainian beauty studio: hair/color plus nails/skincare |                 2 |               12 |

Location `703092` has a three-seat timetable subscription limit. One seat belongs to the hidden user-linked `Test MCP` profile and must be preserved. The curated business therefore uses two bookable providers plus a non-bookable administrator. Do not turn the hidden user-linked profile into a demo provider or remove its access merely to reach a preferred roster size.

Preserve entities explicitly marked as required for CI or "do not delete". In location `4564`, this currently includes team member `820311` (Pavel Vishnevsky), whose specialization says it must not be deleted.

## Design the business first

Before creating rows, decide and keep consistent:

- local-language business name, description, address, postal code, coordinates, country/city IDs, timezone, and currency;
- normally 4–7 specialists plus an optional receptionist, with local full names, distinct roles, localized short bios, deliberate display order, `hidden=0`, and `fired=0`; use a smaller coherent team when the subscription limit is lower;
- 4–6 service categories and roughly 8–15 services with plausible local prices, durations, descriptions, and category membership;
- a service matrix where each bookable specialist offers a credible subset, not every service;
- staggered weekly schedules with lunch breaks, days off, and coverage into the future;
- local client names and contact formats;
- past and future appointments across several specialists and services, including arrived, confirmed, waiting, and no-show outcomes;
- a localized default booking form and sensible online-booking settings.

Receptionists do not need a bookable schedule. Every service provider does.

## Density profile for analytics-ready demos

Sparse examples are not enough. Unless the user asks for a smaller fixture, maintain these read-back targets per location:

- at least 60 localized clients, with realistic repeat visits rather than one synthetic client per row;
- a deliberately dense operational window of roughly 45 days before and 45 days after the anchor; a longer six-month fixture is unnecessary unless the user asks for it;
- every open day in that window must contain appointments from several working providers, not merely satisfy a location-wide total;
- for a two-provider location, schedule both providers and keep at least 4 appointments per open day; for four providers, schedule at least 3 and keep at least 5; for six providers, schedule at least 4 and keep at least 6;
- every scheduled provider should normally have at least one appointment on that day, with popular providers receiving 3–4 and lower-demand providers 1–2;
- intentionally unequal provider demand: a clear lead provider, a middle group, and a lower-demand provider where team size permits; for a two-provider studio, approximately 60/40 is sufficient;
- 65–80% of appointments on locally plausible peak days/times (Thursday–Saturday, late afternoon/evening, plus Saturday late morning), with the remainder off-peak;
- both value and premium services represented by at least 25% of the generated plan, with core-priced services making up the rest;
- past outcomes containing arrived and no-show plus unresolved/confirmed examples, and future appointments split between confirmed and waiting.
- at least 70% of historical appointments must be completed **and paid**, with a real service-payment transaction and `paid_in_full=true`; `attendance=1` alone is not a sale.
- every provider's schedule should cover the dense appointment window plus a small buffer, with daily read-back checks so a day with only one scheduled provider cannot pass.

Do not infer the distribution from row creation success. Re-read appointments and analytics, group by provider, period, outcome, peak/off-peak, and service price band, and report the observed counts. Count a payment only after `paid_in_full` or the corresponding transaction is visible; some legacy payment modes return HTTP 200 without creating a transaction.

## Reproducible refresh

From this repository, load `.env` into the child process without printing it and run the bundled script:

```bash
set -a; source .env; set +a
node .agents/skills/altegio-demo-locations/scripts/refresh-demo-locations.mjs
node .agents/skills/altegio-demo-locations/scripts/refresh-demo-locations.mjs --apply
node .agents/skills/altegio-demo-locations/scripts/refresh-demo-locations.mjs --apply --location=703092
```

The first command is an audit-only pass. `--apply` updates identities, curated staff/services/links, schedules from 60 days before the anchor through 60 days after it, booking settings/forms, clients, a dense ±45-day appointment plan, and payments for arrived demo visits. The plan is built day by day, packs non-overlapping services inside each work shift, and enforces location-specific minimum staff and appointment counts for every open day. Exact names and staff+datetime intervals make reruns idempotent within the same anchor date. Set `DEMO_ANCHOR_DATE=YYYY-MM-DD` for a reproducible historical run. The helper opens a separate scoped hosted-MCP session per location, opens a fresh session for the final audit, paginates reads beyond 300 appointments, paces writes, retries bounded `429` responses, and never prints tokens.

## Safe cleanup classification

Classify every pre-existing entity before deleting it:

1. **New demo entity** — keep.
2. **Explicit CI/protected entity** — keep even if its name looks artificial.
3. **Location-owned junk** — delete when the ID and scope are exact.
4. **Chain-owned entity** — do not escalate deletion to the chain. A location-level `403` is an ownership boundary, not permission to alter every chain location.
5. **Owner, administrator, or system access** — keep unless liveness is known or the user names the access to revoke. Do not infer that a human or integration is obsolete from its display name alone.

Use exact IDs for destructive calls. Re-read after bulk cleanup because CI may create and remove short-lived `API Test ...` entities concurrently.

Deleting an appointment can leave a cancelled event in analytics even when it disappears from `get_appointments`. Inspect analytics before cleanup; if a pristine comparison period matters, prefer a clean location or a date window without old test activity.

## Mutation order

Use this order because later writes can invalidate earlier work:

1. After the snapshot and classification, delete confirmed location-owned junk. Clean old appointments before creating the demo set so IDs and date-window checks remain unambiguous.
2. Update location identity and booking settings.
3. Create or retain positions, categories, and team members. A provider needs both `has_access_timetable=true` and `is_paid_staff=true`; non-billable team members cannot be scheduled. Respect the location's subscription cap instead of buying or displacing seats implicitly.
4. Create services.
5. Apply the final service update, including `active=1`, price, duration, comment, and category.
6. Link services to team members **after the last service update**. A legacy full service `PUT` can replace the service's staff array and silently remove earlier links.
7. Create schedules for every service provider across the ±45-day appointment window plus a buffer. Write in bounded chunks and verify every open day; two-provider locations should avoid staggered days off that leave only one provider working.
8. Import or create clients.
9. Create past and future appointments, set varied outcomes, and create the localized default booking form.
10. Close each arrived historical demo visit through documented `PUT /visits/{visit_id}/{record_id}` with the complete services array and a working `fast_payment` mode. Omitting services can silently remove the visit line items. Fast cash payment can return HTTP 200 without a transaction when the legacy location has no default cash account; the bundled helper uses the consistently configured cashless mode and verifies `paid_in_full`.
11. Remove any short-lived test artifacts that appeared concurrently, then perform the complete read-back audit.

If a team member cannot accept a schedule and is not needed by an appointment, remove that demo team member rather than leaving a visible but unusable provider.

## Verification: success responses are not enough

Verify through the same public MCP surface another agent will use:

- `altegio_call_operation(get_location)` for identity, country/city IDs, timezone, currency, address, and booking form;
- `get_staff` for the visible roster;
- `altegio_call_operation(get_team_member)` for every provider, asserting `is_bookable=true`, `has_schedule=true`, and the expected `services_links` count;
- `get_services` plus `altegio_call_operation(get_service)` for active state, price, duration, category, staff, and online visibility;
- `get_schedule` over the complete dense window for each provider, grouped by day;
- `clients_search` for total count and localized names;
- `get_appointments` for the selected past/future window;
- `altegio_call_operation(get_transactions)` or `get_transactions_by_visit_or_appointment_id` plus appointment `paid_in_full` for completed service sales;
- `analytics_get_appointments_breakdown(group_by=visit_status)` for outcome counts;
- `analytics_get_overview` for timezone, currency, revenue, and client-base consistency;
- `get_booking_forms`, `get_appointment_settings`, and `get_online_booking_settings`;
- `get_resources` and `altegio_call_operation(get_location_users)` for residuals that cannot be safely cleaned automatically.

Also verify scope isolation: a session pinned to one company must refuse a call targeting another company.

An acceptable demo invariant is:

- every curated service is active;
- every provider is bookable, linked to at least one service, and scheduled;
- receptionist-only staff are not presented as providers;
- there are both past and future appointments;
- every open day meets the location's minimum scheduled-provider, appointment-provider, and appointment-count thresholds;
- outcomes include arrived, confirmed, waiting, and no-show;
- at least 70% of historical appointments are paid service sales and analytics reports non-zero service revenue;
- booking form, timezone, and currency match the location;
- no unexpected location-owned `API Test ...` staff or services remain.

## Known defects and ownership

Use this routing when deciding where a fix belongs.

### Fix in this MCP project

- `update_service` currently calls `PATCH /services/{location_id}/{service_id}`; the documented V1 route accepts `PUT`. Change the client method to `PUT` and add a contract test.
- `create_service` produces an inactive service. Expose a reliable `active` input or activate it as part of the workflow, then verify by reading the service back.
- Position tools call `/positions/{location_id}` and return `404`; reconcile them with the documented position surface or remove unsupported CRUD claims.
- Add curated write tools for documented demo-management operations: delete service category, delete client, delete booking form, and optionally revoke a specifically identified location user.
- Pagination descriptions say pages start at `0`, while schemas reject `0`. Make the contract and implementation agree.
- `get_services` and `get_appointments` text projections can print `undefined` for price/status. Correct the projections.
- Investigate `list_locations(my=1)` returning zero under a valid company-scoped request while direct scoped operations succeed.
- Expand `update_location` only for fields the upstream API actually supports; do not claim successful contact updates without a read-back.
- `create_staff` cannot express the backend-supported `user_email=null` / `user_phone=null` form for an unlinked team member, and `update_staff` omits `has_access_timetable` and `is_paid_staff`. The refresh helper uses narrow documented V1 fallbacks for these fields, then verifies through MCP.
- Onboarding batch tools require a file-backed onboarding session even when the underlying operation is independently valid; on a multi-replica deployment that state may not survive a new MCP session. Start and consume onboarding state in the same scoped session.
- `update_appointment` is a full update upstream even though the tool describes partial fields. It returns `422` unless the current team member, services, client, datetime, and session length are resent.
- `get_appointments` can project raw `attendance=0` as `confirmed` because the legacy response also carries `confirmed=1`. Use the analytics visit-status breakdown or raw documented read for the authoritative outcome mix.

### Fix in API documentation or backend contract

- The modern schedule endpoint is documented with per-entry `team_member_id`, while the backend validator requires `staff_id`. The MCP adapter already translates this; the OpenAPI contract should be corrected.
- `PUT /company/{location_id}` documents `phones`, but accepted phone arrays did not persist in these demo locations. Confirm backend behavior, then fix the implementation or narrow the schema.

### Not an MCP defect

- Location-level deletion of chain-owned services/categories can return `403`; this is an ownership rule.
- Resources currently have only a read endpoint. Deleting or editing them requires a new public API capability.
- Some location fields returned by `get_location` (`public_title`, chain metadata, and other legacy presentation settings) are not writable in the documented contract.
- SMS confirmation and some booking settings can be unavailable for a particular country, tariff, or location configuration.

## Handoff report

Report:

- the business concept and location IDs;
- curated counts for staff, active services, categories, clients, appointments, and forms;
- provider link/schedule verification;
- appointment outcome distribution and analytics currency;
- deletions performed;
- exact protected or unsupported residuals, separated into chain ownership, missing API capability, MCP defect, and uncertain access ownership;
- whether repository files changed and which checks were run.

Never report a location as fully clean when protected chain data, read-only resources, stale analytics cancellations, or unsupported presentation fields remain visible.
