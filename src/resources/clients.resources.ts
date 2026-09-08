/**
 * Clients resources — the client-base segmentation reference.
 *
 * One document under `altegio://docs/clients-segmentation`: the full filter
 * vocabulary of `clients_search`, the canonical → v1 mapping, the two
 * visit-outcome numberings, and worked segments. Written in canonical product
 * vocabulary; the legacy wire words appear only as the "sends" column of the
 * mapping table, which is their documented purpose.
 */
import type { ResourceModule } from './registry.js';

export const CLIENTS_SEGMENTATION_URI = 'altegio://docs/clients-segmentation';

const SEGMENTATION_MARKDOWN = `# Client-base segmentation (clients_search)

\`clients_search\` filters and counts the client base of one location. It returns
the **total match count** across all pages plus one page of clients (id and
name). Order it by \`total_spent\`, \`visit_count\` or \`last_visit_date\` to get
top or lapsing clients first.

- **match**: \`all\` (every filter must hold, the default) or \`any\` (any filter).
- **paging**: \`page\` (1-based) and \`page_size\` (max 200, default 25).
- **fields**: advanced — extra columns per row. Leave unset for a reliable
  id + name list; the total count is always returned regardless.

Money is in **major units** (e.g. 71842 means 71 842 of the location's currency),
never minor units.

## Filters

Each filter is optional. Range filters (\`{from, to}\`) accept either bound alone.

| Canonical filter | Shape | Meaning | Sends (v1) |
|---|---|---|---|
| \`query\` | string | Free text over name, phone, email | \`quick_search\` |
| \`client_ids\` | number[] | Restrict to these client ids | \`id\` |
| \`total_spent\` | {from,to} | Lifetime money sold to the client | \`sold_amount\` |
| \`importance\` | enum[] | Loyalty class: none, bronze, silver, gold | \`importance\` (0–3) |
| \`gender\` | enum[] | unknown, male, female | \`gender\` (0–2) |
| \`tag_ids\` | number[] | Client **tag/label** ids (not service categories) | \`category\` |
| \`birthday\` | {from,to} | Birthday window; \`MM-DD\` for a day-of-year band | \`birthday\` |
| \`age\` | {from,to} | Age in years | \`age\` |
| \`has_mobile_app\` | boolean | Installed the location's mobile app | \`has_mobile_app\` |
| \`client_account_balance\` | {from,to} | Prepaid client-account (deposit) balance | \`deposit_balance\` |
| \`membership_balance\` | {from,to} | Remaining balance on memberships | \`abonement_balance\` |
| \`membership_type_ids\` | number[] | Holds one of these membership types | \`abonement_types\` |
| \`membership_is_frozen\` | boolean | Has a frozen membership | \`abonement_is_frozen\` |
| \`membership_is_used\` | boolean | Has used a membership | \`abonement_is_used\` |
| \`gift_card_balance\` | {from,to} | Remaining balance on gift cards | \`certificate_balance\` |
| \`gift_card_type_ids\` | number[] | Holds one of these gift-card types | \`certificate_types\` |
| \`gift_card_is_used\` | boolean | Has used a gift card | \`certificate_is_used\` |
| \`newsletter_allowed\` | boolean | Agreed to receive newsletters | \`is_newsletter_allowed\` |
| \`mass_notification_allowed\` | boolean | Included in mass notifications | \`is_mass_notification_allowed\` |
| \`push_enabled\` | boolean | Push notifications enabled | \`is_push_notification_enabled\` |
| \`personal_data_processing_allowed\` | boolean | Consented to data processing | \`is_personal_data_processing_allowed\` |
| \`appointments\` | object | Appointment-history filter (below) | \`record\` |

### appointments (appointment-history filter)

Filters clients by their past appointments. Sub-fields are ANDed together.

- \`team_member_ids\`, \`service_ids\`, \`service_category_ids\`: number[]
- \`outcome\`: enum[] — \`waiting\`, \`confirmed\`, \`arrived\`, \`no_show\`
- \`created\`: {from,to} — when the appointment was created
- \`count\`: {from,to} — how many matching appointments the client has
- \`amount\`: {from,to} — money sold across the matching appointments
- \`exclude\`: boolean — **invert** the whole filter: clients who did NOT have a
  matching appointment. This is how a lapsed / win-back segment is built.

## The two visit-outcome numberings (important)

The same four outcomes are numbered differently by the two client endpoints.
The pack maps canonical names for you; this is documented so results are read
correctly.

| Outcome | \`clients_search\` appointment filter | \`clients_get_visit_history\` |
|---|---|---|
| no_show (did not come) | 1 | -1 |
| waiting | 2 | 0 |
| arrived (came) | 3 | 1 |
| confirmed | 4 | 2 |

## Worked segments

**Top spenders / VIPs** — clients who spent over 50 000, richest first:
\`\`\`json
{ "location_id": 123, "filters": { "total_spent": { "from": 50000 } },
  "order_by": "total_spent", "order_direction": "desc" }
\`\`\`

**Lapsed / win-back** — no arrived appointment in a chosen window:
\`\`\`json
{ "location_id": 123, "filters": { "appointments": {
    "outcome": ["arrived"], "created": { "from": "2026-06-01 00:00:00" },
    "exclude": true } } }
\`\`\`

**Birthday campaign** — birthdays this month, reachable by campaign:
\`\`\`json
{ "location_id": 123, "filters": {
    "birthday": { "from": "09-01", "to": "09-30" },
    "mass_notification_allowed": true } }
\`\`\`

**Active membership holders** — a positive membership balance:
\`\`\`json
{ "location_id": 123, "filters": { "membership_balance": { "from": 1 } } }
\`\`\`

## Neighbours

- One client's full card: \`clients_get_card\`.
- One client's visit/purchase history (and unpaid visits): \`clients_get_visit_history\`.
- Resolve a name to an id fast: \`clients_lookup\`.
- Per-client attended/missed counts and lifetime money: \`analytics_get_client_visit_stats\`.
- Predicted revenue and visits from the base (the RFM model): \`analytics_get_forecast\`
  (the endpoint is named "rfm/overall" but returns a forecast-vs-actual, not RFM
  segments — there is no RFM-segment API).
`;

export const clientsResources: ResourceModule = {
  resources: [
    {
      uri: CLIENTS_SEGMENTATION_URI,
      name: 'clients-segmentation',
      title: 'Client-base segmentation reference',
      description:
        'Every clients_search filter, its meaning and the v1 field it maps to, the two visit-outcome numberings, and worked segments (VIPs, win-back, birthday campaigns, membership holders).',
      mimeType: 'text/markdown',
      read: () => SEGMENTATION_MARKDOWN,
    },
  ],
};
