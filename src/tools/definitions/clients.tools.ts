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
import {
  pageArg,
  pageSizeArg,
  paginationOutput,
  windowPaginationOutput,
} from '../pagination.js';

// ========== shared input pieces ==========

const locationId = z.number().int().positive().describe('From locations_list.');

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
    'Segment and count the client base of one location — the client analytics engine. Filter by lifetime spend, visits, loyalty, tags, gender, birthday, age, memberships, gift cards, balance, consent and appointment history (team member, service, outcome, count, amount; exclude=true for lapsed / win-back). Returns the exact count and a page of ids and names, orderable by total_spent, visit_count or visit dates. Next: clients_get_card, clients_get_visit_history.',
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
        'Sort field; total_spent or visit_count with desc for top clients.'
      ),
    order_direction: z.enum(['asc', 'desc']).optional(),
    page: pageArg,
    page_size: pageSizeArg(200),
    fields: z
      .array(z.string())
      .optional()
      .describe(
        'Advanced: extra fields per row beyond id and name; contacts need include_contacts.'
      ),
    include_contacts: includeContactsArg,
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    match: { type: 'string' as const },
    order_by: { type: 'string' as const },
    order_direction: { type: 'string' as const },
    contacts_included: { type: 'boolean' as const },
    items: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: { id: { type: 'integer' as const }, name: str },
        required: ['id', 'name'],
        additionalProperties: true,
      },
    },
    pagination: paginationOutput,
    filters_applied: { type: 'object' as const },
  }),
  handler: async ({ input, client }) => clients.searchClients(client, input),
});

// ========== clients_get_segment_report ==========

export const clientsGetSegmentReportTool = defineTool({
  name: 'clients_get_segment_report',
  category: 'Clients',
  description:
    'Paged client-base report: per client id, name, first and last arrived visit, lifetime sales, visit count, discount and balance. Same filters as clients_search; order by total_spent or visit_count. Values are lifetime, not for a period; page totals are not base totals. Exact count, up to 200 rows per page, no contacts.',
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
    page: pageArg,
    page_size: pageSizeArg(200),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    filters_applied: { type: 'object' as const },
    match: { type: 'string' as const },
    contacts_included: { type: 'boolean' as const },
    pagination: paginationOutput,
    items: {
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
    'A page of full client profiles by ascending id: tags, loyalty card, birthday, comments, lifetime spent and paid, visits, balance. Filters: name/contact/card, client ids, total_paid_min/max, change time. Up to 50 per page with exact total. Contacts need include_contacts, custom fields include_custom_fields. For segments use clients_search, then fetch profiles by id here.',
  annotations: { title: 'Clients: list full profiles', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    page: pageArg,
    page_size: pageSizeArg(50),
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
    total_paid_min: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Lowest lifetime total_paid, major units, inclusive.'),
    total_paid_max: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Highest lifetime total_paid, major units, inclusive (alone it includes clients who paid nothing).'
      ),
    changed_after: z.string().datetime({ offset: true }).optional(),
    changed_before: z.string().datetime({ offset: true }).optional(),
    include_contacts: includeContactsArg,
    include_custom_fields: z
      .boolean()
      .optional()
      .describe('Include location-defined client fields.'),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    contacts_included: { type: 'boolean' as const },
    custom_fields_included: { type: 'boolean' as const },
    pagination: paginationOutput,
    items: {
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
    'One client’s full card: loyalty importance and discount, lifetime spend, balance, visit count, tags, greeting and campaign flags, custom fields. Contacts need include_contacts. Visit by visit: clients_get_visit_history.',
  annotations: { title: 'Clients: client card', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    client_id: z
      .number()
      .int()
      .positive()
      .describe('From clients_search or clients_lookup.'),
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
    'One client’s visits, newest first: date, outcome, team member, services and products with cost, sold and paid. Identify by client_id or client_phone; filter by dates, payment status and outcome. Paged by date: pass pagination.next_date_to as date_to.',
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
        'Last day of the window, YYYY-MM-DD. Pass the previous response’s pagination.next_date_to to page back in time.'
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
    pagination: windowPaginationOutput,
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
    'Typeahead: client ids and names for a name fragment (walk-ins included); phone needs include_contacts. For counted segments use clients_search.',
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
    contacts_included: { type: 'boolean' as const },
    items: {
      type: 'array' as const,
      items: objectSchema({
        id: { type: 'integer' as const },
        name: str,
        phone: str,
      }),
    },
    pagination: paginationOutput,
  }),
  handler: async ({ input, client }) => clients.lookupClients(client, input),
});

// ========== clients_delete ==========

export const clientsDeleteTool = defineTool({
  name: 'clients_delete',
  category: 'Clients',
  description:
    'Permanently delete one specifically identified client from one location. Resolve and verify the exact client ID with clients_lookup or clients_get_card first; this is not a bulk cleanup operation.',
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
