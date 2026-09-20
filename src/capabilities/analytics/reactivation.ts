/** Universal client-reactivation analysis over the canonical client base. */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { httpFromClient } from '../../api/altegio-http.js';
import { V1ClientsAdapter } from '../../api/v1/clients-adapter.js';
import type {
  ClientReactivationCandidate,
  ReactivationClientFilters,
} from '../../api/clients-api.js';
import { CONTACTS_WITHHELD_NOTICE } from '../../tools/contacts.js';
import {
  sanitizeUntrusted,
  UNTRUSTED_NOTE,
  withUntrustedBlock,
} from '../../tools/tool-result.js';
import { AnalyticsInputError } from './errors.js';
import { resolveLocationTimezone } from './location-timezone.js';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

export interface ClientReactivationInput {
  location_id: number;
  last_visit_on_or_before: string;
  minimum_historical_visits?: number;
  minimum_total_spent?: number;
  filters?: ReactivationClientFilters;
  page?: number;
  page_size?: number;
  include_contacts?: boolean;
}

function parseDay(value: string): number {
  if (!DATE_PATTERN.test(value)) {
    throw new AnalyticsInputError(
      `last_visit_on_or_before must be a date in YYYY-MM-DD format, got "${value}".`
    );
  }
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  if (
    Number.isNaN(milliseconds) ||
    new Date(milliseconds).toISOString().slice(0, 10) !== value
  ) {
    throw new AnalyticsInputError(
      `last_visit_on_or_before is not a valid calendar date: "${value}".`
    );
  }
  return milliseconds;
}

/** The day immediately after an inclusive local-date threshold. */
export function dayAfter(value: string): string {
  return new Date(parseDay(value) + DAY_MS).toISOString().slice(0, 10);
}

function safeCandidate(
  candidate: ClientReactivationCandidate
): ClientReactivationCandidate {
  return {
    ...candidate,
    client_name: sanitizeUntrusted(candidate.client_name, { maxChars: 160 }),
    ...(candidate.phone !== undefined
      ? { phone: sanitizeUntrusted(candidate.phone, { maxChars: 80 }) }
      : {}),
    ...(candidate.email !== undefined
      ? { email: sanitizeUntrusted(candidate.email, { maxChars: 160 }) }
      : {}),
  };
}

export async function getClientReactivationCandidates(
  client: AltegioClient,
  input: ClientReactivationInput
) {
  const timezone = await resolveLocationTimezone(client, input.location_id);
  const inactiveFrom = dayAfter(input.last_visit_on_or_before);
  const minimumHistoricalVisits = input.minimum_historical_visits ?? 1;
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? DEFAULT_PAGE_SIZE;
  const includeContacts = input.include_contacts === true;

  const segment = await new V1ClientsAdapter(
    httpFromClient(client)
  ).searchReactivationCandidates({
    location_id: input.location_id,
    last_visit_on_or_before: input.last_visit_on_or_before,
    inactive_from: inactiveFrom,
    minimum_historical_visits: minimumHistoricalVisits,
    ...(input.minimum_total_spent !== undefined
      ? { minimum_total_spent: input.minimum_total_spent }
      : {}),
    filters: input.filters ?? {},
    page: Math.max(1, page),
    page_size: Math.max(1, Math.min(pageSize, MAX_PAGE_SIZE)),
    include_contacts: includeContacts,
  });
  const candidates = segment.candidates.map(safeCandidate);
  const returned = candidates.length;
  const hasMore = segment.page * segment.page_size < segment.total_count;
  const summary = [
    `${segment.total_count} client reactivation candidate(s); showing ${returned} on page ${segment.page}.`,
    `Each candidate has at least ${minimumHistoricalVisits} arrived visit(s) on or before ${input.last_visit_on_or_before} and no arrived visit from ${inactiveFrom} onward; dates are location calendar days in ${timezone}.`,
    `Results are ordered by client_id ascending for stable pagination.${hasMore ? ` Request page ${segment.page + 1} to continue.` : ''}`,
    ...(includeContacts ? [] : [CONTACTS_WITHHELD_NOTICE]),
  ].join('\n');

  return {
    text: withUntrustedBlock(
      summary,
      candidates.flatMap((candidate) => [
        {
          label: `client ${candidate.client_id} name`,
          value: candidate.client_name,
        },
        ...(includeContacts
          ? [
              {
                label: `client ${candidate.client_id} phone`,
                value: candidate.phone,
              },
              {
                label: `client ${candidate.client_id} email`,
                value: candidate.email,
              },
            ]
          : []),
      ])
    ),
    structuredContent: {
      location_id: input.location_id,
      inactivity: {
        last_visit_on_or_before: input.last_visit_on_or_before,
        inactive_from: inactiveFrom,
        timezone,
        boundary: 'inclusive_local_calendar_day',
        qualifying_outcome: 'arrived',
      },
      qualification: {
        minimum_historical_visits: minimumHistoricalVisits,
        ...(input.minimum_total_spent !== undefined
          ? { minimum_total_spent: input.minimum_total_spent }
          : {}),
      },
      filters_applied: input.filters ?? {},
      order: { field: 'client_id', direction: 'asc' },
      total_count: segment.total_count,
      page: segment.page,
      page_size: segment.page_size,
      returned,
      has_more: hasMore,
      next_page: hasMore ? segment.page + 1 : null,
      contacts_included: includeContacts,
      candidates,
      untrusted_data_note: UNTRUSTED_NOTE,
    },
  };
}
