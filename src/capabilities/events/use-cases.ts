/**
 * Events use cases — everything the `events_*` tools actually do.
 *
 * A use case takes the tool's parsed input plus an `AltegioClient`, calls the
 * `EventsApi` port and returns the text summary next to the structured
 * content. Times cross the boundary here: tools take the location's local
 * wall-clock time (`YYYY-MM-DD` or `YYYY-MM-DDTHH:MM[:SS]`), the port takes
 * `YYYY-MM-DD HH:MM:SS`.
 *
 * Free text — team-member names, service titles, event comments and
 * instructions, client names, the API's own error strings for a failed booking
 * — is other people's text. It never goes into our own summary lines; it is
 * keyed back to them by id inside the untrusted block (`withUntrustedBlock`).
 * Client phones and emails leave this module only with `include_contacts`.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { EventsAdapter } from '../../api/v2/events-adapter.js';
import { knownLocationTimezone } from '../analytics/location-timezone.js';
import type {
  BookingChanges,
  BookingRequest,
  DuplicateContent,
  DuplicationStrategy,
  DuplicationStrategyFields,
  EventBooking,
  EventFields,
  EventPeriodQuery,
  EventsApi,
  EventSummary,
  RepeatMode,
} from '../../api/events-api.js';
import { EventsInputError } from './errors.js';
import {
  paginateCollection,
  pageMetadata,
  type PageInput,
} from '../../tools/pagination.js';
import {
  withUntrustedBlock,
  type UntrustedField,
} from '../../tools/tool-result.js';
import { CONTACTS_WITHHELD_NOTICE } from '../../tools/contacts.js';

export interface EventsResult {
  text: string;
  structuredContent: unknown;
  isError?: boolean;
}

function api(client: AltegioClient): EventsApi {
  return EventsAdapter.forClient(client);
}

// ========== time ==========

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_DATETIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** `YYYY-MM-DD` or a local datetime → `YYYY-MM-DD HH:MM:SS`. */
export function wireTime(
  value: string,
  field: string,
  endOfDay = false
): string {
  const text = value.trim();
  if (DATE.test(text)) return `${text} ${endOfDay ? '23:59:59' : '00:00:00'}`;
  const match = text.match(LOCAL_DATETIME);
  if (!match) {
    throw new EventsInputError(
      `${field} must be the location’s local time as YYYY-MM-DD or YYYY-MM-DDTHH:MM[:SS], without a time-zone offset (got "${text.slice(0, 40)}").`
    );
  }
  const [, date, hours, minutes, seconds] = match;
  return `${date} ${hours}:${minutes}:${seconds ?? '00'}`;
}

/** A local datetime (no bare date) → `YYYY-MM-DD HH:MM:SS`. */
function wireStart(value: string, field: string): string {
  if (DATE.test(value.trim())) {
    throw new EventsInputError(
      `${field} needs a time of day as well: YYYY-MM-DDTHH:MM in the location’s local time.`
    );
  }
  return wireTime(value, field);
}

function assertPeriod(from: string, to: string): void {
  if (to <= from) {
    throw new EventsInputError(
      'date_to must be after date_from. Give a date_to later than date_from.'
    );
  }
}

function minutesToSeconds(minutes: number, field: string): number {
  if (!Number.isInteger(minutes) || minutes % 5 !== 0) {
    throw new EventsInputError(
      `${field} must be a whole number of minutes in steps of 5 (got ${minutes}).`
    );
  }
  return minutes * 60;
}

// ========== shared input ==========

export interface PeriodInput {
  location_id: number;
  date_from: string;
  date_to: string;
  team_member_ids?: number[];
  service_ids?: number[];
  resource_ids?: number[];
  weekdays?: number[];
}

