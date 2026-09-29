/**
 * `EventsApi` — the port the events capability layer talks to (ADR-001 D5).
 *
 * An event is a group session many clients book into: a class, a workshop, a
 * group training. Method names and DTOs use the canonical product vocabulary
 * (location, event, team member, service, resource, tag, client, appointment);
 * the wire names (`activity`, `record`, `master`, `staff`, `salon`, `label`,
 * `resource_instance`, `clients_count`) stop inside the adapter in
 * `./v2/events-adapter.ts`.
 *
 * Times are the location's wall-clock time. Inputs are `YYYY-MM-DD HH:MM:SS`
 * without an offset; outputs are RFC 3339 with the location's offset.
 * Money is in major units, as the API reports it.
 */

/** A period plus the filters every event read accepts. */
export interface EventPeriodQuery {
  location_id: number;
  /** Period start, location time, `YYYY-MM-DD HH:MM:SS`. */
  from: string;
  /** Period end, location time, `YYYY-MM-DD HH:MM:SS`. */
  to: string;
  team_member_ids?: number[];
  service_ids?: number[];
  resource_ids?: number[];
  /** ISO weekdays, 1 = Monday … 7 = Sunday. */
  weekdays?: number[];
  /** Only events with at least this many free seats. */
  min_free_seats?: number;
}

export interface EventListQuery extends EventPeriodQuery {
  page: number;
  page_size: number;
  order?: 'asc' | 'desc';
  /** Keep cancelled (deleted) events in the result. */
  include_deleted?: boolean;
}

export interface EventSummary {
  id: number;
  /** Start, RFC 3339 with the location's offset. */
  start: string | null;
  /** Local calendar date of the start. */
  date: string | null;
  duration_seconds: number | null;
  /** Part of the duration kept free after the session, when reported. */
  technical_break_seconds: number | null;
  capacity: number | null;
  booked_seats: number | null;
  free_seats: number | null;
  team_member_id: number | null;
  team_member_name: string | null;
  service_id: number | null;
  service_title: string | null;
  resource_ids: number[];
  resource_titles: string[];
  tag_ids: number[];
  comment: string | null;
  instructions: string | null;
  stream_link: string | null;
  color: string | null;
  /** Id of the recurring schedule the event belongs to, if any. */
  schedule_id: number | null;
  deleted: boolean;
}

export interface EventPage {
  items: EventSummary[];
  /** Events the source returned for the page, before `include_deleted` filtering. */
  source_returned: number;
}

/** One client booked into an event. */
export interface EventBooking {
  appointment_id: number;
  client_id: number | null;
  client_name: string | null;
  client_phone: string | null;
  client_email: string | null;
  seats: number | null;
  /** waiting, confirmed, arrived or no_show. */
  status: string;
  paid_in_full: boolean | null;
  comment: string | null;
  /** Price of one seat before discount. */
  price: number | null;
  discount_percent: number | null;
  /** Total due for the booking after discount. */
  total: number | null;
  /** Product sales attached to the booking. */
  product_item_count: number;
}

export interface EventBookings {
  items: EventBooking[];
  has_more: boolean;
}

/** A value the location can filter its events by, with its display name. */
export interface EventFilterValue {
  id: number;
  name: string | null;
}

export interface EventCalendar {
  dates: string[];
  first_date: string | null;
  last_date: string | null;
  team_members: EventFilterValue[];
  services: EventFilterValue[];
  service_categories: EventFilterValue[];
  resources: EventFilterValue[];
}

/** A service that can run as an event, with who and what it can use. */
export interface EventService {
  id: number;
  title: string | null;
  capacity: number | null;
  price_min: number | null;
  price_max: number | null;
  category_id: number | null;
  category_title: string | null;
  team_members: Array<{
    id: number;
    name: string | null;
    duration_seconds: number | null;
  }>;
  resources: Array<{ id: number; title: string | null }>;
}

