# V1 API contract notes

This document records API behavior that materially affects safe location
management. Curated MCP tools use public B2B V1 only; internal V2 endpoints are
not used.

## Canonical URLs

The V1 specification documents operations on canonical resource URLs:
`/locations`, `/locations/{location_id}/…`, `…/team_members`,
`…/appointments`, `…/events`, `…/products`, `…/product_categories` and
`/chains`. The backend still accepts the legacy spellings (`/companies`,
`/company/{id}`, `/staff/{id}`, `/records/{id}`, `/record/{id}/{rid}`,
`/activity/{id}`, `/goods/{id}`, `/groups`, `/chain/{id}`) and routes both to
the same handler with the same response.

Every curated tool calls a documented operation on exactly the URL the
specification documents, so `src/tools/api-mapping.ts` matches the spec
one-to-one and the universal executor calls the same URL the catalog shows.
The backend alias table is not copied into this repository. Undocumented
operations in `catalog/extended/*.yaml` keep the legacy URL they were observed
on until the specification publishes them. The Marketplace permission probe keeps
the path from the developers specification.

## Corrected MCP behavior

- All V1 location list and single-location reads enforce `my=1`, including
  calls through the universal executor and legacy URL aliases. The filter is
  server policy, not a caller-controlled option. `locations_list` still accepts
  the deprecated `managed_only` flag for compatibility, but neither value can
  disable the filter; its advertised default is now `true`.
- `locations_list` with a declared `X-Altegio-Company-Id` scope resolves those
  exact location IDs. It does not depend on `GET /locations?my=1`, which may be
  empty for per-request application credentials. Pagination is one-based.
- Service creation defaults `active` to `1`. Service output uses the API's
  canonical price fields and exposes activation, duration and team-member links.
- `services_update` reads the current service, merges only the requested fields,
  preserves the full `staff` link array, and sends the documented
  `PUT /services/{location_id}/{service_id}` request. It refuses an unsafe update
  when the read response does not include `staff`.
- Appointment output preserves staff, client, service lines, totals and raw
  attendance/confirmation fields while also projecting a canonical visit status.
- `locations_update` performs a read-back and reports fields as verified or
  unconfirmed; it never claims success from the PUT response alone.
- Public V1 destructive tools use the exact documented entity endpoint for
  clients, service categories, booking forms, and location users. User removal
  requires the same user ID in `user_id` and `confirm_user_id`.
- Positions use `GET /locations/{location_id}/team_members/positions` and
  `POST /locations/{location_id}/positions/quick`. Public V1 has no position
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