function periodQuery(input: PeriodInput): EventPeriodQuery {
  const from = wireTime(input.date_from, 'date_from');
  const to = wireTime(input.date_to, 'date_to', true);
  assertPeriod(from, to);
  return {
    location_id: input.location_id,
    from,
    to,
    ...(input.team_member_ids?.length
      ? { team_member_ids: input.team_member_ids }
      : {}),
    ...(input.service_ids?.length ? { service_ids: input.service_ids } : {}),
    ...(input.resource_ids?.length ? { resource_ids: input.resource_ids } : {}),
    ...(input.weekdays?.length ? { weekdays: input.weekdays } : {}),
  };
}

// ========== rendering ==========

function minutes(seconds: number | null): string {
  return seconds === null ? 'duration not reported' : `${seconds / 60} min`;
}

function eventLine(event: EventSummary): string {
  const seats =
    event.capacity === null
      ? 'capacity not reported'
      : `${event.booked_seats ?? '?'}/${event.capacity} seats booked`;
  return (
    `- Event ${event.id}: ${event.start ?? 'start not reported'} · ${minutes(event.duration_seconds)} · ${seats}` +
    ` · team member id ${event.team_member_id ?? 'not reported'} · service id ${event.service_id ?? 'not reported'}` +
    (event.resource_ids.length > 0
      ? ` · resource ids ${event.resource_ids.join(', ')}`
      : '') +
    (event.deleted ? ' · cancelled' : '')
  );
}

function eventUntrusted(event: EventSummary): UntrustedField[] {
  const key = `event ${event.id}`;
  return [
    { label: `${key} team member`, value: event.team_member_name },
    { label: `${key} service`, value: event.service_title },
    { label: `${key} resources`, value: event.resource_titles.join(', ') },
    { label: `${key} comment`, value: event.comment },
    { label: `${key} instructions`, value: event.instructions },
    { label: `${key} stream link`, value: event.stream_link },
  ];
}

function bookingProjection(booking: EventBooking, includeContacts: boolean) {
  const { client_phone, client_email, ...rest } = booking;
  return includeContacts ? { ...rest, client_phone, client_email } : rest;
}

// ========== events_list ==========

export interface ListEventsInput extends PeriodInput {
  min_free_seats?: number;
  order?: 'asc' | 'desc';
  include_deleted?: boolean;
  page: number;
  page_size: number;
}

export async function listEvents(
  client: AltegioClient,
  input: ListEventsInput
): Promise<EventsResult> {
  const query = periodQuery(input);
  const page = await api(client).listEvents({
    ...query,
    ...(input.min_free_seats !== undefined
      ? { min_free_seats: input.min_free_seats }
      : {}),
    ...(input.order ? { order: input.order } : {}),
    ...(input.include_deleted ? { include_deleted: true } : {}),
    page: input.page,
    page_size: input.page_size,
  });

  // The page is cut by the source before cancelled events are dropped, so
  // continuation follows what the source returned.
  const hasMore = page.source_returned >= input.page_size;
  const pagination = {
    ...pageMetadata(input, page.items.length),
    has_more: hasMore,
    next_page: hasMore ? input.page + 1 : null,
  };

  const lines = [
    `${page.items.length} event${page.items.length === 1 ? '' : 's'} in location ${input.location_id} between ${query.from} and ${query.to} (location time), page ${input.page}:`,
    ...page.items.map(eventLine),
  ];
  if (page.items.length === 0) lines.push('No events match.');
  if (hasMore)
    lines.push(`More events follow: request page ${input.page + 1}.`);

  return {
    text: withUntrustedBlock(
      lines.join('\n'),
      page.items.flatMap(eventUntrusted),
      { maxChars: 200 }
    ),
    structuredContent: {
      location_id: input.location_id,
      period: { from: query.from, to: query.to },
      items: page.items,
      pagination,
    },
  };
}

// ========== events_get ==========

