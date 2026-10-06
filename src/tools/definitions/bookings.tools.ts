import {
  paginationInput,
  pageMetadata,
  paginateCollection,
} from '../pagination.js';
import { z } from 'zod';
import { defineTool } from '../factory.js';
import {
  bookingsOutput,
  bookingEntityOutput,
  appointmentTagsOutput,
  appointmentTagEntityOutput,
} from '../output-schemas.js';
import {
  withUntrustedBlock,
  sanitizeUntrusted,
  type UntrustedField,
} from '../tool-result.js';
import { includeContactsArg, CONTACTS_WITHHELD_NOTICE } from '../contacts.js';
import {
  visitStatusOfAppointment,
  visitStatusToLegacyCode,
} from '../../capabilities/analytics/vocabulary.js';
import { hexColor } from '../../utils/color.js';
import { ExecutorRefusalError } from '../../utils/errors.js';
import type {
  AltegioBooking,
  UpdateBookingRequest,
} from '../../types/altegio.types.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

/** The states a caller can set; `cancelled` is `appointments_delete`. */
const appointmentStatusArg = z
  .enum(['waiting', 'confirmed', 'arrived', 'no_show'])
  .optional()
  .describe(
    'Visit status to record: waiting (default for a new appointment), confirmed, arrived or no_show.'
  );

/** The identifying fields a write returns; the full row is `appointments_list`. */
function projectAppointmentReference(appointment: AltegioBooking) {
  return {
    id: appointment.id,
    team_member_id: appointment.staff_id ?? appointment.staff?.id ?? null,
    datetime: appointment.datetime ?? null,
    date: appointment.date ?? null,
  };
}

/**
 * The digital schedule's appointment palette. The API stores any other value
 * as nothing at all and still answers 201, so the tools accept only these.
 */
const APPOINTMENT_COLORS = {
  '#f44336': 'red',
  '#e91e63': 'pink',
  '#9c27b0': 'purple',
  '#673ab7': 'deep purple',
  '#3f51b5': 'indigo',
  '#2196f3': 'blue',
  '#03a9f4': 'light blue',
  '#00bcd4': 'cyan',
  '#009688': 'teal',
  '#4caf50': 'green',
  '#8bc34a': 'light green',
  '#cddc39': 'lime',
  '#ffeb3b': 'yellow',
  '#ffc107': 'amber',
  '#ff9800': 'orange',
  '#ff5722': 'deep orange',
  '#795548': 'brown',
  '#9e9e9e': 'grey',
  '#607d8b': 'blue grey',
  '#000000': 'black',
} as const;

const appointmentColorArg = z
  .enum(
    Object.keys(APPOINTMENT_COLORS) as [
      keyof typeof APPOINTMENT_COLORS,
      ...(keyof typeof APPOINTMENT_COLORS)[],
    ]
  )
  .describe(
    'Color of the appointment in the digital schedule, from its palette: ' +
      Object.entries(APPOINTMENT_COLORS)
        .map(([hex, name]) => `${hex} ${name}`)
        .join(', ') +
      '.'
  );

const tagIdsArg = z
  .array(z.number().int().positive())
  .max(50)
  .describe(
    'Appointment tags to put on it, by id from appointments_list_tags; replaces the current tags.'
  );

/** `#f44336` → the wire's `f44336`; null removes the color. */
function wireColor(color: string | null): string {
  return color === null ? '' : color.slice(1);
}

const serviceItemSchema = z.object({
  id: z.number().int().positive().describe('Service ID'),
  amount: z.number().positive().optional().describe('Amount/quantity'),
});

function appointmentTotalCost(appointment: AltegioBooking): number | null {
  const priced = (appointment.services ?? []).filter(
    (service) => typeof service.cost === 'number'
  );
  if (priced.length === 0) return null;
  return priced.reduce(
    (total, service) => total + service.cost * (service.amount ?? 1),
    0
  );
}

