# Source audit: full client profile pages

The recurring task is to obtain a usable client base without one API call per
client. The documented segmentation endpoint returns a selected field projection
and cannot include tags or custom fields. The older client-list endpoint returns
the same full profile shape as a card for every client on the requested page.

Everything below is the documented contract plus behaviour observed live on a
demo location on 2026-09-24.

| Contract     | Finding                                                                                                                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source       | Documented, deprecated `GET /clients/{location_id}` (`deprecated_get_client_list`)                                                                                                                                                                                    |
| Access       | Requires both location-editing and client-base access; a visiting team member sees only the clients of their own appointments. Contact and comment fields follow the user's contact-access rights.                                                                    |
| Filters      | `fullname`, `phone`, `email`, `card`, `id`/`id[]`, positive integer `paid_min`/`paid_max` (MCP inputs `total_paid_min`/`total_paid_max`), ISO `changed_after`/`changed_before`. These are independent of the typed client-search filters.                             |
| Paging       | Ascending client ID, 1-based `page`, `count` maximum 300, exact `meta.total_count`. MCP caps each page at 50 and client ID lists at 50.                                                                                                                               |
| Fields       | Name parts, display name, contact fields, gender, importance, loyalty card, discount, birthday, comment, SMS flags, lifetime spent and paid, balance, visits, changed time, tags and custom fields. The MCP maps names and numeric codes to canonical profile fields. |
| Side effects | Read only. No report creation or export.                                                                                                                                                                                                                              |

The `spent`, `paid`, `visits` and `balance` values are lifetime/current client
card measures. They are **not** totals for a date filter; `changed_after` only
selects which cards are returned. The API does not provide an as-of snapshot,
so paging a changing base may see inserts or edits between requests. The tool
returns each page and its total without claiming a consistent whole-base export.

### Paid-range filter traps (verified 2026-09-24)

The endpoint reads an absent `paid_min` or `paid_max` as 0 and compares
against both, so a minimum alone excludes every client with a positive paid
amount. The matching clients become an ID list, intersected with `id[]` when
given, and the ID filter is applied only for a non-empty list: when nothing
matches, the filter disappears and the endpoint returns the unfiltered base
with its full total. On the demo location, `paid_min=1` returned 94 of 94
clients, `paid_min=1&paid_max=<ceiling>` 65, and a range nobody reaches 94
again.

The MCP therefore sends `paid_max=9007199254740991` with a lone minimum,
refuses `total_paid_min > total_paid_max`, and refuses any page containing a
profile whose `total_paid` falls outside the requested bounds or whose ID is
outside `client_ids` — that page is the unfiltered fallback, which usually
means no client matched. The filter's paid sum and the card's `total_paid`
are evidently computed differently (the filter appears to count only visit
payments of arrived visits); they agreed for every range probed on the demo
location, and a disagreement also refuses rather than returning a mislabelled
page.

Standard phone and email fields are omitted from MCP output unless
`include_contacts` is true; custom fields require `include_custom_fields`.
Source-side masking remains in force. Free-text profile fields are treated as
untrusted. Invalid rows or missing totals fail the page rather than silently
dropping records. The source can require more server work than the summary
search because it loads labels, custom fields and financial totals per page.
Use the summary search for broad segmentation and this endpoint for bounded
full-card retrieval. Replace the adapter when V3 provides an equivalent
documented profile-list contract; keep the MCP shape and permission behavior.

A read-only live call against the demo location on 2026-09-24 returned a valid
total count and one full profile with tags, custom fields and paid amount. A
second call through the MCP use case verified that its default projection
omitted standard phone, email and custom-field keys. No client values were
printed or recorded.