export async function getEvent(
  client: AltegioClient,
  input: { location_id: number; event_id: number; include_contacts?: boolean }
): Promise<EventsResult> {
  const port = api(client);
  const [event, bookings] = await Promise.all([
    port.getEvent(input.location_id, input.event_id),
    port.listBookings(input.location_id, input.event_id),
  ]);
  const includeContacts = input.include_contacts === true;

  const lines = [
    eventLine(event).replace(/^- /, ''),
    `${bookings.items.length} booking${bookings.items.length === 1 ? '' : 's'}${bookings.has_more ? ' (more exist than shown)' : ''}:`,
    ...bookings.items.map(
      (b) =>
        `- Appointment ${b.appointment_id}: client id ${b.client_id ?? 'walk-in'} · ${b.seats ?? '?'} seat(s) · ${b.status}` +
        ` · total ${b.total ?? 'not reported'}${b.paid_in_full ? ' · paid' : ''}`
    ),
  ];
  if (!includeContacts && bookings.items.length > 0) {
    lines.push(CONTACTS_WITHHELD_NOTICE);
  }

  const untrusted: UntrustedField[] = [...eventUntrusted(event)];
  for (const b of bookings.items) {
    const key = `appointment ${b.appointment_id}`;
    untrusted.push({ label: `${key} client`, value: b.client_name });
    untrusted.push({ label: `${key} comment`, value: b.comment });
    if (includeContacts) {
      untrusted.push({ label: `${key} client phone`, value: b.client_phone });
      untrusted.push({ label: `${key} client email`, value: b.client_email });
    }
  }

  return {
    text: withUntrustedBlock(lines.join('\n'), untrusted, { maxChars: 200 }),
    structuredContent: {
      location_id: input.location_id,
      event,
      bookings: {
        items: bookings.items.map((b) => bookingProjection(b, includeContacts)),
        has_more: bookings.has_more,
      },
      contacts_included: includeContacts,
    },
  };
}

// ========== events_list_dates ==========

/** The longest period the calendar reads in one call. */
const MAX_CALENDAR_DAYS = 366;

/**
 * The location's wall-clock time a little ahead of now, as a wire time. The
 * lead covers the trip to the API and clock skew, and is rounded up to a whole
 * minute; a calendar of dates loses nothing to it.
 */
function localWireNow(timezone: string, now: number): string {
  const ahead = Math.ceil((now + 60_000) / 60_000) * 60_000;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ahead));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? '00';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

export async function getCalendar(
  client: AltegioClient,
  input: PeriodInput,
  now: number = Date.now()
): Promise<EventsResult> {
  const query = periodQuery(input);
  // The API reads this calendar from the location's "now" onward and refuses
  // an earlier start, so "from today" would fail after midnight. Start at now
  // instead; when the location's zone is unknown, send the period unchanged.
  const timezone = await knownLocationTimezone(client, input.location_id);
  const requestedFrom = query.from;
  if (timezone) {
    const localNow = localWireNow(timezone, now);
    if (query.from < localNow) {
      if (query.to <= localNow) {
        throw new EventsInputError(
          `The period ends before now (${localNow.slice(0, 16)} location time). This calendar reads from the current time onward; use events_list for earlier events.`
        );
      }
      query.from = localNow;
    }
  }
  const span =
    (Date.parse(query.to.slice(0, 10)) - Date.parse(query.from.slice(0, 10))) /
    86_400_000;
  if (span > MAX_CALENDAR_DAYS) {
    throw new EventsInputError(
      `The period covers ${Math.round(span)} days; read at most ${MAX_CALENDAR_DAYS} days at a time.`
    );
  }
  const calendar = await api(client).getCalendar(query);

  const idList = (values: { id: number }[]) =>
    values.length > 0 ? values.map((v) => v.id).join(', ') : 'none';
  const lines = [
    ...(query.from !== requestedFrom
      ? [
          `The calendar reads from now on, so the period starts at ${query.from} (location time) instead of ${requestedFrom}; events_list covers earlier events.`,
        ]
      : []),
    calendar.dates.length > 0
      ? `${calendar.dates.length} date(s) with events in location ${input.location_id} between ${query.from} and ${query.to}, first ${calendar.first_date}, last ${calendar.last_date}:`
      : `No events in location ${input.location_id} between ${query.from} and ${query.to}.`,
    ...(calendar.dates.length > 0 ? [calendar.dates.join(', ')] : []),
    `Team member ids running them: ${idList(calendar.team_members)}. Service ids: ${idList(calendar.services)}. Service category ids: ${idList(calendar.service_categories)}. Resource ids: ${idList(calendar.resources)}.`,
  ];
  const untrusted: UntrustedField[] = [
    ...calendar.team_members.map((v) => ({
      label: `team member ${v.id}`,
      value: v.name,
    })),
    ...calendar.services.map((v) => ({
      label: `service ${v.id}`,
      value: v.name,
    })),
    ...calendar.service_categories.map((v) => ({
      label: `service category ${v.id}`,
      value: v.name,
    })),
    ...calendar.resources.map((v) => ({
      label: `resource ${v.id}`,
      value: v.name,
    })),
  ];

  return {
    text: withUntrustedBlock(lines.join('\n'), untrusted, { maxChars: 120 }),
    structuredContent: {
      location_id: input.location_id,
      period: { from: query.from, to: query.to },
      ...calendar,
    },
  };
}