function projectAppointment(
  appointment: AltegioBooking,
  options: { includeContacts?: boolean } = {}
) {
  return {
    id: appointment.id,
    location_id: appointment.company_id,
    datetime: appointment.datetime ?? null,
    date: appointment.date ?? null,
    status: visitStatusOfAppointment(appointment),
    team_member_id: appointment.staff_id ?? appointment.staff?.id ?? null,
    team_member_name: appointment.staff?.name ?? null,
    client_id: appointment.client?.id ?? null,
    client_name: appointment.client?.name ?? null,
    // Opt-in contacts, one rule for the whole server: see `../contacts.ts`.
    ...(options.includeContacts
      ? { client_phone: appointment.client?.phone ?? null }
      : {}),
    services: (appointment.services ?? []).map((service) => ({
      id: service.id,
      title: service.title,
      cost: service.cost ?? null,
      amount: service.amount ?? null,
    })),
    tags: (appointment.record_labels ?? []).map((tag) => ({
      id: tag.id,
      title: tag.title ?? '',
      color: hexColor(tag.color),
    })),
    color: hexColor(appointment.custom_color),
    total_cost: appointmentTotalCost(appointment),
    duration_seconds:
      appointment.seance_length ??
      appointment.length ??
      appointment.duration ??
      null,
    visit_id: appointment.visit_id ?? null,
    paid_in_full:
      appointment.paid_full === undefined
        ? null
        : Boolean(appointment.paid_full),
    prepaid: appointment.prepaid ?? null,
    online: appointment.online ?? null,
    comment: appointment.comment ?? null,
    deleted: Boolean(appointment.deleted),
  };
}

export const getAppointmentsTool = defineTool({
  name: 'appointments_list',
  category: 'Appointments',
  description:
    'List the appointments of a location, optionally within a date range. Each item carries the canonical status (waiting, confirmed, arrived, no_show, cancelled), team member, client, services, tags and color. Client phones are withheld unless include_contacts is true. Paged: 25 per page by default; follow pagination.next_page until it is null (a full last page may need one empty request). Find the location_id with locations_list first.',
  annotations: {
    title: 'Get Appointments',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z
      .number()
      .int()
      .positive()
      .describe('ID of the location to get appointments for'),
    ...paginationInput,
    date_from: isoDate
      .optional()
      .describe('First appointment date to include, YYYY-MM-DD.'),
    date_to: isoDate
      .optional()
      .describe('Last appointment date to include, YYYY-MM-DD.'),
    include_contacts: includeContactsArg,
  }),
  outputSchema: bookingsOutput,
  handler: async ({ input, client }) => {
    const { location_id, include_contacts } = input;
    const includeContacts = include_contacts === true;
    // Canonical names at the boundary; the V1 query takes count/start_date/end_date.
    const appointments = await client.getBookings(location_id, {
      page: input.page,
      count: input.page_size,
      ...(input.date_from ? { start_date: input.date_from } : {}),
      ...(input.date_to ? { end_date: input.date_to } : {}),
    });

    const lines = [
      `Found ${appointments.length} ${appointments.length === 1 ? 'appointment' : 'appointments'} for location ${location_id}:`,
    ];
    if (!includeContacts && appointments.length > 0) {
      lines.push(CONTACTS_WITHHELD_NOTICE);
    }
    // Free text — client and team-member names, service titles, the comment the
    // client typed at online booking — never goes inside our own rows; it is
    // keyed back to them by appointment id in the untrusted block below.
    const untrusted: UntrustedField[] = [];
    for (const booking of appointments) {
      const projected = projectAppointment(booking, { includeContacts });
      lines.push(
        `- Appointment ${booking.id}: ${projected.datetime ?? projected.date ?? 'date not reported'}` +
          ` · ${projected.status}` +
          ` · client id ${projected.client_id ?? 'not reported'}` +
          ` · team member id ${projected.team_member_id ?? 'not reported'}` +
          ` · ${projected.services.length} service(s)` +
          ` · total ${projected.total_cost ?? 'not reported'}` +
          (projected.tags.length
            ? ` · tag ids ${projected.tags.map((tag) => tag.id).join(', ')}`
            : '') +
          (projected.color ? ` · color ${projected.color}` : '')
      );
      const key = `appointment ${booking.id}`;
      untrusted.push({ label: `${key} client`, value: projected.client_name });
      untrusted.push({
        label: `${key} team member`,
        value: projected.team_member_name,
      });
      untrusted.push({
        label: `${key} services`,
        value: projected.services.map((s) => s.title).join(', '),
      });
      untrusted.push({ label: `${key} comment`, value: projected.comment });
      if (projected.tags.length) {
        untrusted.push({
          label: `${key} tags`,
          value: projected.tags.map((tag) => tag.title).join(', '),
        });
      }
      if (includeContacts) {
        untrusted.push({
          label: `${key} client phone`,
          value: booking.client?.phone ?? null,
        });
      }
    }

    return {
      text: withUntrustedBlock(lines.join('\n'), untrusted, { maxChars: 200 }),
      structuredContent: {
        items: appointments.map((booking) =>
          projectAppointment(booking, { includeContacts })
        ),
        pagination: pageMetadata(input, appointments.length),
        contacts_included: includeContacts,
      },
    };
  },
});

