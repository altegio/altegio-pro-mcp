# Service analytics source contract (2026-09-24)

The canonical tools `analytics_get_service_mix_trend` and
`analytics_get_client_service_penetration` answer the largest verified parts of
the supplied Revenue, Device Revenue and Service Penetration examples. They are
read-only and served on `/mcp/analytics`, `/mcp/finance`, `/mcp/readonly` and
stdio. The `analytics:read` execution scope and request location boundary apply.

Everything below is the documented V1 contract plus behaviour observed live on
a demo location on 2026-09-24; none of it is a contract beyond the spec.

## Source trace

- Documented V1 `GET /records/{location_id}` requires timetable access,
  filters by local dates, caps a page at 1,000 and returns `meta.total_count`
  under the V2 JSON accept header. The user's team-member restriction is
  applied by the endpoint. The MCP
  scan reads every page, checks the total and unique record IDs, refuses a
  changed or short result, and refuses periods with more than 30,000 source
  appointments. It retains only dates, IDs, status, selected service amounts,
  team-member names and resource-instance IDs; contacts and comments are
  discarded before aggregation. It never emits a partial aggregate.
- Each record carries appointment attendance, client ID, service lines, team
  member, appointment resource instance IDs and local datetime. Each service
  line carries `manual_cost`, `cost` and `first_cost`. Observed on delivered
  lines with `amount > 1`: `manual_cost` is a **line total**, while
  `first_cost` is unit price multiplied by amount. `cost` starts equal to
  `manual_cost` and is reduced by loyalty deductions, so `manual_cost` is a
  pre-loyalty delivered-line price. The tools do not call it cash or
  recognized accounting revenue and never multiply it by quantity again.
- `GET /services/{location_id}` provides _current_ category IDs and
  `GET /service_categories/{location_id}/0` current category titles. Neither
  establishes the category at the historic visit. Services missing from the
  current catalog remain in an unattributed category.
- `GET /resources/{location_id}` maps instance ID to parent resource ID and
  title. The record's resource instances are attached to the appointment, not
  individual service lines. When all assigned instances belong to one known
  parent resource, all delivered service lines on that appointment are grouped
  under it. This includes visits with several services sharing that resource.
  When several parent resources are assigned, their IDs remain on each
  unattributed service row, but the line value is not copied to each device.
  Unknown instance IDs remain visible as unmapped IDs. Resource assignment is
  an operational usage proxy, not an immutable usage audit.
- The bulk records response exposes resource instances only at appointment
  level, although the web client lets a resource be attached to one service
  line. The single-appointment attendance read can include per-line resource
  instances, but its address takes one `record_…` or `visit_…` identifier.
  Enriching a year of records would require one extra request per
  appointment, with no bulk page or snapshot, and no bounded period aggregate
  was found among the web client's analytics reports. The MCP does not infer
  the link from today's service-resource configuration. Multiple instances of
  one resource type can be grouped, but lines on appointments with several
  resource types cannot be allocated to individual devices from this bulk
  response.
- `first_cost` on a line is the recorded unit price multiplied by amount. The
  record API does not establish that it was the published price-list value at
  delivery. Current catalog prices are not substituted for historical values.

The `end_date` filter ends at 23:59:00 (observed: an appointment in the final
minute of the day is missing from the page). The scan requests through the
following day and filters the returned local appointment date back to the
requested inclusive period; this covers appointments in the final minute.
Pages are sorted by appointment date, not by an immutable cursor. The API does
not provide a snapshot token: total and duplicate checks detect common drift,
but an in-flight edit could still shift distinct rows while preserving count.
The response says `no transactional snapshot` and includes the scan time and
source-page count. Also, a service line whose service can no longer be
resolved is omitted from the record; complete **API pages** do not
prove complete historical ledger facts. Reconciliation against a representative
location is required before any accounting claim.

## Report formulas and boundaries

- Monthly value sums each attended, non-deleted service line's `manual_cost`
  once. It excludes products, cash receipts, account top-ups and canceled or
  no-show appointments. Distinct appointment/client counts are per output cell;
  only identified clients enter client counts. Team-member filtering uses the
  appointment's stable staff ID. Returned cells are paged after full source
  aggregation, so the totals cover all cells.
- Penetration denominator is distinct identified clients with at least one
  attended appointment in the selected period. An anonymous appointment is
  excluded and counted separately. Target adoption is one client per selected
  service, current-category or appointment-assigned resource set, no matter
  how many lines or visits. Every known resource on an attended appointment
  with delivered service lines counts for resource adoption, even if several
  are associated with it. Optional source groups provide an overlap and a
  stable, paged list of clients who used source but not target. Names, contacts
  and appointment comments are never returned.
- Hybrid device/category rows use the assigned resource when all appointment
  instances map to one parent type, otherwise the service's **current**
  category if no instance was assigned. Several resource types and unknown
  categories remain unattributed for additive delivered value; resource IDs
  and unmapped instance IDs stay visible on those rows.
  Monthly rows drill down to service SKU without multiplying a line across
  devices. Penetration ranks at most 20 groups, SKUs and group pairs from the
  complete scan, with exact total counts for each ranked set. Mono-group
  clients are confirmed only when all attended service lines have an
  attributable group; clients with unknown lines are counted separately.
  Co-occurrence means observed use by the same client in the period.
  The screenshot's device grouping follows service-resource catalog links, so
  its device totals need not match this stricter appointment-assignment view.
- Cohorts rank that **same active identified population** by summed delivered
  `manual_cost`, descending, with client ID as the tie break. Each of the first
  two groups contains `floor(N/10)` clients, then the rest. The cohort base is
  deliberately different from the PDF's clients with an incoming cash
  transaction. No payer cohort, collected-cash figure, client-account top-up,
  product sale, causal cross-sell lift or scenario forecast is implied.

The V1 scan is a useful interim source at bounded clinic scale. A future
server-side aggregate or snapshot API would remove its page cost and consistency
limit. The V3 preview catalog is not called as if already live, and the disabled
Analytics Constructor remains disabled.