// ========== events_list_services ==========

export async function listEventServices(
  client: AltegioClient,
  input: {
    location_id: number;
    team_member_id?: number;
    query?: string;
  } & PageInput
): Promise<EventsResult> {
  const services = await api(client).listEventServices(input.location_id, {
    ...(input.team_member_id !== undefined
      ? { team_member_id: input.team_member_id }
      : {}),
    ...(input.query ? { query: input.query } : {}),
  });
  const { items, pagination } = paginateCollection(services, input);

  const lines = [
    `${pagination.total} service(s) can run as events in location ${input.location_id}; showing ${items.length}:`,
    ...items.map(
      (s) =>
        `- Service ${s.id}: up to ${s.capacity ?? '?'} seats · price ${s.price_min ?? '?'}–${s.price_max ?? '?'}` +
        ` · category id ${s.category_id ?? 'none'}` +
        ` · team member ids ${s.team_members.map((t) => t.id).join(', ') || 'any'}` +
        ` · resource ids ${s.resources.map((r) => r.id).join(', ') || 'none'}`
    ),
  ];
  if (pagination.has_more)
    lines.push(`More follow: request page ${pagination.next_page}.`);
  const untrusted = items.flatMap((s): UntrustedField[] => [
    { label: `service ${s.id} title`, value: s.title },
    { label: `service ${s.id} category`, value: s.category_title },
    {
      label: `service ${s.id} team members`,
      value: s.team_members.map((t) => `${t.id} ${t.name ?? ''}`).join(', '),
    },
    {
      label: `service ${s.id} resources`,
      value: s.resources.map((r) => `${r.id} ${r.title ?? ''}`).join(', '),
    },
  ]);

  return {
    text: withUntrustedBlock(lines.join('\n'), untrusted, { maxChars: 200 }),
    structuredContent: { location_id: input.location_id, items, pagination },
  };
}

// ========== events_create / events_update ==========

export interface EventFieldsInput {
  team_member_id?: number;
  service_id?: number;
  start?: string;
  duration_minutes?: number;
  capacity?: number;
  resource_ids?: number[];
  tag_ids?: number[];
  technical_break_minutes?: number | null;
  comment?: string | null;
  color?: string | null;
  instructions?: string | null;
  stream_link?: string | null;
  force?: boolean;
}