export const createAppointmentTool = defineTool({
  name: 'appointments_create',
  category: 'Appointments',
  description:
    'Create an appointment for a client. Required: team_member_id, services, datetime, session_length and the client name and phone. ' +
    'Prerequisites: the team member must be linked to every service (services_link_team_member; otherwise the API answers 400) and be scheduled at that time (schedules_create; otherwise 409). ' +
    'Pass save_if_busy=true to back-date a completed visit or force a slot that is busy or unscheduled, and status=arrived to record a past visit as attended. ' +
    'Optionally mark it with tags (ids from appointments_list_tags) and a color from the digital schedule palette.',
  annotations: {
    title: 'Create Appointment',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    team_member_id: z.number().int().positive().describe('Team member ID'),
    services: z
      .array(serviceItemSchema)
      .min(1)
      .describe('Array of service objects'),
    datetime: z
      .string()
      .describe('Appointment datetime (ISO format: YYYY-MM-DDTHH:MM:SS)'),
    session_length: z
      .number()
      .positive()
      .describe(
        'Session length in seconds (REQUIRED by the API for a standard appointment; a missing value is rejected with HTTP 422)'
      ),
    client: z
      .object({
        name: z.string().min(1).describe('Client name'),
        phone: z.string().min(1).describe('Client phone'),
        email: z.string().email().optional().describe('Client email'),
      })
      .describe('Client information'),
    comment: z.string().optional().describe('Appointment comment'),
    send_sms: z
      .boolean()
      .optional()
      .describe('Send the client an SMS confirmation.'),
    status: appointmentStatusArg,
    save_if_busy: z
      .boolean()
      .optional()
      .describe(
        'Keep the appointment even if the slot is busy or the team member is not scheduled (avoids HTTP 409). Useful for back-dated visits and test/demo data.'
      ),
    tag_ids: tagIdsArg.optional(),
    color: appointmentColorArg.optional(),
  }),
  outputSchema: bookingEntityOutput,
  handler: async ({ input, client }) => {
    const {
      location_id,
      team_member_id,
      session_length,
      send_sms,
      status,
      tag_ids,
      color,
      ...appointmentData
    } = input;
    const appointment = await client.createBooking(location_id, {
      staff_id: team_member_id,
      seance_length: session_length,
      ...(send_sms !== undefined ? { send_sms: send_sms ? 1 : 0 } : {}),
      ...(status !== undefined
        ? { attendance: visitStatusToLegacyCode(status) ?? undefined }
        : {}),
      ...(tag_ids !== undefined ? { record_labels: tag_ids } : {}),
      ...(color !== undefined ? { custom_color: wireColor(color) } : {}),
      ...appointmentData,
    });
    return {
      text: `Created appointment ${appointment.id} with team member ${appointment.staff_id} on ${appointment.datetime || appointment.date}.`,
      structuredContent: projectAppointmentReference(appointment),
    };
  },
});

/** The services as booked, priced as booked, for a full update that keeps them. */
function currentServices(
  appointment: AltegioBooking
): UpdateBookingRequest['services'] {
  return (appointment.services ?? []).map((service) => ({
    id: service.id,
    amount: service.amount ?? 1,
    ...(typeof service.first_cost === 'number'
      ? { first_cost: service.first_cost }
      : {}),
    ...(typeof service.discount === 'number'
      ? { discount: service.discount }
      : {}),
    ...(typeof service.cost === 'number' ? { cost: service.cost } : {}),
  }));
}

