# Source audit: client segment report

Investigated against the Altegio API OpenAPI repository (`ALTEGIO_API_DOCS`,
`origin/master`) and live behaviour of the documented endpoint on a demo
location on 2026-09-24. The task is to answer "which clients in this segment
have the most sales or visits?" with one bounded API request per page instead
of one card request per client.

| Contract     | Finding                                                                                                                                                                                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source       | Documented `POST /company/{location_id}/clients/search` (`get_client_list`)                                                                                                                                                                              |
| Access       | Requires the user's client-base access on the selected location; the endpoint applies the user's client permission filter. Phones and emails are separately masked when the user lacks the contact-access right.                                         |
| Paging       | 1-based `page`, `page_size` up to 200, `meta.total_count`. One result page is returned per tool call.                                                                                                                                                    |
| Fields       | Defaults to `id` only. Explicit `fields` requests `name`, `first_visit_date`, `last_visit_date`, `sold_amount`, `visits_count`, `discount`, `deposit_balance`. The new tool maps the legacy names to canonical output and never requests contact fields. |
| Filters      | Same typed client filters as `clients_search`, translated by `V1ClientsAdapter`; sorting maps `total_spent` to `sold_amount`.                                                                                                                            |
| Rate limit   | The endpoint is rate limited and may answer 429; the existing client error mapper explains retry.                                                                                                                                                        |
| Side effects | No business mutation or saved report.                                                                                                                                                                                                                    |

`total_spent` is the client card's lifetime `sold_amount` (client-base money
plus arrived service costs and product sales), in major currency units; it is
not cash collected, recognized revenue or a sum for the requested appointment
filter period. `visit_count` counts arrived visits; first and last visit dates
use the same arrived condition. `client_account_balance` is the available
`deposit_balance` for the card's phone and visible deposit types, so cards
sharing a phone can show the same balance. Dates are local calendar dates as
returned by the source. The page is never presented as a whole-base aggregate;
only `total_count` covers every page.

Several columns are computed per row on the server. One API call per page
removes client-by-client network requests but does not guarantee low latency,
especially for a large segment sorted by a calculated value. The tool therefore
caps each page at 200 rows and exposes paging rather than running an unbounded
export.

Missing or unparsable optional metrics become `null`, never zero. The output
projection drops every source field outside this contract, including unexpected
contact fields. The existing Analytics Constructor remains disabled because its
production data path is unreliable; this tool does not use it. Source-shaped
synthetic fixture data pins the request and mapping; a live call still needs
verification against a location with representative clients before asserting
production report values.