function fieldsFromInput(input: EventFieldsInput): Partial<EventFields> {
  return {
    ...(input.team_member_id !== undefined
      ? { team_member_id: input.team_member_id }
      : {}),
    ...(input.service_id !== undefined ? { service_id: input.service_id } : {}),
    ...(input.start !== undefined
      ? { start: wireStart(input.start, 'start') }
      : {}),
    ...(input.duration_minutes !== undefined
      ? {
          duration_seconds: minutesToSeconds(
            input.duration_minutes,
            'duration_minutes'
          ),
        }
      : {}),
    ...(input.capacity !== undefined ? { capacity: input.capacity } : {}),
    ...(input.resource_ids !== undefined
      ? { resource_ids: input.resource_ids }
      : {}),
    ...(input.tag_ids !== undefined ? { tag_ids: input.tag_ids } : {}),
    ...(input.technical_break_minutes !== undefined
      ? {
          technical_break_seconds:
            input.technical_break_minutes === null
              ? null
              : minutesToSeconds(
                  input.technical_break_minutes,
                  'technical_break_minutes'
                ),
        }
      : {}),
    ...(input.comment !== undefined ? { comment: input.comment } : {}),
    ...(input.color !== undefined
      ? { color: input.color?.toLowerCase() ?? null }
      : {}),
    ...(input.instructions !== undefined
      ? { instructions: input.instructions }
      : {}),
    ...(input.stream_link !== undefined
      ? { stream_link: input.stream_link }
      : {}),
    ...(input.force !== undefined ? { force: input.force } : {}),
  };
}

function savedEvent(verb: string, event: EventSummary): EventsResult {
  return {
    text: withUntrustedBlock(
      `${verb} ${eventLine(event).replace(/^- /, '')}`,
      eventUntrusted(event),
      { maxChars: 200 }
    ),
    structuredContent: event,
  };
}

export async function createEvent(
  client: AltegioClient,
  input: EventFieldsInput & {
    location_id: number;
    team_member_id: number;
    service_id: number;
    start: string;
    duration_minutes: number;
    capacity: number;
  }
): Promise<EventsResult> {
  const fields = fieldsFromInput(input) as EventFields;
  const event = await api(client).createEvent(input.location_id, {
    ...fields,
    resource_ids: fields.resource_ids ?? [],
    tag_ids: fields.tag_ids ?? [],
  });
  return savedEvent('Created', event);
}

export async function updateEvent(
  client: AltegioClient,
  input: EventFieldsInput & { location_id: number; event_id: number }
): Promise<EventsResult> {
  const { location_id, event_id, ...rest } = input;
  const changes = fieldsFromInput(rest);
  const changed = Object.keys(changes).filter((k) => k !== 'force');
  if (changed.length === 0) {
    throw new EventsInputError(
      'Nothing to update: pass at least one field of the event to change.'
    );
  }
  const event = await api(client).updateEvent(location_id, event_id, changes);
  return savedEvent('Updated', event);
}

export async function deleteEvent(
  client: AltegioClient,
  input: { location_id: number; event_id: number }
): Promise<EventsResult> {
  await api(client).deleteEvent(input.location_id, input.event_id);
  return {
    text: `Cancelled event ${input.event_id} in location ${input.location_id}; its bookings were cancelled with it.`,
    structuredContent: {
      location_id: input.location_id,
      event_id: input.event_id,
      deleted: true,
    },
  };
}

// ========== events_duplicate ==========

export async function duplicateEvent(
  client: AltegioClient,
  input: {
    location_id: number;
    event_id: number;
    starts: string[];
    copy_bookings?: boolean;
    force?: boolean;
  }
): Promise<EventsResult> {
  const starts = input.starts.map((s, i) =>
    wireStart(s, `starts[${i}]`).replace(' ', 'T')
  );
  const content: DuplicateContent = input.copy_bookings
    ? 'with_bookings'
    : 'event_only';
  const created = await api(client).duplicateEvent({
    location_id: input.location_id,
    event_id: input.event_id,
    starts,
    content,
    force: input.force === true,
  });
  return {
    text: [
      `Duplicated event ${input.event_id} into ${created.length} new event(s)${content === 'with_bookings' ? ' with its bookings' : ''}:`,
      ...created.map(eventLine),
    ].join('\n'),
    structuredContent: {
      location_id: input.location_id,
      source_event_id: input.event_id,
      copied_bookings: content === 'with_bookings',
      items: created,
    },
  };
}

// ========== duplication strategies ==========

