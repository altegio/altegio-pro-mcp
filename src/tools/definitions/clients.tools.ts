/**
 * `[Clients]` tool pack — the client base of one location.
 *
 * Client-base segmentation, full profile pages, individual cards, visit
 * history, and typeahead lookup.
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
import { includeContactsArg } from '../contacts.js';
import * as clients from '../../capabilities/clients/use-cases.js';
import { clientFiltersSchema } from './client-filters.schema.js';

// ========== shared input pieces ==========

const locationId = z
  .number()
  .int()
  .positive()
  .describe(
    'Location whose client base to work with. Call list_locations when the id is unknown.'
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
    '[Clients] Segment the client base of one location and count the segment. This is the client-base analytics engine: filter by lifetime spend, visit count and recency, loyalty importance, tags, gender, birthday, age, memberships, gift cards, client-account balance, mobile-app and marketing consent, and — most powerfully — by appointment history with a team member, service or category, a status, a count, an amount and an `exclude` flag that turns the filter into a lapsed / win-back segment. Returns the total match count plus a page of clients (id and name), orderable by total_spent, visit_count, first/last visit date. Use it for "how many VIP clients do we have", "clients who spent over X", "clients with no visit in 90 days", "who has an active membership", "birthdays this month for a campaign". For one client’s full card use clients_get_card; for one client’s visit history use clients_get_visit_history; for per-client predicted revenue use analytics_get_client_forecast, and for the aggregate forecast use analytics_get_forecast. Needs access to clients in this location.',
  annotations: { title: 'Clients: segment the client base', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    filters: clientFiltersSchema.optional(),
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
        'Advanced: extra client fields to return per row beyond id and name. Leave unset for a reliable id+name list; the total count is always returned. Contact fields (phone, email) are dropped from this list unless include_contacts is true.'
      ),
    include_contacts: includeContactsArg,
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
    contacts_included: { type: 'boolean' as const },
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

// ========== clients_get_segment_report ==========

export const clientsGetSegmentReportTool = defineTool({
  name: 'clients_get_segment_report',
  category: 'Clients',
  description:
    '[Clients] A paged client-base report from one API request: each matching client’s id and name, first and last arrived-visit dates, lifetime sold amount, arrived-visit count, discount and client-account balance. Filter with the same model as clients_search, then order by total_spent or visit_count to find high-value clients without fetching every client card. The money and visit values are lifetime client-base measures, not revenue for the filter period. Returns an exact segment count and at most 200 rows per page; page totals must not be presented as whole-base totals. Contact details are never included. Needs access to clients in this location.',
  annotations: { title: 'Clients: client segment report', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    filters: clientFiltersSchema.optional(),
    match: z.enum(['all', 'any']).optional(),
    order_by: z
      .enum([
        'id',
        'name',
        'first_visit_date',
        'last_visit_date',
        'total_spent',
        'visit_count',
      ])
      .optional(),
    order_direction: z.enum(['asc', 'desc']).optional(),
    page: z.number().int().positive().optional(),
    page_size: z.number().int().positive().max(200).optional(),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    filters_applied: { type: 'object' as const },
    match: { type: 'string' as const },
    total_count: { type: 'integer' as const },
    page: { type: 'integer' as const },
    page_size: { type: 'integer' as const },
    returned: { type: 'integer' as const },
    has_more: { type: 'boolean' as const },
    contacts_included: { type: 'boolean' as const },
    rows: {
      type: 'array' as const,
      items: objectSchema(
        {
          id: { type: 'integer' as const },
          name: { type: 'string' as const },
          first_visit_date: str,
          last_visit_date: str,
          total_spent: num,
          visit_count: int,
          discount: num,
          client_account_balance: num,
        },
        [
          'id',
          'name',
          'first_visit_date',
          'last_visit_date',
          'total_spent',
          'visit_count',
          'discount',
          'client_account_balance',
        ]
      ),
    },
  }),
  handler: async ({ input, client }) =>
    clients.getClientSegmentReport(client, input),
});

// ========== clients_list_profiles ==========

export const clientsListProfilesTool = defineTool({
  name: 'clients_list_profiles',
  category: 'Clients',
  description:
    '[Clients] Read a page of full client profiles in ascending client-id order, with tags, loyalty card, birthday, comments, lifetime spent and paid amounts, visit count and client-account balance. Supports name/contact/card, client-id, paid-amount and last-changed filters. Returns exact total count and up to 50 profiles per page. Standard phone and email fields require include_contacts; custom fields require include_custom_fields. This older client-list API has simpler filtering than clients_search: use clients_search for loyalty or appointment-history segments, then pass its ids here to fetch their full profiles. Needs edit-location and client-base access.',
  annotations: { title: 'Clients: list full profiles', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    page: z.number().int().positive().optional(),
    page_size: z.number().int().positive().max(50).optional(),
    name: z.string().min(1).optional().describe('Substring of client name.'),
    phone: z
      .string()
      .min(1)
      .optional()
      .describe('Phone fragment to filter clients.'),
    email: z
      .string()
      .min(1)
      .optional()
      .describe('Email fragment to filter clients.'),
    loyalty_card_number: z.string().min(1).optional(),
    client_ids: z.array(z.number().int().positive()).min(1).max(50).optional(),
    paid_min: z.number().int().positive().optional(),
    paid_max: z.number().int().positive().optional(),
    changed_after: z.string().datetime({ offset: true }).optional(),
    changed_before: z.string().datetime({ offset: true }).optional(),
    include_contacts: includeContactsArg,
    include_custom_fields: z
      .boolean()
      .optional()
      .describe(
        'Include location-defined client fields in each profile (default false).'
      ),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    total_count: { type: 'integer' as const },
    page: { type: 'integer' as const },
    page_size: { type: 'integer' as const },
    returned: { type: 'integer' as const },
    has_more: { type: 'boolean' as const },
    contacts_included: { type: 'boolean' as const },
    custom_fields_included: { type: 'boolean' as const },
    rows: {
      type: 'array' as const,
      items: objectSchema(
        {
          id: { type: 'integer' as const },
          name: str,
          surname: str,
          patronymic: str,
          display_name: str,
          phone: str,
          email: str,
          gender: str,
          importance: str,
          discount: num,
          loyalty_card_number: str,
          birth_date: str,
          comment: str,
          total_spent: num,
          total_paid: num,
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
        },
        ['id']
      ),
    },
  }),
  handler: async ({ input, client }) =>
    clients.listClientProfiles(client, input),
});

// ========== clients_get_card ==========

export const clientsGetCardTool = defineTool({
  name: 'clients_get_card',
  category: 'Clients',
  description:
    '[Clients] The full card of one client: name, loyalty importance and discount, lifetime money spent, client-account balance, visit count, tags, birthday-greeting and campaign-exclusion flags, and custom fields. Phone and email are withheld unless you pass include_contacts: true. Use it after clients_search or clients_lookup gives you a client id. For the client’s visit-by-visit history use clients_get_visit_history. Needs access to clients in this location.',
  annotations: { title: 'Clients: client card', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    client_id: z
      .number()
      .int()
      .positive()
      .describe('Client id, from clients_search or clients_lookup.'),
    include_contacts: includeContactsArg,
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
    contacts_included: { type: 'boolean' as const },
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
    '[Clients] Fast typeahead lookup of a client by a name fragment (also matches walk-in "comers"). Returns a short list of id and name; the phone is withheld unless you pass include_contacts: true. Use it to resolve a name to a client id before clients_get_card or clients_get_visit_history. For a filtered, countable segment of the whole base use clients_search instead. Needs access to clients in this location.',
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
    include_contacts: includeContactsArg,
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    query: { type: 'string' as const },
    count: { type: 'integer' as const },
    contacts_included: { type: 'boolean' as const },
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

// ========== clients_delete ==========

export const clientsDeleteTool = defineTool({
  name: 'clients_delete',
  category: 'Clients',
  description:
    '[Clients] Permanently delete one specifically identified client from one location. AUTHENTICATION REQUIRED. Resolve and verify the exact client ID with clients_lookup or clients_get_card first; this is not a bulk cleanup operation.',
  annotations: {
    title: 'Clients: Delete One Client',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    client_id: z
      .number()
      .int()
      .positive()
      .describe('Exact client ID to delete'),
  }),
  confirm: {
    action: 'Delete client',
    target: (input) =>
      `client ${input.client_id} at location ${input.location_id}`,
    resolve: async (input, client) => {
      const { data } = await client.request<{
        id?: number;
        name?: string;
        phone?: string;
      }>('GET', `/client/${input.location_id}/${input.client_id}`);
      if (!data?.id) return undefined;
      const phone = data.phone ? `, ${data.phone}` : '';
      return `client ${data.name ?? 'without a name'}${phone}, id ${data.id}, at location ${input.location_id}`;
    },
    consequence:
      'The whole client card leaves the base: contact details, tags, comments, consent record and loyalty balances go with it, and the visit history rows lose the client they pointed at. This cannot be undone.',
  },
  handler: async ({ input, client }) => {
    await client.deleteClient(input.location_id, input.client_id);
    return {
      text: `Deleted client ${input.client_id} from location ${input.location_id}`,
    };
  },
});
