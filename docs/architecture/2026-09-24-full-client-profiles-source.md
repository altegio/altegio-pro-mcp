# Source audit: full client profile pages

The recurring task is to obtain a usable client base without one API call per
client. The documented segmentation endpoint returns a selected field projection
and cannot include tags or custom fields. The older client-list endpoint returns
the same full profile shape as a card for every client on the requested page.

| Contract | Finding |
| --- | --- |
| Source | Documented, deprecated `GET /clients/{location_id}` (`deprecated_get_client_list`) |
| Implementation | `PageApiClientsController::action_read` → `CClientFilter` → `ClientContainerService::loadContainers` → `LegacyApiClientContainerTransformer` |
| Access | Both `canEditSalon` and `hasSalonClientsAccess`; the controller also narrows a visiting team member's clients to their appointments. Contact and comment permissions are applied by `ClientContainerService`. |
| Filters | `fullname`, `phone`, `email`, `card`, `id`/`id[]`, positive integer `paid_min`/`paid_max`, ISO `changed_after`/`changed_before`. These are independent of the typed client-search filters. |
| Paging | Ascending client ID, 1-based `page`, backend `count` maximum 300, exact `meta.total_count`. MCP caps each page at 50 and client ID lists at 50. |
| Fields | Name parts, display name, contact fields, gender, importance, loyalty card, discount, birthday, comment, SMS flags, lifetime spent and paid, balance, visits, changed time, tags and custom fields. The MCP maps names and numeric codes to canonical profile fields. |
| Side effects | Read only. No report creation or export. |

The `spent`, `paid`, `visits` and `balance` values are lifetime/current client
card measures. They are **not** totals for a date filter; `changed_after` only
selects which cards are returned. The API does not provide an as-of snapshot,
so paging a changing base may see inserts or edits between requests. The tool
returns each page and its total without claiming a consistent whole-base export.

Standard phone and email fields are omitted from MCP output unless
`include_contacts` is true; custom fields require `include_custom_fields`.
Source-side masking remains in force. Free-text profile fields are treated as
untrusted. Invalid rows or missing totals fail the page rather than silently
dropping records. The source can require more server work than the summary
search because it loads labels, custom fields and financial totals per page.
Use the summary search for broad segmentation and this endpoint for bounded
full-card retrieval. Replace the adapter when V3 provides an equivalent
documented profile-list contract; keep the MCP shape and permission behavior.
