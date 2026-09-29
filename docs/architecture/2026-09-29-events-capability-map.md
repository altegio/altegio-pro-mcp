# Group events capability map (2026-09-29)

Sources:

- The Altegio API OpenAPI repository (`ALTEGIO_API_DOCS`, master as of
  2026-09-29, B2B V1 and V2).
- The ERP backend on master: the V2 event controllers, their request DTOs and
  the transformers behind them.
- Read-only calls to live locations.

V2 is canonical. V1 fills one gap. The `events_*` tools go through
`src/api/v2/events-adapter.ts`, the only place that knows the wire names:
`activity`, `staff_id`/`master_id`, `record`, `length`, `resource_instance_ids`
and `label_ids`.

## Tools → operations

| Tool                                 | Operation (catalog id)                                                                    | Call                                                                                          |
| ------------------------------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `events_list`                        | `list_events`                                                                             | `GET /v2/locations/{id}/events`                                                               |
| `events_get`                         | `get_event` + `list_appointments` (`filter[activity_id]`)                                 | `GET /v2/…/events/{event_id}`, `GET /v2/…/appointments`                                       |
| `events_list_dates`                  | `list_event_dates` + `list_event_filters`                                                 | `GET /v2/…/events/dates`, `GET /v2/…/events/filters`                                          |
| `events_list_services`               | `search_event_services` (**V1**; V2 has no equivalent)                                    | `GET /v1/locations/{id}/events/services`                                                      |
| `events_list_duplication_strategies` | `list_event_duplication_strategies`                                                       | `GET /v2/…/events/duplication_strategies`                                                     |
| `events_create`                      | `create_event`                                                                            | `POST /v2/…/events`                                                                           |
| `events_update`                      | `get_event` + `update_event`                                                              | read, then `PUT /v2/…/events/{event_id}`                                                      |
| `events_delete`                      | `delete_event`                                                                            | `DELETE /v2/…/events/{event_id}`                                                              |
| `events_duplicate`                   | `duplicate_event`                                                                         | `POST /v2/…/events/{event_id}/duplicate`                                                      |
| `events_*_duplication_strategy`      | `create_`/`update_`/`delete_event_duplication_strategy`                                   | `POST`/`PUT`/`DELETE /v2/…/events/duplication_strategies[/{id}]`; update reads the list first |
| `events_book_clients`                | `bulk_create_event_appointments` (`create_event_appointment` is covered by the same tool) | `POST /v2/…/events/{event_id}/appointments/bulk`                                              |
| `events_update_appointment`          | `list_appointments` + `update_event_appointment`                                          | read, then `PUT /v2/…/events/{event_id}/appointments/{id}`                                    |
| `events_reschedule_appointment`      | `reschedule_event_appointment`                                                            | `PATCH /v2/…/events/{event_id}/appointments/{id}`                                             |

`get_event_date_range` is catalogued but not called: `events_list_dates`
derives the first and last date from the dates themselves. Four V1 event
operations have no V2 twin and stay reachable through the executor:
`search_event_services`, `search_memberships_for_event`,
`check_memberships_for_event` and `list_timetable_schedule_day_events`. The V1
twins retired by V2 are `search_events`, `search_event_dates`,
`get_event_search_filters` and the nine same-id event operations. They are listed
in `catalog.superseded`.

## Backend behaviour the tools depend on

- **Past periods.** List and dates answer 422 when `filter[from]` is earlier
  than "now" in the location's time zone, unless `filter[include_deleted]` is
  set. The filters endpoint refuses a past start regardless. `events_list`
  therefore always sends `include_deleted` and drops cancelled events itself
  unless the caller asks for them. `events_list_dates` turns the refusal into a
  pointer at `events_list`.
- **Filters.** `filter[from]`/`[to]` are `Y-m-d H:i:s` local time. The other
  filters are `master_ids`, `service_ids`, `resource_ids`, `weekdays` (1–7,
  Monday first), `capacity` (minimum free seats) and `sort`. Duplication
  pattern `days` use 0 = Sunday. The tools say so.
- **Writes replace.** `PUT` on an event replaces the whole event. `PUT` on a
  booking always rewrites its service line (`cost_per_unit`,
  `discount_percent`, `manual_cost` = total after discount). It replaces
  `label_ids` (default `[]`) and syncs product items (an empty list drops
  them). The tools read first and send the current state back with the
  changes. `events_update_appointment` reprices when seats, price or discount
  change without an explicit total. It refuses a booking that has product
  items rather than drop them.
- **Rescheduling** only moves a booking that is waiting and unpaid. The source
  event must not be finished, the target must be in the future with enough
  seats, and the client must not already be booked there.
- **Bulk booking** takes 1–50 records. It answers 201 with the created bookings
  in `data` and the refused ones in `meta.errors[{index, phone, name, error}]`.
  The tool reports partial success with `isError` and fences the refusal
  reasons.
- **Duplicate** takes up to 100 ISO 8601 start times and `content_type` (1 =
  event only, 2 = with bookings). It answers with legacy containers (`date` as
  `Y-m-d H:i:s`, `records_count`).
- **Delete** is a soft delete that cancels every booking in the event and frees
  its resources. The location’s notification settings decide whether clients
  are told. The confirmation says so.
- **Conflicts.** A busy team member or resource answers 409. The tools suggest
  `force: true`.

## Live check (2026-09-29, read-only)

Two locations were read through the use cases: event lists for a past and a
future period, dates and filters, event services through V1, duplication
patterns, and an event with its bookings. Contacts stayed out of the text
unless requested. Names and comments came back inside the untrusted fence.
No live write was made because no disposable test location was available. The
write paths are covered by adapter tests against the contract above.
