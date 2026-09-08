/**
 * `[Clients]` tool pack — the client base of one location.
 *
 * Four read tools: segment the client base by value, engagement, loyalty and
 * consent (`clients_search`); read one client card (`clients_get_card`); read a
 * client's visit and purchase history (`clients_get_visit_history`); and a fast
 * typeahead lookup (`clients_lookup`).
 *
 * All names, parameters and result fields use canonical product vocabulary; the
 * legacy v1 filter dialect (`record`, `abonement`, `certificate`, `category`,
 * `sold_amount`, and the two visit-outcome numberings) stops in
 * `src/capabilities/clients/vocabulary.ts`, `.../filters.ts` and the v1 adapter.
 * The full filter reference lives in the `altegio://docs/clients-segmentation`
 * resource.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import * as clients from '../../capabilities/clients/use-cases.js';

// ========== shared input pieces ==========

const locationId = z
  .number()
  .int()
  .positive()
  .describe(
    'Location whose client base to work with. Call list_locations when the id is unknown.'
  );

const moneyRange = z
  .object({
    from: z
      .number()
      .optional()
      .describe('Lower bound, inclusive, major units.'),
    to: z.number().optional().describe('Upper bound, inclusive, major units.'),
  })
  .describe('A money range in major units; give from, to, or both.');

const numberRange = z
  .object({
    from: z.number().int().optional(),
    to: z.number().int().optional(),
  })
  .describe('A whole-number range; give from, to, or both.');

const dateRange = z
  .object({
    from: z
      .string()
      .optional()
      .describe('Start, `YYYY-MM-DD` (or `MM-DD` for a birthday).'),
    to: z
      .string()
      .optional()
      .describe('End, `YYYY-MM-DD` (or `MM-DD` for a birthday).'),
  })
  .describe('A date range; give from, to, or both.');

const appointmentHistory = z
  .object({
    team_member_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe(
        'Only appointments with these team members (get_staff for ids).'
      ),
    service_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe(
        'Only appointments that include these services (get_services for ids).'
      ),
    service_category_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe('Only appointments in these service categories.'),
    outcome: z
      .array(z.enum(['waiting', 'confirmed', 'arrived', 'no_show']))
      .optional()
      .describe(
        'Only appointments that ended in these outcomes (arrived = the client came).'
      ),
    created: dateRange
      .optional()
      .describe('Only appointments created in this window.'),
    count: numberRange
      .optional()
      .describe('How many matching appointments the client has.'),
    amount: moneyRange
      .optional()
      .describe('Money sold across the matching appointments.'),
    exclude: z
      .boolean()
      .optional()
      .describe(
        'Invert the match: return clients who did NOT have such an appointment — this is how you build a lapsed / win-back segment (e.g. "no visit in the last 90 days").'
      ),
  })
  .describe(
    'Filter clients by their appointment history. Combine with a date window on `created` plus `exclude: true` to find clients who have gone quiet.'
  );

const filters = z
  .object({
    query: z
      .string()
      .optional()
      .describe('Free text over name, phone and email.'),
    client_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe('Restrict to these client ids.'),
    total_spent: moneyRange
      .optional()
      .describe(
        'Lifetime money sold to the client — use a high `from` for top spenders / VIPs.'
      ),
    importance: z
      .array(z.enum(['none', 'bronze', 'silver', 'gold']))
      .optional()
      .describe('Loyalty importance class.'),
    gender: z.array(z.enum(['unknown', 'male', 'female'])).optional(),
    tag_ids: z
      .array(z.number().int().positive())
      .optional()
      .describe(
        'Client tag (label) ids — the coloured labels on a client card, not service categories.'
      ),
    birthday: dateRange
      .optional()
      .describe(
        'Birthday window; `MM-DD` for a day-of-year band (e.g. birthdays this month for a campaign).'
      ),
    age: numberRange.optional(),
    has_mobile_app: z
      .boolean()
      .optional()
      .describe('Whether the client installed the location’s mobile app.'),
    client_account_balance: moneyRange
      .optional()
      .describe('Prepaid client-account (deposit) balance.'),
    membership_balance: moneyRange
      .optional()
      .describe('Remaining balance on the client’s memberships.'),
    membership_type_ids: z.array(z.number().int().positive()).optional(),
    membership_is_frozen: z.boolean().optional(),
    membership_is_used: z.boolean().optional(),
    gift_card_balance: moneyRange
      .optional()
      .describe('Remaining balance on the client’s gift cards.'),
    gift_card_type_ids: z.array(z.number().int().positive()).optional(),
    gift_card_is_used: z.boolean().optional(),
    newsletter_allowed: z
      .boolean()
      .optional()
      .describe('Client agreed to receive newsletters.'),
    mass_notification_allowed: z
      .boolean()
      .optional()
      .describe(
        'Client is included in mass notifications — filter on true before a campaign.'
      ),
    push_enabled: z.boolean().optional(),
    personal_data_processing_allowed: z.boolean().optional(),
    appointments: appointmentHistory.optional(),
  })
  .describe(
    'Segmentation filters. Every field is optional; the ones given are combined by `match`. See altegio://docs/clients-segmentation for the full reference and worked segments.'
  );

// ========== output schema pieces ==========

const num = { type: ['number', 'null'] as const };
const str = { type: ['string', 'null'] as const };
const int = { type: ['integer', 'null'] as const };

function objectSchema(properties: Record<string, object>, required?: string[]) {
  return {
    type: 'object' as const,
    properties,
    ...(required ? { required } : {}),
  };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

// ========== clients_search ==========

export const clientsSearchTool = defineTool({
  name: 'clients_search',
  category: 'Clients',
  description:
    '[Clients] Segment the client base of one location and count the segment. This is the client-base analytics engine: filter by lifetime spend, visit count and recency, loyalty importance, tags, gender, birthday, age, memberships, gift cards, client-account balance, mobile-app and marketing consent, and — most powerfully — by appointment history with a team member, service or category, a status, a count, an amount and an `exclude` flag that turns the filter into a lapsed / win-back segment. Returns the total match count plus a page of clients (id and name), orderable by total_spent, visit_count, first/last visit date. Use it for "how many VIP clients do we have", "clients who spent over X", "clients with no visit in 90 days", "who has an active membership", "birthdays this month for a campaign". For one client’s full card use clients_get_card; for one client’s visit history use clients_get_visit_history; for predicted revenue from the base use analytics_get_forecast. Needs access to clients in this location.',
  annotations: { title: 'Clients: segment the client base', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    filters: filters.optional(),
    match: z
      .enum(['all', 'any'])
      .optional()
      .describe('Combine the filters with all (AND, default) or any (OR).'),
    order_by: z
      .enum([
        'id',
        'name',
        'phone',
        'email',
        'discount',
        'first_visit_date',
        'last_visit_date',
        'total_spent',
        'visit_count',
      ])
      .optional()
      .describe(
        'Sort field. Use total_spent or visit_count with order_direction=desc for the top clients.'
      ),
    order_direction: z.enum(['asc', 'desc']).optional(),
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('1-based page number (default 1).'),
    page_size: z
      .number()
      .int()
      .positive()
      .max(200)
      .optional()
      .describe('Rows per page, max 200 (default 25).'),
    fields: z
      .array(z.string())
      .optional()
      .describe(
        'Advanced: extra client fields to return per row beyond id and name. Leave unset for a reliable id+name list; the total count is always returned.'
      ),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    match: { type: 'string' as const },
    order_by: { type: 'string' as const },
    order_direction: { type: 'string' as const },
    total_count: { type: 'integer' as const },
    page: { type: 'integer' as const },
    page_size: { type: 'integer' as const },
    returned: { type: 'integer' as const },
    rows: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: { id: { type: 'integer' as const }, name: str },
        required: ['id', 'name'],
        additionalProperties: true,
      },
    },
    filters_applied: { type: 'object' as const },
  }),
  handler: async ({ input, client }) => clients.searchClients(client, input),
});

// ========== clients_get_card ==========

export const clientsGetCardTool = defineTool({
  name: 'clients_get_card',
  category: 'Clients',
  description:
    '[Clients] The full card of one client: name and contacts, loyalty importance and discount, lifetime money spent, client-account balance, visit count, tags, birthday-greeting and campaign-exclusion flags, and custom fields. Use it after clients_search or clients_lookup gives you a client id. For the client’s visit-by-visit history use clients_get_visit_history. Needs access to clients in this location.',
  annotations: { title: 'Clients: client card', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    client_id: z
      .number()
      .int()
      .positive()
      .describe('Client id, from clients_search or clients_lookup.'),
  }),
  outputSchema: objectSchema({
    id: { type: 'integer' as const },
    name: str,
    surname: str,
    patronymic: str,
    phone: str,
    email: str,
    gender: str,
    importance: str,
    discount: num,
    loyalty_card_number: str,
    birth_date: str,
    comment: str,
    total_spent: num,
    client_account_balance: num,
    visit_count: int,
    sms_birthday_greeting: { type: ['boolean', 'null'] as const },
    sms_excluded_from_campaigns: { type: ['boolean', 'null'] as const },
    tags: {
      type: 'array' as const,
      items: objectSchema({ id: int, title: str, color: str }),
    },
    custom_fields: { type: 'object' as const },
    last_changed_at: str,
  }),
  handler: async ({ input, client }) => clients.getClientCard(client, input),
});

// ========== clients_get_visit_history ==========

export const clientsGetVisitHistoryTool = defineTool({
  name: 'clients_get_visit_history',
  category: 'Clients',
  description:
    '[Clients] One client’s visit and purchase history, visit by visit: date, outcome (arrived, no_show, waiting, confirmed), the team member, the services and products with their cost, and how much was sold and paid. Identify the client by client_id or client_phone. Filter by date window, by payment status (unpaid, partly_paid, fully_paid, overpaid) and by outcome. Results are newest first and paged by date — pass the returned next_to as date_to to get the previous page. Use it for "what has this client bought", "does this client have unpaid visits", "when did they last come". For a base-wide segment use clients_search. Needs access to clients in this location.',
  annotations: { title: 'Clients: visit history', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    client_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Client id (preferred). Give this or client_phone.'),
    client_phone: z
      .string()
      .optional()
      .describe('Client phone, digits only, when the id is unknown.'),
    date_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe('First day of the window, YYYY-MM-DD.'),
    date_to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Last day of the window, YYYY-MM-DD. Pass the previous response’s next_to to page back in time.'
      ),
    payment_statuses: z
      .array(z.enum(['unpaid', 'partly_paid', 'fully_paid', 'overpaid']))
      .optional()
      .describe('Keep only visits with these payment statuses.'),
    outcome: z
      .enum(['waiting', 'confirmed', 'arrived', 'no_show'])
      .optional()
      .describe('Keep only visits with this outcome.'),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    client_id: { type: 'integer' as const },
    client_phone: { type: 'string' as const },
    count: { type: 'integer' as const },
    has_more: { type: 'boolean' as const },
    next_from: str,
    next_to: str,
    items: {
      type: 'array' as const,
      items: objectSchema({
        visit_id: int,
        date: str,
        outcome: str,
        payment_status: str,
        team_member_name: str,
        total_cost: num,
        total_paid: num,
        services: {
          type: 'array' as const,
          items: objectSchema({ title: str, cost: num }),
        },
        products: {
          type: 'array' as const,
          items: objectSchema({ title: str, cost: num }),
        },
      }),
    },
  }),
  handler: async ({ input, client }) => clients.getVisitHistory(client, input),
});

// ========== clients_lookup ==========

export const clientsLookupTool = defineTool({
  name: 'clients_lookup',
  category: 'Clients',
  description:
    '[Clients] Fast typeahead lookup of a client by a name fragment (also matches walk-in "comers"). Returns a short list of id, name and phone. Use it to resolve a name to a client id before clients_get_card or clients_get_visit_history. For a filtered, countable segment of the whole base use clients_search instead. Needs access to clients in this location.',
  annotations: { title: 'Clients: quick lookup', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    query: z.string().min(1).describe('A name fragment to search for.'),
    limit: z
      .number()
      .int()
      .positive()
      .max(25)
      .optional()
      .describe('Maximum matches, 1–25 (default 7).'),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    query: { type: 'string' as const },
    count: { type: 'integer' as const },
    items: {
      type: 'array' as const,
      items: objectSchema({
        id: { type: 'integer' as const },
        name: str,
        phone: str,
      }),
    },
  }),
  handler: async ({ input, client }) => clients.lookupClients(client, input),
});
