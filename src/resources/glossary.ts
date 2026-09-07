/**
 * Canonical vocabulary served as `altegio://docs/glossary`.
 *
 * Condensed from the product glossary that governs the whole product
 * (`biz.erp` → `docs/product-glossary.md`, itself derived from the official
 * localization glossary). Only the terms an agent meets through this server's
 * tools are listed. The "Never use" column is the point of the resource: those
 * words appear in the legacy API and in older documentation, and reusing them
 * in a reply, a report title or a new field name reintroduces the ambiguity the
 * glossary removes.
 *
 * Kept in code rather than read from disk because the source document lives in
 * a different repository that is not deployed with this server.
 */
export const GLOSSARY_MARKDOWN = `# Altegio canonical vocabulary

The approved English term for every concept this server exposes, and the
synonyms that must not be used in replies, titles, report columns, or new
field names. Source of truth: the product glossary in the Altegio platform
repository (\`docs/product-glossary.md\`), derived from the official
localization glossary.

## People and roles

| Canonical term | What it is | Never use |
|---|---|---|
| **Team member** | One person on the location's team, as seen inside the business product: access rights, payroll, analytics, settings | Employee, Specialist, Staff (for the collective, use **Team**) |
| **Professional** | The same person in client-facing flows: online booking, the client app, client notifications | Specialist, Master |
| **Receptionist** | Front-desk role | Administrator |
| **Position** | Job title a team member holds | — |
| **Client** | The person who books and pays for services | Customer |

Decide by audience, not by mechanical replacement: an internal team record is a
**team member**, a service provider a client sees is a **Professional**.

## Business objects

| Canonical term | What it is | Never use |
|---|---|---|
| **Location** | One business unit with its own address, team and schedule | Branch, Company, Salon, Spot |
| **Chain** | Several locations under one brand, sharing settings and clients | Network, Internet |
| **Appointment** | One booked slot: client, professional, service, time | Visit, Record, Entry, Booking |
| **Visit** | The appointment as delivered and paid for | — |
| **Group event** | One slot with many clients | Session |
| **Service** | What the business sells and delivers in a slot | Work, Job |
| **Service category** | Grouping of services | — |
| **Package** | Bundled or four-hands services sold as one item | Complex |
| **Resource** | Equipment or a room an appointment occupies | — |
| **Products** | Retail items and consumables the location sells or uses | Goods, Items |

## Loyalty and client money

| Canonical term | What it is | Never use |
|---|---|---|
| **Membership** | Prepaid pass for a number of services or a period | Abonement, Certificate, Subscription |
| **Gift card** | Prepaid value bought for someone else | Certificate |
| **Loyalty card** | Card that identifies a client in a loyalty program | Membership card |
| **Loyalty program** | The rules that earn and spend bonuses or cashback | Loyalty (on its own) |
| **Client account** | The client's balance held by the location — money, not a login | Deposit, Personal account |

## Finance, payroll and inventory

| Canonical term | What it is | Never use |
|---|---|---|
| **Accounts** | Where money is held and counted | Cash registers, Cash drawers |
| **Financial transactions** | Individual money movements in and out | — |
| **Payroll** | What the team is paid and how it is calculated | Salary, Wage register |
| **Inventory** | Stock of products held by a location | Warehouse, Stock, Storage |

## Working surfaces

| Canonical term | What it is | Never use |
|---|---|---|
| **Digital schedule** | The grid of appointments per professional per day | Digital journal, Appointment calendar, Timetable |
| **Online booking** | The channel where clients book for themselves | Online reservation, Internet booking |
| **Analytics** | Reports and figures about the business | Statistics |

## Legacy names still on the wire

Some tool names and API fields predate this vocabulary — \`get_staff\`,
\`create_staff\`, \`salon_id\`, \`record_id\`. Call the tools by the names
\`tools/list\` returns, and use the canonical term in every sentence you write
back to a person.
`;
