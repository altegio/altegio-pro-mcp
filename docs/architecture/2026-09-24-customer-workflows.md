# Customer workflow contracts (2026-09-24)

Source: `biz.erp.api.docs` master after PRs #119 and #120, especially
`docs/source-audits/attendance-client-card-workflows.md`, plus the V1 path
contracts. The adapters use only documented B2B V1 routes. V3 remains preview.

## Access diagnosis

`diagnose_location_access` reads the current user's Location via
`GET /company/{location_id}?my=1` and effective rights via
`GET /user/permissions/{location_id}`. The optional Marketplace application
read is the developers-contract
`GET /company/{location_id}/marketplace/applications/{application_id}/permissions`.
It returns _declared_ rights, not installation state or effective system-user
rights, and itself requires Manage user rights. The API exposes no partner-token
permission introspection. A 403 at the first read establishes that the current
partner-and-user credential pair cannot read the Location; it does not isolate
which grant failed. A successful rights read
allows the caller to inspect specific boolean rights but does not prove why a
different operation failed. Unknown rights remain null.

## Memberships and money

`clients_get_membership_purchases` starts from the client's current card phone,
then uses `GET /loyalty/abonements?company_id=…&phone=…`. Because that lookup is
by phone, each candidate is checked through the client-specific membership
history route before it is called verified. A 404 candidate is excluded; a
403 increments an unverified count without returning its details. At most 20
candidates are inspected.
Current-phone lookup can miss prior phone numbers, transferred, deleted or
otherwise omitted memberships, so this is not a complete historical ledger.

`created_date` is membership creation (`created_at`), never labeled a sale. The
current type `cost` is not a purchase price. For a linked `goods_transaction_id`,
the tool reads the goods transaction and requires a sale transaction, a matching
membership type, one sold unit and a non-deleted record before reporting its
`create_date` as `sale_date` and `cost_per_unit` as `recorded_unit_price` — the
unit price recorded on that transaction, not a proven membership price or paid
amount. It follows `document_id` to the sale document when permitted. The sale
document can contain multiple items and payments, and the public contract does
not link this goods transaction to a unique sale-item payment allocation.
`paid_amount` therefore remains null, even if the document includes a payment
total. Each row states its evidence in two canonical fields:
`sale_transaction` (`verified`, `not_linked`, `mismatch`, `forbidden`,
`not_found`, `unavailable`) and `sale_document` (`readable`, `not_linked`,
`not_checked`, `forbidden`, `not_found`, `unavailable`). A readable document is
only that — its items are not matched to the membership.

## Attendance

`appointments_preview_attendance` accepts 1–20 unique IDs, reads each
appointment, its current status (canonical `waiting`, `confirmed`, `arrived`,
`no_show`) and visit link — a zero visit ID means none — and reports the user's
appointment-form and edit rights and edit window (`records_edit_last_days_count`,
-1 = no limit) as `can_open_appointment_form`, `can_edit_appointments` and
`edit_window_days` when the rights API is available. It mints a ten-minute token
bound to the location, IDs, target status and that snapshot.
`appointments_apply_attendance` takes the same selection plus the token (the
snapshot itself is not echoed back), requires human confirmation, re-reads every
selected appointment and refuses when the token does not match the current
snapshot, then sends one
`POST /company/{location_id}/records/{record_id}/attendance` per distinct
selected visit group. It re-reads selected group members after each response
and stops on the first failure; each group reports an `outcome` of `updated`,
`already_target_status`, `write_failed` (with the HTTP status) or
`write_unverified`. The backend may update linked appointments
that were not selected and trigger payment, loyalty or notification work. A
response's `records` field is timetable-change data, not a per-ID bulk result.
The workflow is not atomic and cannot roll back earlier successful groups.
The backend remains authoritative for the history window, online payment,
payment policy and printed receipt restrictions; a preview cannot guarantee
that these rules will allow a later write.

## Client comments and files

List/add comments use the corrected
`/company/{location_id}/clients/{client_id}/comments` path. The former
`/clients/{location_id}/clients/…` path was documentation drift and is not
used. Comment text is nonblank and at most 255 characters; a form URL remains
text. File listing uses
`/company/{location_id}/clients/files/{client_id}`. Results expose at most 50
entries and state when more exist. Free text from comments, membership labels
and filenames is sanitized in structured output and fenced as untrusted data in
the text result. A file's `size_label` is the source's human-readable size
(for example `96.65 KB`), not a byte count.

Hosted upload uses the `clients_upload_file` MCP tool. The caller sends the
completed file bytes as canonical raw base64 (`file_base64`) plus `filename`;
URLs and data URIs are not fetched. The HTTP server accepts JSON bodies up to
17 MiB, enough for one file strictly below the backend's 12 MiB cap after
base64 encoding. It validates filename, extension, canonical encoding and byte
size, then sends authenticated multipart form data as field `file` to the
published V1 operation. The client adapter confines location scope before
transport; backend checks client ownership and `clients_access` plus
`client_files_upload_access`. The successful API response is the complete file
list; MCP projects at most 50 entries and states whether the projection is
complete. The proxy streams request bytes without buffering or a lower body
limit on service routes. The public Cloud Run ingress has a 32 MiB HTTP/1
request limit, above the bounded MCP body. Hosts must be able to submit a
large string tool argument; clients that cannot supply local file bytes need
an external file-reading step before calling this tool.
