/**
 * Clients use cases — everything the `clients_*` tools actually do.
 *
 * A use case takes the tool's parsed input plus an `AltegioClient`, calls the
 * `ClientsApi` port through the v1 adapter, and returns the text summary next to
 * the structured content. The segmentation filter model is canonical here and
 * only becomes the v1 wire dialect inside the adapter.
 *
 * Contacts are opt-in throughout: a client's phone and email leave this module
 * only when the caller passed `include_contacts`, in the text summary and in the
 * structured content alike. That is the default projection of the "read clients
 * without contacts" access level, and it keeps the cost of a leak low while the
 * token still carries the full read scope.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { httpFromClient } from '../../api/altegio-http.js';
import { V1ClientsAdapter } from '../../api/v1/clients-adapter.js';
import type {
  ClientSegmentRow,
  ClientProfilesQuery,
  ClientSearchFilters,
  ClientSortField,
  FilterMatch,
  VisitPaymentStatus,
  AppointmentOutcome,
} from '../../api/clients-api.js';
import { ClientsInputError } from './errors.js';
import {
  cardSummary,
  lookupSummary,
  segmentSummary,
  visitHistorySummary,
} from './projections.js';

export interface ClientsResult {
  text: string;
  structuredContent: unknown;
}

/** Largest page the search endpoint accepts. */
const MAX_PAGE_SIZE = 200;
const DEFAULT_PAGE_SIZE = 25;
/** How many rows to spell out in the text summary. */
const ROWS_IN_SUMMARY = 20;

/**
 * Client fields that are contact details. Withheld unless the caller asked for
 * them — including through the advanced `fields` escape hatch of the search.
 */
const CONTACT_FIELDS = ['phone', 'email'] as const;

function adapter(client: AltegioClient): V1ClientsAdapter {
  return new V1ClientsAdapter(httpFromClient(client));
}

/**
 * Drop the contact keys from a card or from one row of opt-in fields. The
 * result is a plain bag: what is left is no longer the full DTO, and it only
 * ever flows into `structuredContent`.
 */
function withoutContacts(row: object): Record<string, unknown> {
  const copy = { ...row } as Record<string, unknown>;
  for (const field of CONTACT_FIELDS) delete copy[field];
  return copy;
}

// ========== segmentation ==========

export interface SearchInput {
  location_id: number;
  filters?: ClientSearchFilters;
  match?: FilterMatch;
  order_by?: ClientSortField;
  order_direction?: 'asc' | 'desc';
  page?: number;
  page_size?: number;
  fields?: string[];
  include_contacts?: boolean;
}