/** Every field of an event the API stores; `update` sends the whole set. */
export interface EventFields {
  team_member_id: number;
  service_id: number;
  /** Local time, `YYYY-MM-DD HH:MM:SS`. */
  start: string;
  duration_seconds: number;
  capacity: number;
  resource_ids: number[];
  tag_ids: number[];
  /** `null` uses the location setting. */
  technical_break_seconds?: number | null;
  comment?: string | null;
  /** `#rrggbb`. */
  color?: string | null;
  instructions?: string | null;
  stream_link?: string | null;
  /** Keep the event even when the team member or a resource is busy. */
  force?: boolean;
}

/** What a duplicate carries over from the original. */
export type DuplicateContent = 'event_only' | 'with_bookings';

export interface DuplicateEventInput {
  location_id: number;
  event_id: number;
  /** Local start times, `YYYY-MM-DDTHH:MM:SS`. */
  starts: string[];
  content: DuplicateContent;
  force: boolean;
}

/** How a saved duplication pattern repeats. */
export type RepeatMode =
  | 'daily'
  | 'working_days'
  | 'mon_wed_fri'
  | 'tue_thu'
  | 'weekly'
  | 'monthly'
  | 'yearly';

export interface DuplicationStrategy {
  id: number;
  title: string | null;
  repeat: RepeatMode | null;
  /** 0 = Sunday … 6 = Saturday, for `weekly`. */
  weekdays: number[];
  /** Repeat every N units of `repeat`; 0 means every one. */
  interval: number | null;
  content: DuplicateContent | null;
}

export interface DuplicationStrategyFields {
  title: string;
  repeat: RepeatMode;
  weekdays?: number[];
  interval?: number;
  content?: DuplicateContent;
}

/** One client to book. `client_id` books an existing client. */
export interface BookingRequest {
  client_id?: number;
  name?: string;
  phone?: string;
  email?: string;
  seats?: number;
}

export interface BookingResult {
  booked: Array<{ appointment_id: number; client_id: number | null }>;
  failed: Array<{ index: number; error: string | null }>;
}

export interface BookingChanges {
  seats?: number;
  comment?: string | null;
  tag_ids?: number[];
  /** `#rrggbb`. */
  color?: string | null;
  price?: number;
  discount_percent?: number;
  total?: number;
}

export interface RescheduleInput {
  location_id: number;
  event_id: number;
  appointment_id: number;
  target_event_id: number;
  seats?: number;
  comment?: string | null;
  keep_walk_in?: boolean;
}

export interface EventsApi {
  listEvents(query: EventListQuery): Promise<EventPage>;
  getEvent(locationId: number, eventId: number): Promise<EventSummary>;
  listBookings(locationId: number, eventId: number): Promise<EventBookings>;
  getCalendar(query: EventPeriodQuery): Promise<EventCalendar>;
  listEventServices(
    locationId: number,
    filter: { team_member_id?: number; query?: string }
  ): Promise<EventService[]>;
  createEvent(locationId: number, fields: EventFields): Promise<EventSummary>;
  updateEvent(
    locationId: number,
    eventId: number,
    changes: Partial<EventFields>
  ): Promise<EventSummary>;
  deleteEvent(locationId: number, eventId: number): Promise<void>;
  duplicateEvent(input: DuplicateEventInput): Promise<EventSummary[]>;
  listDuplicationStrategies(locationId: number): Promise<DuplicationStrategy[]>;
  createDuplicationStrategy(
    locationId: number,
    fields: DuplicationStrategyFields
  ): Promise<DuplicationStrategy>;
  updateDuplicationStrategy(
    locationId: number,
    strategyId: number,
    fields: Partial<DuplicationStrategyFields>
  ): Promise<DuplicationStrategy>;
  deleteDuplicationStrategy(
    locationId: number,
    strategyId: number
  ): Promise<void>;
  bookClients(
    locationId: number,
    eventId: number,
    clients: BookingRequest[],
    options: { send_sms?: boolean }
  ): Promise<BookingResult>;
  updateBooking(
    locationId: number,
    eventId: number,
    appointmentId: number,
    changes: BookingChanges
  ): Promise<EventBooking>;
  rescheduleBooking(input: RescheduleInput): Promise<EventBooking>;
}
