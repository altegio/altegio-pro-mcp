# Timur Valishev: API and MCP feedback

Source: the private Telegram conversation with `@timurvalishev`, reviewed on
2026-09-24. This is a concise product note, not a transcript. Dates below are
message dates. Statements attributed to Timur are distinct from Yri's replies.

## What Timur said

- **Client data is expensive to assemble.** On 2025-12-11 he pointed out that
  `get_a_list_of_clients` returned only client IDs in his use case, requiring
  many further requests. He mentioned another client endpoint returning client
  categories with each client. The observed API behavior needs verification
  against the current backend before selecting an MCP implementation.
- **Agent-readable API documentation matters.** On 2025-12-25 he asked for
  plaintext documentation for agents instead of parsing the developer site.
  Yri pointed him to downloadable JSON and Markdown documentation.
- **Natural-language reporting is valuable, but costly.** On 2026-05-13 he
  described an employee typing the report they need into a single-input web
  interface; Claude then works from a PostgreSQL schema. He reported roughly
  $3–4 per report, said the API was slow and required joins, and that he had
  rebuilt Altegio's reports. These are his experience and cost estimate, not
  measurements of this MCP server.
- **MCP access for employees interests him.** He explicitly proposed giving
  MCP to employees, while raising concern about prompt injection and agent
  behavior. Scoped permissions and clear read/write boundaries are relevant.

## Product implications to validate

1. Return useful, bounded client rows from a single search request, including
   explicit field projection and totals, so a report need not fetch each card.
2. Offer task-shaped, read-only reports over verified source data. Show metric
   definitions and coverage; avoid the disabled Analytics Constructor until its
   production data path is repaired and rechecked.
3. Keep contact details opt-in, enforce caller scopes, and retain a separate
   read-only MCP address for employee agents.
4. Keep the API catalog and resource documentation machine readable.

Timur did not specify exact report columns or formulas in the messages reviewed.
The subsequently supplied screenshots and service-penetration PDF establish
concrete report structures and metric definitions; see
[Timur's report examples](2026-09-24-timur-report-needs.md). The proposed client
report remains an implementation hypothesis, not a confirmed requirement from
him.