function strategyLine(s: DuplicationStrategy): string {
  const days =
    s.repeat === 'weekly' && s.weekdays.length > 0
      ? ` on weekdays ${s.weekdays.join(', ')} (0 = Sunday)`
      : '';
  return (
    `- Pattern ${s.id}: repeats ${s.repeat ?? 'unknown'}${days}` +
    `${s.interval ? ` every ${s.interval}` : ''}` +
    ` · copies ${s.content === 'with_bookings' ? 'the event with its bookings' : 'the event only'}`
  );
}

export async function listDuplicationStrategies(
  client: AltegioClient,
  input: { location_id: number } & PageInput
): Promise<EventsResult> {
  const all = await api(client).listDuplicationStrategies(input.location_id);
  const { items, pagination } = paginateCollection(all, input);
  const lines = [
    `${pagination.total} saved duplication pattern(s) in location ${input.location_id}; showing ${items.length}:`,
    ...items.map(strategyLine),
  ];
  if (pagination.has_more)
    lines.push(`More follow: request page ${pagination.next_page}.`);
  return {
    text: withUntrustedBlock(
      lines.join('\n'),
      items.map((s) => ({ label: `pattern ${s.id} title`, value: s.title })),
      { maxChars: 80 }
    ),
    structuredContent: { location_id: input.location_id, items, pagination },
  };
}

export interface StrategyInput {
  title?: string;
  repeat?: RepeatMode;
  weekdays?: number[];
  interval?: number;
  copy_bookings?: boolean;
}

function strategyFields(
  input: StrategyInput
): Partial<DuplicationStrategyFields> {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.repeat !== undefined ? { repeat: input.repeat } : {}),
    ...(input.weekdays !== undefined ? { weekdays: input.weekdays } : {}),
    ...(input.interval !== undefined ? { interval: input.interval } : {}),
    ...(input.copy_bookings !== undefined
      ? { content: input.copy_bookings ? 'with_bookings' : 'event_only' }
      : {}),
  };
}

function assertWeekly(fields: Partial<DuplicationStrategyFields>): void {
  if (fields.repeat === 'weekly' && !fields.weekdays?.length) {
    throw new EventsInputError(
      'A weekly pattern needs weekdays: 0 = Sunday … 6 = Saturday.'
    );
  }
}

function savedStrategy(verb: string, s: DuplicationStrategy): EventsResult {
  return {
    text: withUntrustedBlock(
      `${verb} ${strategyLine(s).replace(/^- /, '')}`,
      [{ label: `pattern ${s.id} title`, value: s.title }],
      { maxChars: 80 }
    ),
    structuredContent: s,
  };
}

export async function createDuplicationStrategy(
  client: AltegioClient,
  input: StrategyInput & {
    location_id: number;
    title: string;
    repeat: RepeatMode;
  }
): Promise<EventsResult> {
  const fields = strategyFields(input) as DuplicationStrategyFields;
  assertWeekly(fields);
  return savedStrategy(
    'Saved',
    await api(client).createDuplicationStrategy(input.location_id, fields)
  );
}

export async function updateDuplicationStrategy(
  client: AltegioClient,
  input: StrategyInput & { location_id: number; strategy_id: number }
): Promise<EventsResult> {
  const { location_id, strategy_id, ...rest } = input;
  const fields = strategyFields(rest);
  if (Object.keys(fields).length === 0) {
    throw new EventsInputError(
      'Nothing to update: pass at least one field of the pattern to change.'
    );
  }
  assertWeekly(fields);
  return savedStrategy(
    'Updated',
    await api(client).updateDuplicationStrategy(
      location_id,
      strategy_id,
      fields
    )
  );
}

export async function deleteDuplicationStrategy(
  client: AltegioClient,
  input: { location_id: number; strategy_id: number }
): Promise<EventsResult> {
  await api(client).deleteDuplicationStrategy(
    input.location_id,
    input.strategy_id
  );
  return {
    text: `Deleted duplication pattern ${input.strategy_id} in location ${input.location_id}. Events already created with it are unchanged.`,
    structuredContent: {
      location_id: input.location_id,
      strategy_id: input.strategy_id,
      deleted: true,
    },
  };
}

