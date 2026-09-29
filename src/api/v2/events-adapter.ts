/**
 * Adapter for the `EventsApi` port: V2 first, V1 only where V2 has no
 * operation (the product owner's rule of 2026-09-29).
 *
 * Every event read and write runs on `/api/v2/locations/{id}/events/**`, and an
 * event's bookings are read from the V2 appointment list filtered by event. The
 * one V1 call is the list of services that can run as events, which V2 does not
 * serve. The model never learns which is which: the port speaks the product
 * glossary, and the wire names — `activity`, `record`, `master` / `staff`,
 * `label`, `resource_instance`, `clients_count`, `reschedule_activity_id`,
 * `content_type`, `repeat_mode_id` — stop here.
 *
 * Contract details verified against the backend (biz.erp, 2026-09-29):
 *
 * - The event list, dates and filters refuse a period that starts before "now"
 *   in the location's time zone, unless `include_deleted` is set. The list
 *   therefore always asks for deleted events and drops them itself, so a past
 *   period reads as well as a future one.
 * - `PUT /events/{id}` replaces the event, so an update reads the event first
 *   and sends every field back with the changes applied.
 * - `PUT /events/{id}/appointments/{id}` rewrites the booking's price and
 *   replaces its tags and product items with what it is sent. An update reads
 *   the booking first, keeps its price and tags unless told otherwise, and
 *   refuses a booking with product sales rather than drop them.
 */
import { httpFromClient, type AltegioHttp } from '../altegio-http.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import {
  EventsInputError,
  EventsNotFoundError,
  mapEventsHttpError,
  type EventsErrorHints,
} from '../../capabilities/events/errors.js';
import { visitStatusFromLegacyCode } from '../../capabilities/analytics/vocabulary.js';
import {
  IncludedIndex,
  callJsonApi,
  primaryList,
  primaryOne,
  relationshipRefs,
  type JsonApiDocument,
  type JsonApiMethod,
  type JsonApiResource,
  type QueryValue,
} from './jsonapi-http.js';
import type {
  BookingChanges,
  BookingRequest,
  BookingResult,
  DuplicateContent,
  DuplicateEventInput,
  DuplicationStrategy,
  DuplicationStrategyFields,
  EventBooking,
  EventBookings,
  EventCalendar,
  EventFields,
  EventFilterValue,
  EventListQuery,
  EventPage,
  EventPeriodQuery,
  EventService,
  EventSummary,
  EventsApi,
  RepeatMode,
  RescheduleInput,
} from '../events-api.js';

// ========== wire vocabulary ==========

const CONTENT_TO_WIRE: Record<DuplicateContent, number> = {
  event_only: 1,
  with_bookings: 2,
};
const CONTENT_FROM_WIRE: Record<number, DuplicateContent> = {
  1: 'event_only',
  2: 'with_bookings',
};

const REPEAT_TO_WIRE: Record<RepeatMode, number> = {
  daily: 1,
  working_days: 2,
  mon_wed_fri: 3,
  tue_thu: 4,
  weekly: 5,
  monthly: 6,
  yearly: 7,
};
const REPEAT_FROM_WIRE: Record<number, RepeatMode> = Object.fromEntries(
  Object.entries(REPEAT_TO_WIRE).map(([mode, code]) => [code, mode])
) as Record<number, RepeatMode>;

const EVENT_INCLUDES = [
  'staff',
  'service',
  'resource_instances',
  'labels',
  'duration_details',
];
const BOOKING_INCLUDES = [
  'client',
  'labels',
  'attendance_service_items',
  'attendance_good_items',
];

/** Largest page the V2 collections serve. */
const MAX_V2_PAGE = 250;

// ========== coercions ==========

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number') return String(value);
  return null;
}

function asFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  const n = asNumber(value);
  return n === null ? null : n !== 0;
}

function ids(refs: Array<{ id: string }>): number[] {
  return refs
    .map((ref) => asNumber(ref.id))
    .filter((id): id is number => id !== null);
}

/** `2027-01-15T09:00:00+0200` → `2027-01-15T09:00:00+02:00`; a bare local time stays bare. */
function rfc3339(value: unknown): string | null {
  const text = asText(value);
  if (!text) return null;
  const match = text.match(
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/
  );
  if (!match) return text;
  const [, date, time, offset] = match;
  if (!offset) return `${date}T${time}`;
  if (offset === 'Z') return `${date}T${time}Z`;
  const normalized = offset.includes(':')
    ? offset
    : `${offset.slice(0, 3)}:${offset.slice(3)}`;
  return `${date}T${time}${normalized}`;
}