export async function searchClients(
  client: AltegioClient,
  input: SearchInput
): Promise<ClientsResult> {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(
    1,
    Math.min(input.page_size ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  );
  const filters = input.filters ?? {};
  const includeContacts = input.include_contacts === true;
  // `fields` is free-form, so it is the one way a segment could ask for
  // contacts without the flag. Drop them here rather than at the wire.
  const fields = includeContacts
    ? input.fields
    : input.fields?.filter(
        (field) =>
          !(CONTACT_FIELDS as readonly string[]).includes(field.toLowerCase())
      );

  const segment = await adapter(client).searchClients({
    location_id: input.location_id,
    filters,
    match: input.match ?? 'all',
    page,
    page_size: pageSize,
    ...(input.order_by ? { order_by: input.order_by } : {}),
    ...(input.order_direction
      ? { order_direction: input.order_direction }
      : {}),
    ...(fields?.length ? { fields } : {}),
  });
  // `id` and `name` are the two fields a row always carries, and neither is a
  // contact, so the narrowed row is still a `ClientSegmentRow`.
  const rows: ClientSegmentRow[] = includeContacts
    ? segment.rows
    : segment.rows.map((row) => withoutContacts(row) as ClientSegmentRow);

  return {
    text: segmentSummary({ ...segment, rows }, input.order_by, ROWS_IN_SUMMARY),
    structuredContent: {
      location_id: input.location_id,
      match: input.match ?? 'all',
      ...(input.order_by
        ? {
            order_by: input.order_by,
            order_direction: input.order_direction ?? 'desc',
          }
        : {}),
      filters_applied: filters,
      total_count: segment.total_count,
      page: segment.page,
      page_size: segment.page_size,
      returned: rows.length,
      rows,
      contacts_included: includeContacts,
    },
  };
}

/** One-page client value/engagement report without per-client card requests. */
export async function getClientSegmentReport(
  client: AltegioClient,
  input: Omit<SearchInput, 'fields' | 'include_contacts'>
): Promise<ClientsResult> {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.max(
    1,
    Math.min(input.page_size ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
  );
  const report = await adapter(client).searchClientReport({
    location_id: input.location_id,
    filters: input.filters ?? {},
    match: input.match ?? 'all',
    page,
    page_size: pageSize,
    ...(input.order_by ? { order_by: input.order_by } : {}),
    ...(input.order_direction
      ? { order_direction: input.order_direction }
      : {}),
  });
  return {
    text: segmentSummary(
      {
        ...report,
        rows: report.rows.map(({ id, name }) => ({ id, name })),
      },
      input.order_by,
      ROWS_IN_SUMMARY
    ),
    structuredContent: {
      location_id: input.location_id,
      filters_applied: input.filters ?? {},
      match: input.match ?? 'all',
      total_count: report.total_count,
      page: report.page,
      page_size: report.page_size,
      returned: report.rows.length,
      has_more: report.total_count > page * pageSize,
      contacts_included: false,
      rows: report.rows,
    },
  };
}

/** Paged full client-base profiles, including tags and custom fields. */
export async function listClientProfiles(
  client: AltegioClient,
  input: Omit<ClientProfilesQuery, 'page' | 'page_size'> & {
    page?: number;
    page_size?: number;
    include_contacts?: boolean;
    include_custom_fields?: boolean;
  }
): Promise<ClientsResult> {
  const {
    include_contacts: withContacts,
    include_custom_fields: includeCustomFields,
    ...query
  } = input;
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? 25;
  const result = await adapter(client).listClientProfiles({
    ...query,
    page,
    page_size: pageSize,
  });
  const includeContacts = withContacts === true;
  const rows = result.rows.map((row) => {
    const projected = includeContacts ? { ...row } : withoutContacts(row);
    if (includeCustomFields !== true) delete projected.custom_fields;
    return projected;
  });
  return {
    text: segmentSummary(
      {
        total_count: result.total_count,
        page,
        page_size: pageSize,
        rows: result.rows.map((row) => ({ id: row.id, name: row.name ?? '' })),
      },
      'id',
      ROWS_IN_SUMMARY
    ),
    structuredContent: {
      location_id: input.location_id,
      total_count: result.total_count,
      page,
      page_size: pageSize,
      returned: rows.length,
      has_more: result.total_count > page * pageSize,
      contacts_included: includeContacts,
      custom_fields_included: includeCustomFields === true,
      rows,
    },
  };
}

// ========== client card ==========

export async function getClientCard(
  client: AltegioClient,
  input: {
    location_id: number;
    client_id: number;
    include_contacts?: boolean;
  }
): Promise<ClientsResult> {
  const card = await adapter(client).getClientCard({
    location_id: input.location_id,
    client_id: input.client_id,
  });
  const includeContacts = input.include_contacts === true;
  return {
    text: cardSummary(card, { includeContacts }),
    structuredContent: {
      ...(includeContacts ? card : withoutContacts(card)),
      contacts_included: includeContacts,
    },
  };
}

// ========== visit history ==========

export interface VisitHistoryInput {
  location_id: number;
  client_id?: number;
  client_phone?: string;
  date_from?: string;
  date_to?: string;
  payment_statuses?: VisitPaymentStatus[];
  outcome?: AppointmentOutcome;
}

export async function getVisitHistory(
  client: AltegioClient,
  input: VisitHistoryInput
): Promise<ClientsResult> {
  if (!input.client_id && !input.client_phone) {
    throw new ClientsInputError(
      'Identify the client: pass client_id (from clients_search or clients_lookup) or client_phone.'
    );
  }

  const history = await adapter(client).getVisitHistory(input);
  return {
    text: visitHistorySummary(history),
    structuredContent: {
      location_id: input.location_id,
      ...(input.client_id ? { client_id: input.client_id } : {}),
      ...(input.client_phone ? { client_phone: input.client_phone } : {}),
      items: history.items,
      count: history.items.length,
      has_more: history.has_more,
      next_from: history.next_from,
      next_to: history.next_to,
    },
  };
}

// ========== fast lookup ==========

export async function lookupClients(
  client: AltegioClient,
  input: {
    location_id: number;
    query: string;
    limit?: number;
    include_contacts?: boolean;
  }
): Promise<ClientsResult> {
  if (!input.query.trim()) {
    throw new ClientsInputError(
      'Pass a non-empty query (a name, part of a phone number, or an email).'
    );
  }
  const rows = await adapter(client).lookupClients({
    location_id: input.location_id,
    query: input.query.trim(),
    ...(input.limit ? { limit: input.limit } : {}),
  });
  const includeContacts = input.include_contacts === true;
  const items = includeContacts
    ? rows
    : rows.map((row) => withoutContacts(row));
  return {
    text: lookupSummary(rows, { includeContacts }),
    structuredContent: {
      location_id: input.location_id,
      query: input.query.trim(),
      items,
      count: items.length,
      contacts_included: includeContacts,
    },
  };
}