// ========== bookings ==========

export async function bookClients(
  client: AltegioClient,
  input: {
    location_id: number;
    event_id: number;
    clients: BookingRequest[];
    send_sms?: boolean;
  }
): Promise<EventsResult> {
  input.clients.forEach((c, index) => {
    if (c.client_id === undefined && !c.name) {
      throw new EventsInputError(
        `clients[${index}] needs a client_id for an existing client or a name for a new one.`
      );
    }
  });
  const result = await api(client).bookClients(
    input.location_id,
    input.event_id,
    input.clients,
    { ...(input.send_sms !== undefined ? { send_sms: input.send_sms } : {}) }
  );

  const total = input.clients.length;
  const lines = [
    `Booked ${result.booked.length} of ${total} client(s) into event ${input.event_id}.`,
    ...result.booked.map(
      (b) =>
        `- Appointment ${b.appointment_id}${b.client_id ? ` · client id ${b.client_id}` : ''}`
    ),
  ];
  if (result.failed.length > 0) {
    lines.push(
      `${result.failed.length} could not be booked (positions in the request, 0-based): ${result.failed.map((f) => f.index).join(', ')}. The reasons are quoted below; fix those clients and book them again — the others are already booked.`
    );
  }

  return {
    text: withUntrustedBlock(
      lines.join('\n'),
      result.failed.map((f) => ({
        label: `clients[${f.index}] refused`,
        value: f.error,
      })),
      { maxChars: 200 }
    ),
    structuredContent: {
      location_id: input.location_id,
      event_id: input.event_id,
      requested: total,
      booked: result.booked,
      failed: result.failed,
      complete: result.failed.length === 0,
    },
    ...(result.failed.length > 0 ? { isError: true } : {}),
  };
}

function bookingResult(
  headline: string,
  input: { location_id: number; event_id: number },
  booking: EventBooking
): EventsResult {
  return {
    text: withUntrustedBlock(
      `${headline}: ${booking.seats ?? '?'} seat(s) · ${booking.status} · total ${booking.total ?? 'not reported'}.`,
      [
        {
          label: `appointment ${booking.appointment_id} comment`,
          value: booking.comment,
        },
      ],
      { maxChars: 200 }
    ),
    structuredContent: {
      location_id: input.location_id,
      event_id: input.event_id,
      booking: bookingProjection(booking, false),
    },
  };
}

export async function updateBooking(
  client: AltegioClient,
  input: BookingChanges & {
    location_id: number;
    event_id: number;
    appointment_id: number;
  }
): Promise<EventsResult> {
  const { location_id, event_id, appointment_id, ...changes } = input;
  if (Object.values(changes).every((v) => v === undefined)) {
    throw new EventsInputError(
      'Nothing to update: pass seats, comment, tag_ids, color, price, discount_percent or total.'
    );
  }
  const booking = await api(client).updateBooking(
    location_id,
    event_id,
    appointment_id,
    {
      ...changes,
      ...(changes.color ? { color: changes.color.toLowerCase() } : {}),
    }
  );
  return bookingResult(
    `Updated appointment ${appointment_id} in event ${event_id}`,
    input,
    booking
  );
}

export async function rescheduleBooking(
  client: AltegioClient,
  input: {
    location_id: number;
    event_id: number;
    appointment_id: number;
    target_event_id: number;
    seats?: number;
    comment?: string | null;
    keep_walk_in?: boolean;
  }
): Promise<EventsResult> {
  if (input.target_event_id === input.event_id) {
    throw new EventsInputError(
      'target_event_id is the event the appointment is already in. To change seats or the comment in place, use events_update_appointment.'
    );
  }
  const booking = await api(client).rescheduleBooking(input);
  return bookingResult(
    `Moved appointment ${input.appointment_id} from event ${input.event_id} to event ${input.target_event_id}`,
    { location_id: input.location_id, event_id: input.target_event_id },
    booking
  );
}