/** Local wall-clock time as the wire wants it: `YYYY-MM-DD HH:MM:SS`. */
function wireLocalTime(value: string | null): string | null {
  const match = value?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}` : null;
}

// ========== projections ==========

function eventFromWire(
  resource: JsonApiResource,
  included: IncludedIndex
): EventSummary {
  const a = resource.attributes ?? {};
  const staffRef = relationshipRefs(resource, 'staff')[0];
  const serviceRef = relationshipRefs(resource, 'service')[0];
  const resourceRefs = relationshipRefs(resource, 'resource_instances');
  const durationRef = relationshipRefs(resource, 'duration_details')[0];
  const staff = staffRef ? included.get(staffRef.type, staffRef.id) : undefined;
  const service = serviceRef
    ? included.get(serviceRef.type, serviceRef.id)
    : undefined;
  const duration = durationRef
    ? included.get(durationRef.type, durationRef.id)
    : undefined;

  const capacity = asNumber(a.capacity);
  // The list names it `clients_count`; the duplicate response `records_count`.
  const booked = asNumber(a.clients_count ?? a.records_count);
  const start = rfc3339(a.date);

  return {
    id: asNumber(resource.id) ?? 0,
    start,
    date: start?.slice(0, 10) ?? null,
    duration_seconds: asNumber(a.length),
    technical_break_seconds: asNumber(
      duration?.attributes?.technical_break_duration
    ),
    capacity,
    booked_seats: booked,
    free_seats:
      capacity !== null && booked !== null
        ? Math.max(capacity - booked, 0)
        : null,
    team_member_id: asNumber(a.staff_id ?? a.master_id),
    team_member_name: asText(staff?.attributes?.name),
    service_id: asNumber(a.service_id),
    service_title: asText(service?.attributes?.title),
    resource_ids: ids(resourceRefs),
    resource_titles: resourceRefs
      .map((ref) => asText(included.get(ref.type, ref.id)?.attributes?.title))
      .filter((title): title is string => title !== null),
    tag_ids: ids(relationshipRefs(resource, 'labels')),
    comment: asText(a.comment),
    instructions: asText(a.instructions),
    stream_link: asText(a.stream_link),
    color: asText(a.color),
    schedule_id: asNumber(a.schedule_id),
    deleted: asFlag(a.deleted) === true,
  };
}

interface BookingWire {
  booking: EventBooking;
  eventId: number | null;
  tagIds: number[];
  serviceItem: {
    cost_per_unit: number;
    discount_percent: number;
    manual_cost: number;
    is_trial?: boolean;
  } | null;
}

function bookingFromWire(
  resource: JsonApiResource,
  included: IncludedIndex
): BookingWire {
  const a = resource.attributes ?? {};
  const clientRef = relationshipRefs(resource, 'client')[0];
  const client = clientRef
    ? included.get(clientRef.type, clientRef.id)?.attributes
    : undefined;
  const serviceRef = relationshipRefs(resource, 'attendance_service_items')[0];
  const serviceItem = serviceRef
    ? included.get(serviceRef.type, serviceRef.id)?.attributes
    : undefined;
  const productItems = relationshipRefs(resource, 'attendance_good_items');

  const code = asNumber(a.attendance ?? a.attendance_status);
  const status =
    asFlag(a.deleted) === true
      ? 'cancelled'
      : code !== null
        ? (visitStatusFromLegacyCode(code) ?? 'unknown')
        : 'unknown';
  const clientName = client
    ? [asText(client.name), asText(client.surname)].filter(Boolean).join(' ')
    : null;

  const price = asNumber(serviceItem?.cost_per_unit);
  const discount = asNumber(serviceItem?.discount_percent);
  const total = asNumber(serviceItem?.manual_cost);

  return {
    booking: {
      appointment_id: asNumber(resource.id) ?? 0,
      client_id: asNumber(a.client_id) || null,
      client_name: clientName || asText(a.client_fictive_name),
      client_phone: asText(client?.phone) ?? asText(a.client_fictive_phone),
      client_email: asText(client?.email) ?? asText(a.client_fictive_email),
      seats: asNumber(a.clients_count),
      status,
      paid_in_full: asFlag(a.paid_full),
      comment: asText(a.comment),
      price,
      discount_percent: discount,
      total,
      product_item_count: productItems.length,
    },
    eventId: asNumber(a.activity_id),
    tagIds: ids(relationshipRefs(resource, 'labels')),
    serviceItem:
      price !== null && discount !== null && total !== null
        ? {
            cost_per_unit: price,
            discount_percent: discount,
            manual_cost: total,
            ...(typeof serviceItem?.is_trial === 'boolean'
              ? { is_trial: serviceItem.is_trial }
              : {}),
          }
        : null,
  };
}

function strategyFromWire(resource: JsonApiResource): DuplicationStrategy {
  const a = resource.attributes ?? {};
  const mode = asNumber(a.repeat_mode_id);
  const content = asNumber(a.content_type);
  return {
    id: asNumber(resource.id) ?? asNumber(a.id) ?? 0,
    title: asText(a.title),
    repeat: mode !== null ? (REPEAT_FROM_WIRE[mode] ?? null) : null,
    weekdays: Array.isArray(a.days)
      ? a.days.map(asNumber).filter((d): d is number => d !== null)
      : [],
    interval: asNumber(a.interval),
    content: content !== null ? (CONTENT_FROM_WIRE[content] ?? null) : null,
  };
}

function filterValue(resource: JsonApiResource): EventFilterValue | null {
  const id = asNumber(resource.id);
  if (id === null) return null;
  const a = resource.attributes ?? {};
  return { id, name: asText(a.name) ?? asText(a.title) };
}

/** Round money to the cent the API stores. */
function cents(value: number): number {
  return Math.round(value * 100) / 100;
}

// ========== the adapter ==========

export class EventsAdapter implements EventsApi {
  constructor(private readonly http: AltegioHttp) {}

  static forClient(client: AltegioClient): EventsAdapter {
    return new EventsAdapter(httpFromClient(client));
  }

  private call(
    path: string,
    context: string,
    options: {
      method?: JsonApiMethod;
      query?: Record<string, QueryValue>;
      body?: unknown;
      hints?: EventsErrorHints;
    } = {}
  ): Promise<JsonApiDocument | null> {
    return callJsonApi(this.http, path, {
      context,
      ...(options.method ? { method: options.method } : {}),
      ...(options.query ? { query: options.query } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      mapError: (status, body, ctx) =>
        mapEventsHttpError(status, body, ctx, options.hints),
    });
  }

  private periodQuery(query: EventPeriodQuery): Record<string, QueryValue> {
    return {
      'filter[from]': query.from,
      'filter[to]': query.to,
      'filter[master_ids][]': query.team_member_ids,
      'filter[service_ids][]': query.service_ids,
      'filter[resource_ids][]': query.resource_ids,
      'filter[weekdays][]': query.weekdays,
      'filter[capacity]': query.min_free_seats,
    };
  }

  async listEvents(query: EventListQuery): Promise<EventPage> {
    const doc = await this.call(
      `/locations/${query.location_id}/events`,
      'list the events',
      {
        query: {
          ...this.periodQuery(query),
          // Without it the API refuses any period that starts in the past.
          'filter[include_deleted]': 1,
          'filter[sort]': query.order,
          page: query.page,
          limit: Math.min(query.page_size, MAX_V2_PAGE),
          'include[]': ['staff', 'service', 'resource_instances', 'labels'],
        },
        hints: {
          invalid:
            'Give the period as date_from/date_to with the end after the start, and check the filter ids.',
        },
      }
    );
    const included = new IncludedIndex(doc?.included ?? []);
    const all = primaryList(doc).map((r) => eventFromWire(r, included));
    return {
      items: query.include_deleted ? all : all.filter((e) => !e.deleted),
      source_returned: all.length,
    };
  }

  async getEvent(locationId: number, eventId: number): Promise<EventSummary> {
    const doc = await this.call(
      `/locations/${locationId}/events/${eventId}`,
      `read event ${eventId}`,
      { query: { 'include[]': EVENT_INCLUDES } }
    );
    const resource = primaryOne(doc);
    if (!resource) {
      throw new EventsNotFoundError(
        `Event ${eventId} was not found in location ${locationId}. Find the id with events_list.`
      );
    }
    return eventFromWire(resource, new IncludedIndex(doc?.included ?? []));
  }

  private async readBookings(
    locationId: number,
    eventId: number
  ): Promise<{ wires: BookingWire[]; has_more: boolean }> {
    const doc = await this.call(
      `/locations/${locationId}/appointments`,
      `read the bookings of event ${eventId}`,
      {
        query: {
          'filter[activity_id]': eventId,
          limit: MAX_V2_PAGE,
          'include[]': BOOKING_INCLUDES,
        },
      }
    );
    const included = new IncludedIndex(doc?.included ?? []);
    const resources = primaryList(doc);
    return {
      wires: resources.map((r) => bookingFromWire(r, included)),
      has_more: resources.length >= MAX_V2_PAGE,
    };
  }

  async listBookings(
    locationId: number,
    eventId: number
  ): Promise<EventBookings> {
    const { wires, has_more } = await this.readBookings(locationId, eventId);
    return { items: wires.map((w) => w.booking), has_more };
  }

  async getCalendar(query: EventPeriodQuery): Promise<EventCalendar> {
    const hints: EventsErrorHints = {
      invalid:
        'This calendar reads from the current time in the location’s time zone onward; start the period now or later, or use events_list for earlier events.',
    };
    const path = `/locations/${query.location_id}/events`;
    const [datesDoc, filtersDoc] = await Promise.all([
      this.call(`${path}/dates`, 'read the event dates', {
        query: this.periodQuery(query),
        hints,
      }),
      this.call(`${path}/filters`, 'read the event filters', {
        query: this.periodQuery(query),
        hints,
      }),
    ]);

    const dates = primaryList(datesDoc)
      .map((r) => asText(r.attributes?.date) ?? r.id)
      .filter((d): d is string => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();

    const included = new IncludedIndex(filtersDoc?.included ?? []);
    const values = (code: string): EventFilterValue[] => {
      const criterion = primaryList(filtersDoc).find((r) => r.id === code);
      if (!criterion) return [];
      return relationshipRefs(criterion, 'data')
        .map(
          (ref) =>
            filterValue(
              included.get(ref.type, ref.id) ?? { type: ref.type, id: ref.id }
            ) ?? null
        )
        .filter((v): v is EventFilterValue => v !== null);
    };

    return {
      dates,
      first_date: dates[0] ?? null,
      last_date: dates[dates.length - 1] ?? null,
      team_members: values('staff'),
      services: values('service'),
      service_categories: values('service_category'),
      resources: values('resource'),
    };
  }

  /** V1 fallback: V2 has no list of the services an event can run. */
  async listEventServices(
    locationId: number,
    filter: { team_member_id?: number; query?: string }
  ): Promise<EventService[]> {
    const search = new URLSearchParams();
    if (filter.team_member_id !== undefined) {
      search.set('staff_id', String(filter.team_member_id));
    }
    if (filter.query) search.set('term', filter.query);
    const context = 'list the services that can run as events';
    if (!this.http.isAuthenticated()) {
      throw mapEventsHttpError(401, undefined, context);
    }
    const qs = search.toString();
    const response = await this.http.request(
      `/locations/${locationId}/events/services${qs ? `?${qs}` : ''}`,
      { method: 'GET' }
    );
    const body = (await response.json().catch(() => undefined)) as
      { success?: boolean; data?: unknown } | undefined;
    if (!response.ok || body?.success === false) {
      throw mapEventsHttpError(
        response.ok ? 422 : response.status,
        body,
        context
      );
    }
    const rows = Array.isArray(body?.data) ? body.data : [];
    return rows
      .filter(
        (row): row is Record<string, unknown> =>
          !!row && typeof row === 'object'
      )
      .map((row) => {
        const category =
          row.category && typeof row.category === 'object'
            ? (row.category as Record<string, unknown>)
            : {};
        const list = (value: unknown) =>
          Array.isArray(value)
            ? value.filter(
                (v): v is Record<string, unknown> =>
                  !!v && typeof v === 'object'
              )
            : [];
        return {
          id: asNumber(row.id) ?? 0,
          title: asText(row.title),
          capacity: asNumber(row.capacity),
          price_min: asNumber(row.price_min),
          price_max: asNumber(row.price_max),
          category_id: asNumber(category.id),
          category_title: asText(category.title),
          team_members: list(row.staff).map((s) => ({
            id: asNumber(s.id) ?? 0,
            name: asText(s.name),
            duration_seconds: asNumber(s.length),
          })),
          resources: list(row.resources).map((r) => ({
            id: asNumber(r.id) ?? 0,
            title: asText(r.title),
          })),
        };
      });
  }

  private eventBody(fields: EventFields): Record<string, unknown> {
    return {
      staff_id: fields.team_member_id,
      service_id: fields.service_id,
      resource_instance_ids: fields.resource_ids,
      label_ids: fields.tag_ids,
      date: fields.start,
      length: fields.duration_seconds,
      capacity: fields.capacity,
      ...(fields.technical_break_seconds !== undefined
        ? { technical_break_duration: fields.technical_break_seconds }
        : {}),
      ...(fields.comment !== undefined ? { comment: fields.comment } : {}),
      ...(fields.color !== undefined ? { color: fields.color } : {}),
      ...(fields.instructions !== undefined
        ? { instructions: fields.instructions }
        : {}),
      ...(fields.stream_link !== undefined
        ? { stream_link: fields.stream_link }
        : {}),
      ...(fields.force !== undefined ? { force: fields.force } : {}),
    };
  }

  async createEvent(
    locationId: number,
    fields: EventFields
  ): Promise<EventSummary> {
    const doc = await this.call(
      `/locations/${locationId}/events`,
      'create the event',
      {
        method: 'POST',
        query: { 'include[]': EVENT_INCLUDES },
        body: this.eventBody(fields),
        hints: {
          invalid:
            'Check the start (location time), a duration that is a multiple of 5 minutes and at most 24 hours, a capacity of at least 1, and ids from events_list_services.',
          notFound:
            'Check the team member and service ids with events_list_services.',
        },
      }
    );
    const resource = primaryOne(doc);
    if (!resource) {
      throw mapEventsHttpError(502, undefined, 'create the event');
    }
    return eventFromWire(resource, new IncludedIndex(doc?.included ?? []));
  }

  async updateEvent(
    locationId: number,
    eventId: number,
    changes: Partial<EventFields>
  ): Promise<EventSummary> {
    const current = await this.getEvent(locationId, eventId);
    const start = changes.start ?? wireLocalTime(current.start);
    if (
      current.team_member_id === null ||
      current.service_id === null ||
      start === null ||
      current.duration_seconds === null ||
      current.capacity === null
    ) {
      throw new EventsInputError(
        `Event ${eventId} could not be read completely, so it cannot be updated safely. Retry, or pass every field of the event.`
      );
    }
    const fields: EventFields = {
      team_member_id: current.team_member_id,
      service_id: current.service_id,
      start,
      duration_seconds: current.duration_seconds,
      capacity: current.capacity,
      resource_ids: current.resource_ids,
      tag_ids: current.tag_ids,
      technical_break_seconds: current.technical_break_seconds,
      comment: current.comment,
      color: current.color,
      instructions: current.instructions,
      stream_link: current.stream_link,
      ...Object.fromEntries(
        Object.entries(changes).filter(([, value]) => value !== undefined)
      ),
    };
    const doc = await this.call(
      `/locations/${locationId}/events/${eventId}`,
      `update event ${eventId}`,
      {
        method: 'PUT',
        query: { 'include[]': EVENT_INCLUDES },
        body: this.eventBody(fields),
        hints: {
          invalid:
            'Check the start (location time), a duration that is a multiple of 5 minutes and at most 24 hours, and a capacity of at least the seats already booked.',
        },
      }
    );
    const resource = primaryOne(doc);
    return resource
      ? eventFromWire(resource, new IncludedIndex(doc?.included ?? []))
      : this.getEvent(locationId, eventId);
  }

  async deleteEvent(locationId: number, eventId: number): Promise<void> {
    await this.call(
      `/locations/${locationId}/events/${eventId}`,
      `delete event ${eventId}`,
      { method: 'DELETE' }
    );
  }

  async duplicateEvent(input: DuplicateEventInput): Promise<EventSummary[]> {
    const doc = await this.call(
      `/locations/${input.location_id}/events/${input.event_id}/duplicate`,
      `duplicate event ${input.event_id}`,
      {
        method: 'POST',
        body: {
          dates: input.starts,
          content_type: CONTENT_TO_WIRE[input.content],
          force: input.force,
        },
        hints: {
          invalid:
            'Give 1 to 100 start times as YYYY-MM-DDTHH:MM:SS in the location time; one invalid time refuses the whole request.',
        },
      }
    );
    const included = new IncludedIndex(doc?.included ?? []);
    return primaryList(doc).map((r) => eventFromWire(r, included));
  }

  async listDuplicationStrategies(
    locationId: number
  ): Promise<DuplicationStrategy[]> {
    const doc = await this.call(
      `/locations/${locationId}/events/duplication_strategies`,
      'list the event duplication patterns'
    );
    return primaryList(doc).map(strategyFromWire);
  }

  private strategyBody(
    fields: Partial<DuplicationStrategyFields>
  ): Record<string, unknown> {
    return {
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.repeat !== undefined
        ? { repeat_mode_id: REPEAT_TO_WIRE[fields.repeat] }
        : {}),
      ...(fields.weekdays !== undefined ? { days: fields.weekdays } : {}),
      ...(fields.interval !== undefined ? { interval: fields.interval } : {}),
      ...(fields.content !== undefined
        ? { content_type: CONTENT_TO_WIRE[fields.content] }
        : {}),
    };
  }

  async createDuplicationStrategy(
    locationId: number,
    fields: DuplicationStrategyFields
  ): Promise<DuplicationStrategy> {
    const doc = await this.call(
      `/locations/${locationId}/events/duplication_strategies`,
      'save the event duplication pattern',
      {
        method: 'POST',
        body: this.strategyBody(fields),
        hints: {
          invalid:
            'Give a title of at most 50 characters and a repeat mode; a weekly pattern needs at least one weekday.',
        },
      }
    );
    const resource = primaryOne(doc);
    if (!resource) {
      throw mapEventsHttpError(
        502,
        undefined,
        'save the event duplication pattern'
      );
    }
    return strategyFromWire(resource);
  }

  async updateDuplicationStrategy(
    locationId: number,
    strategyId: number,
    fields: Partial<DuplicationStrategyFields>
  ): Promise<DuplicationStrategy> {
    const current = (await this.listDuplicationStrategies(locationId)).find(
      (s) => s.id === strategyId
    );
    if (!current) {
      throw new EventsNotFoundError(
        `Duplication pattern ${strategyId} was not found in location ${locationId}. List the patterns with events_list_duplication_strategies.`
      );
    }
    // The update validates the pattern as a whole, so send it whole.
    const merged: DuplicationStrategyFields = {
      title: fields.title ?? current.title ?? '',
      repeat: fields.repeat ?? current.repeat ?? 'daily',
      weekdays: fields.weekdays ?? current.weekdays,
      interval: fields.interval ?? current.interval ?? 0,
      ...((fields.content ?? current.content)
        ? { content: fields.content ?? current.content ?? 'event_only' }
        : {}),
    };
    const doc = await this.call(
      `/locations/${locationId}/events/duplication_strategies/${strategyId}`,
      `update duplication pattern ${strategyId}`,
      {
        method: 'PUT',
        body: this.strategyBody(merged),
        hints: {
          invalid:
            'Give a title of at most 50 characters; a weekly pattern needs at least one weekday.',
          notFound:
            'List the patterns with events_list_duplication_strategies.',
        },
      }
    );
    const resource = primaryOne(doc);
    return resource
      ? strategyFromWire(resource)
      : { ...current, ...merged, id: strategyId };
  }

  async deleteDuplicationStrategy(
    locationId: number,
    strategyId: number
  ): Promise<void> {
    await this.call(
      `/locations/${locationId}/events/duplication_strategies/${strategyId}`,
      `delete duplication pattern ${strategyId}`,
      {
        method: 'DELETE',
        hints: {
          notFound:
            'List the patterns with events_list_duplication_strategies.',
        },
      }
    );
  }

  async bookClients(
    locationId: number,
    eventId: number,
    clients: BookingRequest[],
    options: { send_sms?: boolean }
  ): Promise<BookingResult> {
    const doc = await this.call(
      `/locations/${locationId}/events/${eventId}/appointments/bulk`,
      `book clients into event ${eventId}`,
      {
        method: 'POST',
        body: {
          records: clients.map((c) => ({
            ...(c.client_id !== undefined ? { client_id: c.client_id } : {}),
            ...(c.name !== undefined ? { name: c.name } : {}),
            ...(c.phone !== undefined ? { phone: c.phone } : {}),
            ...(c.email !== undefined ? { email: c.email } : {}),
            clients_count: c.seats ?? 1,
            ...(options.send_sms !== undefined
              ? { send_sms_now: options.send_sms ? 1 : 0 }
              : {}),
          })),
        },
        hints: {
          invalid: 'Give 1 to 50 clients, each with a client_id or a name.',
        },
      }
    );
    const booked = primaryList(doc).map((r) => ({
      appointment_id: asNumber(r.id) ?? 0,
      client_id: asNumber(r.attributes?.client_id) || null,
    }));
    const errors = Array.isArray(doc?.meta.errors) ? doc.meta.errors : [];
    const failed = errors
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
      .map((e) => ({
        index: asNumber(e.index) ?? -1,
        error: asText(e.error),
      }));
    return { booked, failed };
  }

  async updateBooking(
    locationId: number,
    eventId: number,
    appointmentId: number,
    changes: BookingChanges
  ): Promise<EventBooking> {
    const { wires } = await this.readBookings(locationId, eventId);
    const current = wires.find(
      (w) => w.booking.appointment_id === appointmentId
    );
    if (!current) {
      throw new EventsNotFoundError(
        `Appointment ${appointmentId} is not booked into event ${eventId}. Read the bookings with events_get.`
      );
    }
    if (current.booking.product_item_count > 0) {
      throw new EventsInputError(
        `Appointment ${appointmentId} has product sales attached, and this update would drop them. Change it in the Altegio visit window instead.`
      );
    }

    const seats = changes.seats ?? current.booking.seats ?? 1;
    const price = changes.price ?? current.serviceItem?.cost_per_unit;
    const discount =
      changes.discount_percent ?? current.serviceItem?.discount_percent ?? 0;
    if (price === undefined) {
      throw new EventsInputError(
        `The price of appointment ${appointmentId} could not be read. Pass price (one seat, before discount) to update it.`
      );
    }
    // The API stores the booking total next to the unit price; keep it
    // consistent when the seats, price or discount change.
    const repriced =
      changes.seats !== undefined ||
      changes.price !== undefined ||
      changes.discount_percent !== undefined;
    const total =
      changes.total ??
      (repriced || !current.serviceItem
        ? cents(price * seats * (1 - discount / 100))
        : current.serviceItem.manual_cost);

    const doc = await this.call(
      `/locations/${locationId}/events/${eventId}/appointments/${appointmentId}`,
      `update appointment ${appointmentId}`,
      {
        method: 'PUT',
        query: { 'include[]': BOOKING_INCLUDES },
        body: {
          attendance_service_item: {
            cost_per_unit: price,
            discount_percent: discount,
            manual_cost: total,
            ...(current.serviceItem?.is_trial !== undefined
              ? { is_trial: current.serviceItem.is_trial }
              : {}),
          },
          label_ids: changes.tag_ids ?? current.tagIds,
          clients_count: seats,
          ...(changes.comment !== undefined
            ? { comment: changes.comment }
            : {}),
          ...(changes.color !== undefined
            ? { color: changes.color?.replace(/^#/, '') ?? null }
            : {}),
        },
        hints: {
          invalid:
            'Check the seats against the free seats of the event and the location limit per booking, and a discount between 0 and 100.',
        },
      }
    );
    const resource = primaryOne(doc);
    return resource
      ? bookingFromWire(resource, new IncludedIndex(doc?.included ?? []))
          .booking
      : { ...current.booking, seats, price, discount_percent: discount, total };
  }

  async rescheduleBooking(input: RescheduleInput): Promise<EventBooking> {
    const doc = await this.call(
      `/locations/${input.location_id}/events/${input.event_id}/appointments/${input.appointment_id}`,
      `move appointment ${input.appointment_id} to event ${input.target_event_id}`,
      {
        method: 'PATCH',
        query: { 'include[]': ['client'] },
        body: {
          reschedule_activity_id: input.target_event_id,
          ...(input.seats !== undefined ? { clients_count: input.seats } : {}),
          ...(input.comment !== undefined ? { comment: input.comment } : {}),
          ...(input.keep_walk_in !== undefined
            ? { with_comer: input.keep_walk_in }
            : {}),
        },
        hints: {
          invalid:
            'Only an unpaid booking in the waiting status can move, out of an event that has not finished, into a future event with enough free seats that the client is not already booked into.',
          notFound:
            'Check both event ids with events_list and the appointment id with events_get.',
        },
      }
    );
    const resource = primaryOne(doc);
    if (!resource) {
      throw mapEventsHttpError(
        502,
        undefined,
        `move appointment ${input.appointment_id}`
      );
    }
    return bookingFromWire(resource, new IncludedIndex(doc?.included ?? []))
      .booking;
  }
}
