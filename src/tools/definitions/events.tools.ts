/**
 * `[Events]` tool pack — group events of one location: classes, workshops,
 * group trainings and other sessions many clients book into.
 *
 * The timetable of events, one event with its bookings, the calendar of event
 * dates, the services that can run as events, event create / update / cancel,
 * duplication to other dates and saved duplication patterns, booking clients
 * and changing or moving a booking.
 *
 * Names, parameters and results use the product glossary; the wire vocabulary
 * (`activity`, `record`, `master`, `label`, `resource_instance`) stops in
 * `src/api/v2/events-adapter.ts`, which also decides which API version serves
 * each call.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { includeContactsArg } from '../contacts.js';
import { pageArg, pageSizeArg, paginationOutput } from '../pagination.js';
import * as events from '../../capabilities/events/use-cases.js';
import { EventsAdapter } from '../../api/v2/events-adapter.js';

// ========== shared input pieces ==========

const locationId = z
  .number()
  .int()
  .positive()
  .describe(
    'Location whose events to work with. Call locations_list when the id is unknown.'
  );

const eventId = z
  .number()
  .int()
  .positive()
  .describe('Event id, from events_list.');

const ids = (what: string) =>
  z.array(z.number().int().positive()).min(1).optional().describe(what);

const periodBound = (which: 'from' | 'to') =>
  z
    .string()
    .min(10)
    .describe(
      which === 'from'
        ? 'Start of the period in the location’s local time: YYYY-MM-DD (from 00:00) or YYYY-MM-DDTHH:MM.'
        : 'End of the period in the location’s local time: YYYY-MM-DD (through 23:59:59) or YYYY-MM-DDTHH:MM.'
    );

const periodFilters = {
  location_id: locationId,
  date_from: periodBound('from'),
  date_to: periodBound('to'),
  team_member_ids: ids('Only events run by these team members.'),
  service_ids: ids('Only events of these services.'),
  resource_ids: ids('Only events that use these resources.'),
  weekdays: z
    .array(z.number().int().min(1).max(7))
    .min(1)
    .max(7)
    .optional()
    .describe('Only events on these weekdays: 1 = Monday … 7 = Sunday.'),
};

const localStart = z
  .string()
  .min(16)
  .describe(
    'Start in the location’s local time, YYYY-MM-DDTHH:MM, without a time-zone offset.'
  );

const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Use #rrggbb')
  .describe('Color as #rrggbb.');

const optionalText = (max: number, what: string) =>
  z.string().min(1).max(max).describe(what);

const force = z
  .boolean()
  .optional()
  .describe(
    'Keep the event even when the team member or a resource is already busy at that time. Default false: an overlap is refused.'
  );

const eventFieldInputs = {
  resource_ids: z
    .array(z.number().int().positive())
    .optional()
    .describe('Resources the event occupies (rooms, equipment).'),
  tag_ids: z
    .array(z.number().int().positive())
    .optional()
    .describe('Tags to put on the event.'),
  technical_break_minutes: z
    .number()
    .int()
    .min(0)
    .max(60)
    .nullable()
    .optional()
    .describe(
      'Break kept free after the session, in minutes (steps of 5, at most 60), counted inside duration_minutes. null uses the location setting.'
    ),
  comment: optionalText(255, 'Internal comment on the event.').optional(),
  color: color.optional(),
  instructions: optionalText(
    500,
    'Instructions shown to the clients who book.'
  ).optional(),
  stream_link: z
    .string()
    .min(1)
    .optional()
    .describe('Link to the online stream, for an online event.'),
  force,
};

const repeatArg = z
  .enum([
    'daily',
    'working_days',
    'mon_wed_fri',
    'tue_thu',
    'weekly',
    'monthly',
    'yearly',
  ])
  .describe(
    'How the pattern repeats: daily, working_days, mon_wed_fri, tue_thu, weekly (on the given weekdays), monthly (same day of the month) or yearly.'
  );

const strategyWeekdays = z
  .array(z.number().int().min(0).max(6))
  .min(1)
  .max(7)
  .optional()
  .describe('For weekly: the weekdays, 0 = Sunday … 6 = Saturday.');

const strategyInterval = z
  .number()
  .int()
  .min(0)
  .optional()
  .describe(
    'Repeat every N days, weeks, months or years (by the repeat mode); 0 or 1 means every one.'
  );

const copyBookings = z
  .boolean()
  .optional()
  .describe(
    'Copy the clients booked into the event as well. Default false: only the event is copied.'
  );

// ========== output schema pieces ==========

const int = { type: ['integer', 'null'] as const };
const num = { type: ['number', 'null'] as const };
const str = { type: ['string', 'null'] as const };
const intList = { type: 'array' as const, items: { type: 'integer' as const } };

const eventSchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'integer' as const },
    start: str,
    date: str,
    duration_seconds: int,
    technical_break_seconds: int,
    capacity: int,
    booked_seats: int,
    free_seats: int,
    team_member_id: int,
    team_member_name: str,
    service_id: int,
    service_title: str,
    resource_ids: intList,
    resource_titles: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    tag_ids: intList,
    comment: str,
    instructions: str,
    stream_link: str,
    color: str,
    schedule_id: int,
    deleted: { type: 'boolean' as const },
  },
  required: ['id', 'start', 'capacity', 'booked_seats', 'deleted'],
};

const bookingSchema = {
  type: 'object' as const,
  properties: {
    appointment_id: { type: 'integer' as const },
    client_id: int,
    client_name: str,
    client_phone: str,
    client_email: str,
    seats: int,
    status: { type: 'string' as const },
    paid_in_full: { type: ['boolean', 'null'] as const },
    comment: str,
    price: num,
    discount_percent: num,
    total: num,
    product_item_count: { type: 'integer' as const },
  },
  required: ['appointment_id', 'status'],
};

const strategySchema = {
  type: 'object' as const,
  properties: {
    id: { type: 'integer' as const },
    title: str,
    repeat: str,
    weekdays: intList,
    interval: int,
    content: str,
  },
  required: ['id', 'repeat'],
};

const filterValues = {
  type: 'array' as const,
  items: {
    type: 'object' as const,
    properties: { id: { type: 'integer' as const }, name: str },
    required: ['id'],
  },
};

const periodSchema = {
  type: 'object' as const,
  properties: {
    from: { type: 'string' as const },
    to: { type: 'string' as const },
  },
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

// ========== reads ==========

export const eventsListTool = defineTool({
  name: 'events_list',
  category: 'Events',
  description:
    'List the group events of a location in a period — classes, workshops, group trainings and other sessions many clients book into — with start, duration, team member, service, resources, capacity, booked and free seats. Past and future periods both work. Filter by team member, service, resource, weekday and minimum free seats ("which yoga classes still have 3 seats next week"). Cancelled events are left out unless include_deleted is true. Paged: 25 per page by default; follow pagination.next_page until it is null. For who is booked into one event use events_get; for which days have events use events_list_dates.',
  annotations: { title: 'Events: list events in a period', ...READ_ONLY },
  input: z.object({
    ...periodFilters,
    min_free_seats: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Only events with at least this many free seats.'),
    order: z
      .enum(['asc', 'desc'])
      .optional()
      .describe('Order by start time. Default asc.'),
    include_deleted: z
      .boolean()
      .optional()
      .describe('Keep cancelled events in the list. Default false.'),
    page: pageArg,
    page_size: pageSizeArg(100),
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      period: periodSchema,
      items: { type: 'array' as const, items: eventSchema },
      pagination: paginationOutput,
    },
    required: ['items', 'pagination'],
  },
  handler: async ({ input, client }) => events.listEvents(client, input),
});

export const eventsGetTool = defineTool({
  name: 'events_get',
  category: 'Events',
  description:
    'One group event with everything about it: start, duration and break, team member, service, resources, tags, capacity, booked and free seats, comment and client instructions — plus every client booked into it with appointment id, seats, status (waiting, confirmed, arrived, no_show), total and paid flag. Use it for "who is coming to Saturday’s class" and before changing or moving a booking. Client phones and emails are withheld unless include_contacts is true. A cancelled event stays readable here.',
  annotations: { title: 'Events: get an event and its bookings', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    event_id: eventId,
    include_contacts: includeContactsArg,
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      event: eventSchema,
      bookings: {
        type: 'object' as const,
        properties: {
          items: { type: 'array' as const, items: bookingSchema },
          has_more: { type: 'boolean' as const },
        },
        required: ['items', 'has_more'],
      },
      contacts_included: { type: 'boolean' as const },
    },
    required: ['event', 'bookings'],
  },
  handler: async ({ input, client }) => events.getEvent(client, input),
});

export const eventsListDatesTool = defineTool({
  name: 'events_list_dates',
  category: 'Events',
  description:
    'The event calendar of a location for an upcoming period: which dates have group events, the first and last of them, and which team members, services, service categories and resources those events use — with ids and names to pass as filters to events_list. Use it to answer "when is the next workshop" or to fill a date picker. The period must start now or later in the location’s time zone and cover at most 366 days; for past events use events_list.',
  annotations: { title: 'Events: dates with events', ...READ_ONLY },
  input: z.object(periodFilters),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      period: periodSchema,
      dates: { type: 'array' as const, items: { type: 'string' as const } },
      first_date: str,
      last_date: str,
      team_members: filterValues,
      services: filterValues,
      service_categories: filterValues,
      resources: filterValues,
    },
    required: ['dates', 'first_date', 'last_date'],
  },
  handler: async ({ input, client }) => events.getCalendar(client, input),
});

export const eventsListServicesTool = defineTool({
  name: 'events_list_services',
  category: 'Events',
  description:
    'The services of a location that can run as group events, each with its seat capacity, price range, category, the team members who can run it (with the session length each one takes) and the resources it can use. Use it before events_create to pick the service, team member, duration and resources. Filter by team member or by a part of the service title.',
  annotations: {
    title: 'Events: services that can run as events',
    ...READ_ONLY,
  },
  input: z.object({
    location_id: locationId,
    team_member_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Only services this team member can run.'),
    query: z.string().min(1).optional().describe('Part of the service title.'),
    page: pageArg,
    page_size: pageSizeArg(100),
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      items: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            id: { type: 'integer' as const },
            title: str,
            capacity: int,
            price_min: num,
            price_max: num,
            category_id: int,
            category_title: str,
            team_members: { type: 'array' as const },
            resources: { type: 'array' as const },
          },
          required: ['id'],
        },
      },
      pagination: paginationOutput,
    },
    required: ['items', 'pagination'],
  },
  handler: async ({ input, client }) => events.listEventServices(client, input),
});

export const eventsListDuplicationStrategiesTool = defineTool({
  name: 'events_list_duplication_strategies',
  category: 'Events',
  description:
    'The saved duplication patterns of a location — how an event repeats (daily, working days, Mon/Wed/Fri, Tue/Thu, weekly on chosen weekdays, monthly, yearly), every how many units, and whether copies carry the bookings. They are presets the Altegio app offers when copying an event; to copy one here, work out the dates and call events_duplicate.',
  annotations: { title: 'Events: list duplication patterns', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    page: pageArg,
    page_size: pageSizeArg(100),
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      items: { type: 'array' as const, items: strategySchema },
      pagination: paginationOutput,
    },
    required: ['items', 'pagination'],
  },
  handler: async ({ input, client }) =>
    events.listDuplicationStrategies(client, input),
});

// ========== event writes ==========

export const eventsCreateTool = defineTool({
  name: 'events_create',
  category: 'Events',
  description:
    'Create a group event — a class, workshop or group training clients can book into. Required: team member, service, start (location time), duration in minutes (steps of 5, at most 24 hours, break included) and capacity (seats). Optional: resources, tags, break, comment, color, client instructions and a stream link. Find the service, the team members who can run it and its resources with events_list_services. An overlap with the team member’s or a resource’s other bookings is refused unless force is true. Then book clients with events_book_clients or copy the event to more dates with events_duplicate.',
  annotations: {
    title: 'Events: create an event',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    team_member_id: z
      .number()
      .int()
      .positive()
      .describe('Team member who runs the event.'),
    service_id: z
      .number()
      .int()
      .positive()
      .describe('Service the event provides, from events_list_services.'),
    start: localStart,
    duration_minutes: z
      .number()
      .int()
      .min(5)
      .max(1440)
      .describe('Length in minutes, steps of 5, including the break.'),
    capacity: z
      .number()
      .int()
      .positive()
      .describe('Number of seats clients can book.'),
    ...eventFieldInputs,
  }),
  outputSchema: eventSchema,
  handler: async ({ input, client }) => events.createEvent(client, input),
});

export const eventsUpdateTool = defineTool({
  name: 'events_update',
  category: 'Events',
  description:
    'Change a group event: move it to another start, change the team member, service, duration, capacity, resources, tags, break, comment, color, client instructions or stream link. Pass only what changes; everything else is kept. The clients already booked stay booked. An overlap with the team member’s or a resource’s other bookings is refused unless force is true. To move one client to another event use events_reschedule_appointment.',
  annotations: {
    title: 'Events: update an event',
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    event_id: eventId,
    team_member_id: z.number().int().positive().optional(),
    service_id: z.number().int().positive().optional(),
    start: localStart.optional(),
    duration_minutes: z.number().int().min(5).max(1440).optional(),
    capacity: z.number().int().positive().optional(),
    ...eventFieldInputs,
    comment: optionalText(255, 'Internal comment; null clears it.')
      .nullable()
      .optional(),
    color: color.nullable().optional(),
    instructions: optionalText(500, 'Client instructions; null clears them.')
      .nullable()
      .optional(),
    stream_link: z.string().min(1).nullable().optional(),
  }),
  outputSchema: eventSchema,
  handler: async ({ input, client }) => events.updateEvent(client, input),
});

async function describeEvent(
  input: { location_id: number; event_id: number },
  client: Parameters<typeof EventsAdapter.forClient>[0]
): Promise<string | undefined> {
  const event = await EventsAdapter.forClient(client).getEvent(
    input.location_id,
    input.event_id
  );
  return [
    `event ${event.id}`,
    event.service_title ? `"${event.service_title}"` : null,
    event.start ? `on ${event.start}` : null,
    event.team_member_name ? `with ${event.team_member_name}` : null,
    event.capacity !== null
      ? `(${event.booked_seats ?? 0} of ${event.capacity} seats booked)`
      : null,
    `at location ${input.location_id}`,
  ]
    .filter(Boolean)
    .join(' ');
}

export const eventsDeleteTool = defineTool({
  name: 'events_delete',
  category: 'Events',
  description:
    'Cancel a group event. Every booking in it is cancelled too, and the team member’s time and the resources are released. Asks for confirmation first. To take one client out instead, move their booking with events_reschedule_appointment.',
  annotations: {
    title: 'Events: cancel an event',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({ location_id: locationId, event_id: eventId }),
  confirm: {
    action: 'Cancel event',
    target: (input) =>
      `event ${input.event_id} at location ${input.location_id}`,
    resolve: describeEvent,
    consequence:
      'The event leaves the timetable and every client booked into it loses the booking; the team member’s time and the resources become free again. The Altegio notification settings decide whether the booked clients are told. A cancelled event stays readable by id but cannot be restored from here.',
  },
  handler: async ({ input, client }) => events.deleteEvent(client, input),
});

export const eventsDuplicateTool = defineTool({
  name: 'events_duplicate',
  category: 'Events',
  description:
    'Copy a group event to other start times — "repeat this class every Monday in March". Give up to 100 start times in the location’s local time; one invalid time refuses the whole request. Each copy keeps the team member, service, duration, capacity, resources and tags; copy_bookings also copies the booked clients. An overlap with the team member’s or a resource’s other bookings is refused unless force is true. Returns the new events.',
  annotations: {
    title: 'Events: duplicate an event to dates',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    event_id: eventId,
    starts: z
      .array(localStart)
      .min(1)
      .max(100)
      .describe(
        'Start times of the copies, YYYY-MM-DDTHH:MM in the location’s local time.'
      ),
    copy_bookings: copyBookings,
    force,
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      source_event_id: { type: 'integer' as const },
      copied_bookings: { type: 'boolean' as const },
      items: { type: 'array' as const, items: eventSchema },
    },
    required: ['items'],
  },
  handler: async ({ input, client }) => events.duplicateEvent(client, input),
});

// ========== duplication patterns ==========

export const eventsCreateDuplicationStrategyTool = defineTool({
  name: 'events_create_duplication_strategy',
  category: 'Events',
  description:
    'Save a duplication pattern for events — a named repeat rule (daily, working days, Mon/Wed/Fri, Tue/Thu, weekly on chosen weekdays, monthly, yearly; every N units) that the Altegio app offers when copying an event. Saving a pattern copies nothing; use events_duplicate for that.',
  annotations: {
    title: 'Events: save a duplication pattern',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    title: z.string().min(1).max(50).describe('Name of the pattern.'),
    repeat: repeatArg,
    weekdays: strategyWeekdays,
    interval: strategyInterval,
    copy_bookings: copyBookings,
  }),
  outputSchema: strategySchema,
  handler: async ({ input, client }) =>
    events.createDuplicationStrategy(client, input),
});

export const eventsUpdateDuplicationStrategyTool = defineTool({
  name: 'events_update_duplication_strategy',
  category: 'Events',
  description:
    'Change a saved event duplication pattern: its name, repeat mode, weekdays, interval or whether copies carry the bookings. Pass only what changes. Find the id with events_list_duplication_strategies.',
  annotations: {
    title: 'Events: update a duplication pattern',
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    strategy_id: z
      .number()
      .int()
      .positive()
      .describe('Pattern id, from events_list_duplication_strategies.'),
    title: z.string().min(1).max(50).optional(),
    repeat: repeatArg.optional(),
    weekdays: strategyWeekdays,
    interval: strategyInterval,
    copy_bookings: copyBookings,
  }),
  outputSchema: strategySchema,
  handler: async ({ input, client }) =>
    events.updateDuplicationStrategy(client, input),
});

export const eventsDeleteDuplicationStrategyTool = defineTool({
  name: 'events_delete_duplication_strategy',
  category: 'Events',
  description:
    'Delete a saved event duplication pattern. Events already created with it are not touched. Asks for confirmation first.',
  annotations: {
    title: 'Events: delete a duplication pattern',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    strategy_id: z
      .number()
      .int()
      .positive()
      .describe('Pattern id, from events_list_duplication_strategies.'),
  }),
  confirm: {
    action: 'Delete event duplication pattern',
    target: (input) =>
      `duplication pattern ${input.strategy_id} at location ${input.location_id}`,
    resolve: async (input, client) => {
      const strategy = (
        await EventsAdapter.forClient(client).listDuplicationStrategies(
          input.location_id
        )
      ).find((s) => s.id === input.strategy_id);
      if (!strategy) return undefined;
      return `duplication pattern ${strategy.id}${strategy.title ? ` "${strategy.title}"` : ''} (${strategy.repeat ?? 'unknown repeat'}) at location ${input.location_id}`;
    },
    consequence:
      'The pattern disappears from the choices the Altegio app offers when copying an event. Events already created with it stay as they are.',
  },
  handler: async ({ input, client }) =>
    events.deleteDuplicationStrategy(client, input),
});

// ========== bookings ==========

export const eventsBookClientsTool = defineTool({
  name: 'events_book_clients',
  category: 'Events',
  description:
    'Book one client or up to 50 clients into a group event in one call. Give an existing client by client_id (find it with clients_lookup), or a new one by name and phone (and email). seats reserves several places for one client (default 1). Each client is booked independently: when some fail — no free seats, already booked, a bad id — the rest are still booked and the result lists which positions failed and why. Set send_sms to send the booking confirmation SMS.',
  annotations: {
    title: 'Events: book clients into an event',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    event_id: eventId,
    clients: z
      .array(
        z.object({
          client_id: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Existing client id.'),
          name: z
            .string()
            .min(1)
            .optional()
            .describe('Name of a new client (ignored with client_id).'),
          phone: z
            .string()
            .min(1)
            .optional()
            .describe('Phone of a new client, digits with country code.'),
          email: z
            .string()
            .email()
            .optional()
            .describe('Email of a new client.'),
          seats: z
            .number()
            .int()
            .positive()
            .optional()
            .describe('Seats this client takes. Default 1.'),
        })
      )
      .min(1)
      .max(50)
      .describe('The clients to book, 1 to 50.'),
    send_sms: z
      .boolean()
      .optional()
      .describe('Send each booked client the confirmation SMS now.'),
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      event_id: { type: 'integer' as const },
      requested: { type: 'integer' as const },
      booked: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            appointment_id: { type: 'integer' as const },
            client_id: int,
          },
          required: ['appointment_id'],
        },
      },
      failed: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: { index: { type: 'integer' as const }, error: str },
          required: ['index'],
        },
      },
      complete: { type: 'boolean' as const },
    },
    required: ['booked', 'failed', 'complete'],
  },
  handler: async ({ input, client }) => events.bookClients(client, input),
});

const bookingOutput = {
  type: 'object' as const,
  properties: {
    location_id: { type: 'integer' as const },
    event_id: { type: 'integer' as const },
    booking: bookingSchema,
  },
  required: ['booking'],
};

export const eventsUpdateAppointmentTool = defineTool({
  name: 'events_update_appointment',
  category: 'Events',
  description:
    'Change one client’s booking in a group event: the seats it takes, the comment, tags, color, or the price — price per seat before discount, discount_percent, or the total. Pass only what changes; the rest is kept. When seats, price or discount change without a total, the total is recalculated as price × seats × (1 − discount). A booking with product sales attached is refused, because this change would drop them. Find the appointment id with events_get; to move the client to another event use events_reschedule_appointment.',
  annotations: {
    title: 'Events: update a booking',
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    event_id: eventId,
    appointment_id: z
      .number()
      .int()
      .positive()
      .describe('The booking’s appointment id, from events_get.'),
    seats: z.number().int().positive().optional(),
    comment: z.string().max(255).nullable().optional(),
    tag_ids: z.array(z.number().int().positive()).optional(),
    color: color.nullable().optional(),
    price: z
      .number()
      .min(0)
      .optional()
      .describe('Price of one seat before discount.'),
    discount_percent: z.number().min(0).max(100).optional(),
    total: z
      .number()
      .min(0)
      .optional()
      .describe('Total due for the booking after discount.'),
  }),
  outputSchema: bookingOutput,
  handler: async ({ input, client }) => events.updateBooking(client, input),
});

export const eventsRescheduleAppointmentTool = defineTool({
  name: 'events_reschedule_appointment',
  category: 'Events',
  description:
    'Move one client’s booking from a group event to another event of the same location — "move Anna to Thursday’s class". Optionally change the seats or the comment on the way. Only an unpaid booking still waiting can move, out of an event that has not finished, into a future event with enough free seats that the client is not already in. Find the ids with events_get and events_list.',
  annotations: {
    title: 'Events: move a booking to another event',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    event_id: z
      .number()
      .int()
      .positive()
      .describe('Event the booking is in now.'),
    appointment_id: z
      .number()
      .int()
      .positive()
      .describe('The booking’s appointment id, from events_get.'),
    target_event_id: z
      .number()
      .int()
      .positive()
      .describe('Event to move the booking to.'),
    seats: z.number().int().positive().optional(),
    comment: z.string().max(255).nullable().optional(),
    keep_walk_in: z
      .boolean()
      .optional()
      .describe(
        'Keep the linked walk-in visitor on the booking. Default: the API keeps it.'
      ),
  }),
  outputSchema: bookingOutput,
  handler: async ({ input, client }) => events.rescheduleBooking(client, input),
});
