# Demo-management API contract notes

This document records API behavior that materially affects safe demo-location
management. Curated MCP tools use public B2B V1 only; internal V2 endpoints are
not used.

## Corrected MCP behavior

- `list_locations` with a declared `X-Altegio-Company-Id` scope resolves those
  exact location IDs. It does not depend on `GET /companies?my=1`, which may be
  empty for per-request application credentials. Pagination is one-based.
- Service creation defaults `active` to `1`. Service output uses the API's
  canonical price fields and exposes activation, duration and team-member links.
- `update_service` reads the current service, merges only the requested fields,
  preserves the full `staff` link array, and sends the documented
  `PUT /services/{location_id}/{service_id}` request. It refuses an unsafe update
  when the read response does not include `staff`.
- Appointment output preserves staff, client, service lines, totals and raw
  attendance/confirmation fields while also projecting a canonical visit status.
- `update_location` performs a read-back and reports fields as verified or
  unconfirmed; it never claims success from the PUT response alone.
- Public V1 destructive tools use the exact documented entity endpoint for
  clients, service categories, booking forms, and location users. User removal
  requires the same user ID in `user_id` and `confirm_user_id`.
- Positions use `GET /company/{location_id}/staff/positions` and
  `POST /company/{location_id}/positions/quick`. Public V1 has no position
  update/delete contract, so those unsafe tools were removed.

## Upstream documentation or API follow-ups

- The location update request documents `phones`, but the documented response
  omits it and live persistence can disagree. The MCP therefore reports phone
  changes as unconfirmed unless read-back proves them.
- The modern staff-schedule controller expects wire key `staff_id`, while the
  public specification says `team_member_id`. The MCP keeps the canonical name
  at its boundary and translates it on the wire; the OpenAPI specification needs
  a separate correction.
- Some chain-owned entities return authorization errors even when visible. The
  MCP surfaces those failures and does not treat them as successful deletion.
- Resources remain read-only because public V1 documents no create, update, or
  delete operation.

The generated catalog remains the source of truth for documented operations;
write tools are deliberately curated and reviewed rather than enabled through
the universal read executor.