export const updateAppointmentTool = defineTool({
  name: 'appointments_update',
  category: 'Appointments',
  description:
    'Update an appointment: move it, change the team member, services, session length, client details, comment, status, tags or color. Pass only the fields to change; everything else, including the price of the booked services, is kept. Changing only the comment, status, tags or color keeps the appointment in its slot even if that slot is no longer free or scheduled.',
  annotations: {
    title: 'Update Appointment',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    appointment_id: z.number().int().positive().describe('Appointment ID'),
    team_member_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Team member ID'),
    services: z
      .array(serviceItemSchema)
      .min(1)
      .optional()
      .describe('Array of service objects; replaces the booked services.'),
    datetime: z.string().optional().describe('New appointment datetime'),
    session_length: z
      .number()
      .positive()
      .optional()
      .describe('Session length in seconds'),
    client: z
      .object({
        name: z.string().optional().describe('Client name'),
        phone: z.string().optional().describe('Client phone'),
        email: z.string().email().optional().describe('Client email'),
      })
      .optional()
      .describe('Client information'),
    comment: z.string().optional().describe('Appointment comment'),
    status: appointmentStatusArg,
    tag_ids: tagIdsArg.optional(),
    color: appointmentColorArg
      .nullable()
      .optional()
      .describe(
        'Color of the appointment in the digital schedule, from the palette listed for appointments_create; null removes it.'
      ),
  }),
  outputSchema: bookingEntityOutput,
  handler: async ({ input, client }) => {
    const { location_id, appointment_id } = input;
    // The API replaces the whole appointment on update and refuses a body
    // without its team member, services, client, start and length, so the
    // current appointment fills whatever the call leaves out. Tags and color
    // the call does not mention are left out of the body: the API keeps them.
    const current = await client.getBooking(location_id, appointment_id);
    const staffId =
      input.team_member_id ?? current.staff_id ?? current.staff?.id;
    const datetime = input.datetime ?? current.datetime ?? current.date;
    const sessionLength =
      input.session_length ?? current.seance_length ?? current.length;
    const services = input.services ?? currentServices(current);
    if (!staffId || !datetime || !sessionLength || services.length === 0) {
      throw new ExecutorRefusalError(
        `Appointment ${appointment_id} did not report its team member, start, length or services. Pass team_member_id, datetime, session_length and services explicitly.`
      );
    }
    const currentClient = current.client;
    const clientData: UpdateBookingRequest['client'] = input.client
      ? {
          name: input.client.name ?? currentClient?.name,
          phone: input.client.phone ?? currentClient?.phone,
          ...((input.client.email ?? currentClient?.email)
            ? { email: input.client.email ?? currentClient?.email }
            : {}),
        }
      : currentClient?.id
        ? { id: currentClient.id }
        : {};
    const keepsSlot =
      input.team_member_id === undefined &&
      input.datetime === undefined &&
      input.session_length === undefined &&
      input.services === undefined;
    const attendance =
      input.status !== undefined
        ? (visitStatusToLegacyCode(input.status) ?? undefined)
        : typeof current.attendance === 'number'
          ? current.attendance
          : undefined;
    const comment = input.comment ?? current.comment;
    const activityId = Number(current.activity_id ?? 0);

    const appointment = await client.updateBooking(
      location_id,
      appointment_id,
      {
        staff_id: staffId,
        services,
        datetime,
        seance_length: sessionLength,
        client: clientData,
        ...(comment !== undefined ? { comment } : {}),
        ...(attendance !== undefined ? { attendance } : {}),
        ...(activityId > 0 ? { activity_id: activityId } : {}),
        ...(keepsSlot ? { save_if_busy: true } : {}),
        ...(input.tag_ids !== undefined
          ? { record_labels: input.tag_ids }
          : {}),
        ...(input.color !== undefined
          ? { custom_color: wireColor(input.color) }
          : {}),
      }
    );
    return {
      text: `Updated appointment ${appointment_id}; now on ${appointment.datetime || appointment.date}.`,
      structuredContent: projectAppointmentReference(appointment),
    };
  },
});

