/**
 * Clients use cases — everything the `clients_*` tools actually do.
 *
 * A use case takes the tool's parsed input plus an `AltegioClient`, calls the
 * `ClientsApi` port through the v1 adapter, and returns the text summary next to
 * the structured content. The segmentation filter model is canonical here and
 * only becomes the v1 wire dialect inside the adapter.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { httpFromClient } from '../../api/altegio-http.js';
import { V1ClientsAdapter } from '../../api/v1/clients-adapter.js';
import type {
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

function adapter(client: AltegioClient): V1ClientsAdapter {
  return new V1ClientsAdapter(httpFromClient(client));
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
    ...(input.fields?.length ? { fields: input.fields } : {}),
  });

  return {
    text: segmentSummary(segment, input.order_by, ROWS_IN_SUMMARY),
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
      returned: segment.rows.length,
      rows: segment.rows,
    },
  };
}

// ========== client card ==========

export async function getClientCard(
  client: AltegioClient,
  input: { location_id: number; client_id: number }
): Promise<ClientsResult> {
  const card = await adapter(client).getClientCard(input);
  return { text: cardSummary(card), structuredContent: card };
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
  input: { location_id: number; query: string; limit?: number }
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
  return {
    text: lookupSummary(rows),
    structuredContent: {
      location_id: input.location_id,
      query: input.query.trim(),
      items: rows,
      count: rows.length,
    },
  };
}