export const deleteAppointmentTool = defineTool({
  name: 'appointments_delete',
  category: 'Appointments',
  description:
    'Cancel an appointment and remove it from the calendar. Asks for confirmation first.',
  annotations: {
    title: 'Delete Appointment',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    appointment_id: z
      .number()
      .int()
      .positive()
      .describe('Appointment ID to delete'),
  }),
  confirm: {
    action: 'Delete appointment',
    target: (input) =>
      `appointment ${input.appointment_id} at location ${input.location_id}`,
    resolve: async (input, client) => {
      const { data } = await client.request<AltegioBooking>(
        'GET',
        `/locations/${input.location_id}/appointments/${input.appointment_id}`
      );
      if (!data?.id) return undefined;
      const services = (data.services ?? [])
        .map((service) => service.title)
        .join(', ');
      return [
        `appointment ${data.id} on ${data.datetime ?? data.date ?? 'an unknown date'}`,
        data.client?.name ? `for ${data.client.name}` : null,
        data.staff?.name ? `with ${data.staff.name}` : null,
        services ? `(${services})` : null,
        `at location ${input.location_id}`,
      ]
        .filter(Boolean)
        .join(' ');
    },
    consequence:
      'The appointment is cancelled and leaves the calendar, the slot becomes bookable again, and the visit stops counting towards the client history and the revenue reports. This server sends no cancellation notice to the client.',
  },
  handler: async ({ input, client }) => {
    await client.deleteBooking(input.location_id, input.appointment_id);
    return {
      text: `Successfully deleted appointment ${input.appointment_id} from location ${input.location_id}`,
    };
  },
});

export const listAppointmentTagsTool = defineTool({
  name: 'appointments_list_tags',
  category: 'Appointments',
  description:
    'List the appointment tags of a location — the colored marks the team puts on appointments in the digital schedule (for example "new client" or "VIP") — with their ids and colors. Pass query to find tags whose title contains it. Use the ids as tag_ids in appointments_create and appointments_update; create a missing tag with appointments_create_tag. Paged: 25 per page by default; follow pagination.next_page until it is null.',
  annotations: {
    title: 'Appointments: list tags',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    query: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Only tags whose title contains this text, ignoring case.'),
    ...paginationInput,
  }),
  outputSchema: appointmentTagsOutput,
  handler: async ({ input, client }) => {
    const needle = input.query?.toLocaleLowerCase();
    const all = await client.getAppointmentTags(input.location_id);
    const matching = needle
      ? all.filter((tag) => tag.title.toLocaleLowerCase().includes(needle))
      : all;
    const { items: tags, pagination } = paginateCollection(matching, input);

    if (tags.length === 0) {
      return {
        text: needle
          ? 'No appointment tags match this query.'
          : 'This location has no appointment tags.',
        structuredContent: { items: [], pagination },
      };
    }

    // A tag title is named by the team of the location.
    const untrusted: UntrustedField[] = tags.map((tag) => ({
      label: `tag ${tag.id} title`,
      value: tag.title,
    }));
    return {
      text: withUntrustedBlock(
        `Found ${tags.length} appointment tag(s): ${tags.map((tag) => `${tag.id} (${tag.color || 'no color'})`).join(', ')}.`,
        untrusted,
        { maxChars: 200 }
      ),
      structuredContent: { items: tags, pagination },
    };
  },
});

export const createAppointmentTagTool = defineTool({
  name: 'appointments_create_tag',
  category: 'Appointments',
  description:
    'Create an appointment tag in a location: a title and a color the digital schedule shows on every appointment that carries it. Titles are not unique, so check appointments_list_tags with query first and reuse an existing tag. Put the tag on appointments with tag_ids in appointments_create or appointments_update.',
  annotations: {
    title: 'Appointments: create a tag',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    title: z.string().trim().min(1).max(100).describe('Tag title'),
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, 'Use #rrggbb')
      .describe('Tag color as #rrggbb.'),
  }),
  outputSchema: appointmentTagEntityOutput,
  handler: async ({ input, client }) => {
    const tag = await client.createAppointmentTag(input.location_id, {
      title: input.title,
      color: input.color.toLowerCase(),
    });
    return {
      text: withUntrustedBlock(
        `Created appointment tag ${tag.id} with color ${tag.color}.`,
        [{ label: 'title', value: tag.title }]
      ),
      structuredContent: {
        id: tag.id,
        title: sanitizeUntrusted(tag.title) ?? '',
        color: tag.color,
      },
    };
  },
});
