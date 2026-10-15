import {
  paginationInput,
  paginateCollection,
  renderPage,
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
  upstreamDetail,
  type UntrustedField,
} from '../tool-result.js';
import { includeContactsArg, CONTACTS_WITHHELD_NOTICE } from '../contacts.js';
import {
  visitStatusOfAppointment,
  visitStatusToLegacyCode,
} from '../../capabilities/analytics/vocabulary.js';
import { hexColor } from '../../utils/color.js';
import { AltegioApiError, ExecutorRefusalError } from '../../utils/errors.js';
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

/**
 * When the appointment starts. V1 sends both `datetime` (ISO 8601 with the
 * location's offset) and `date` (the same instant without it); one is enough.
 */
function appointmentStart(appointment: AltegioBooking): string | null {
  return appointment.datetime || appointment.date || null;
}

/** The identifying fields a write returns; the full row is `appointments_list`. */
function projectAppointmentReference(appointment: AltegioBooking) {
  return {
    id: appointment.id,
    team_member_id: appointment.staff_id ?? appointment.staff?.id ?? null,
    datetime: appointmentStart(appointment),
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
  .describe('Appointment color, from the digital schedule palette.');

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

/**
 * The appointment's service value: the sum of its lines' `cost`. A line's
 * `cost` is already its total after discount and quantity (`cost_per_unit` ×
 * `amount`, less the discount), so it is never multiplied by `amount`.
 */
function appointmentTotalCost(appointment: AltegioBooking): number | null {
  const priced = (appointment.services ?? []).filter(
    (service) => typeof service.cost === 'number'
  );
  if (priced.length === 0) return null;
  return priced.reduce((total, service) => total + service.cost, 0);
}

function projectAppointment(
  appointment: AltegioBooking,
  options: { includeContacts?: boolean } = {}
) {
  return {
    id: appointment.id,
    datetime: appointmentStart(appointment),
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
    'Appointments of a location by date range, team member, client, creator, group event, creation or change time; cancelled (deleted) ones only with include_deleted. Each has status (arrived is a visit), team member, client (null for a walk-in), services with cost (the line total after discount), tags and color; phones need include_contacts. Paged: follow pagination.next_page with the same page_size.',
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
    team_member_id: z.number().int().positive().optional(),
    client_id: z.number().int().positive().optional(),
    created_by_user_id: z.number().int().positive().optional(),
    event_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Only appointments booked to this group event.'),
    created_from: isoDate
      .optional()
      .describe(
        'Appointment creation date from, independent of appointment date.'
      ),
    created_to: isoDate
      .optional()
      .describe(
        'Appointment creation date through, independent of appointment date.'
      ),
    changed_after: z.string().datetime({ offset: true }).optional(),
    changed_before: z.string().datetime({ offset: true }).optional(),
    include_deleted: z
      .boolean()
      .optional()
      .describe(
        'Include deleted appointments for cancellation audits. Default false.'
      ),
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
      ...(input.team_member_id ? { team_member_id: input.team_member_id } : {}),
      ...(input.client_id ? { client_id: input.client_id } : {}),
      ...(input.created_by_user_id
        ? { created_user_id: input.created_by_user_id }
        : {}),
      ...(input.event_id ? { activity_id: input.event_id } : {}),
      ...(input.created_from ? { c_start_date: input.created_from } : {}),
      ...(input.created_to ? { c_end_date: input.created_to } : {}),
      ...(input.changed_after ? { changed_after: input.changed_after } : {}),
      ...(input.changed_before ? { changed_before: input.changed_before } : {}),
      ...(input.include_deleted !== undefined
        ? { with_deleted: input.include_deleted ? 1 : 0 }
        : {}),
    });

    return renderPage({
      input,
      items: appointments,
      render: ({ items, pagination }) => {
        const projected = items.map((booking) =>
          projectAppointment(booking, { includeContacts })
        );
        const lines = [
          `${projected.length} ${projected.length === 1 ? 'appointment' : 'appointments'} at location ${location_id}, page ${pagination.page}` +
            (pagination.next_page === null
              ? ' (last page).'
              : `; next: page=${pagination.next_page}, page_size=${pagination.page_size}.`),
        ];
        if (!includeContacts && projected.length > 0) {
          lines.push(CONTACTS_WITHHELD_NOTICE);
        }
        lines.push(...projected.map(appointmentLine));
        return {
          text: withUntrustedBlock(
            lines.join('\n'),
            appointmentNames(projected),
            { maxChars: 200 }
          ),
          structuredContent: {
            location_id,
            items: projected,
            pagination,
            contacts_included: includeContacts,
          },
        };
      },
    });
  },
});

type ProjectedAppointment = ReturnType<typeof projectAppointment>;

/**
 * One appointment as one line of our own text: ids, time, status, money. Every
 * name is in the untrusted block, keyed by these ids.
 */
function appointmentLine(appointment: ProjectedAppointment): string {
  const parts = [
    `- ${appointment.id}`,
    appointment.datetime ?? 'start not reported',
    appointment.status,
    appointment.client_id === null
      ? 'no client'
      : `client ${appointment.client_id}`,
    appointment.team_member_id === null
      ? 'no team member'
      : `team member ${appointment.team_member_id}`,
    `services ${appointment.services.map((service) => service.id).join(', ') || 'none'}`,
    `total ${appointment.total_cost ?? 'not reported'}`,
  ];
  if (appointment.tags.length > 0) {
    parts.push(`tags ${appointment.tags.map((tag) => tag.id).join(', ')}`);
  }
  if (appointment.color) parts.push(`color ${appointment.color}`);
  if (appointment.deleted) parts.push('deleted');
  return parts.join(' · ');
}

/**
 * Free text of a page, each name once: team members, services, tags and
 * clients by id, then each appointment's comment. A schedule repeats the same
 * few team members and services on every row, so naming them per appointment
 * cost more than the rows themselves.
 */
function appointmentNames(
  appointments: readonly ProjectedAppointment[]
): UntrustedField[] {
  const teamMembers = new Map<number, string | null>();
  const services = new Map<number, string>();
  const tags = new Map<number, string>();
  const clients = new Map<number, UntrustedField[]>();
  const comments: UntrustedField[] = [];
  for (const appointment of appointments) {
    if (appointment.team_member_id !== null) {
      teamMembers.set(appointment.team_member_id, appointment.team_member_name);
    }
    for (const service of appointment.services) {
      services.set(service.id, service.title);
    }
    for (const tag of appointment.tags) tags.set(tag.id, tag.title);
    if (appointment.client_id !== null && !clients.has(appointment.client_id)) {
      const fields: UntrustedField[] = [
        {
          label: `client ${appointment.client_id}`,
          value: appointment.client_name,
        },
      ];
      if ('client_phone' in appointment) {
        fields.push({
          label: `client ${appointment.client_id} phone`,
          value: appointment.client_phone,
        });
      }
      clients.set(appointment.client_id, fields);
    }
    comments.push({
      label: `comment on ${appointment.id}`,
      value: appointment.comment,
    });
  }
  return [
    ...[...teamMembers].map(([id, name]) => ({
      label: `team member ${id}`,
      value: name,
    })),
    ...[...services].map(([id, title]) => ({
      label: `service ${id}`,
      value: title,
    })),
    ...[...tags].map(([id, title]) => ({ label: `tag ${id}`, value: title })),
    ...[...clients.values()].flat(),
    ...comments,
  ];
}

export const createAppointmentTool = defineTool({
  name: 'appointments_create',
  category: 'Appointments',
  description:
    'Create an appointment for a client. Required: team_member_id, services, datetime, session_length and the client name and phone. ' +
    'Pick the time with appointments_find_free_slots first: a busy or unscheduled time is refused (409), and so is a team member not linked to every service (400). ' +
    'save_if_busy=true forces a busy or unscheduled slot (back-dated visits); status=arrived records a past visit as attended. Optional: tags (appointments_list_tags), color.',
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
        'Save even if the slot is busy or unscheduled (avoids 409): back-dated visits, demo data.'
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
    let appointment: AltegioBooking;
    try {
      appointment = await client.createBooking(location_id, {
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
    } catch (error) {
      const refusal = createRefusal(error, input);
      if (refusal) return { text: refusal, isError: true };
      throw error;
    }
    return {
      text: `Created appointment ${appointment.id} with team member ${appointment.staff_id} on ${appointment.datetime || appointment.date}.`,
      structuredContent: projectAppointmentReference(appointment),
    };
  },
});

/**
 * What to do next when the API refuses a new appointment for the two reasons
 * models keep guessing their way around: the time (409) and the links (400).
 * Our sentence first, the upstream wording quoted after it.
 */
function createRefusal(
  error: unknown,
  input: {
    location_id: number;
    team_member_id: number;
    datetime: string;
    services: Array<{ id: number }>;
  }
): string | undefined {
  if (!(error instanceof AltegioApiError)) return undefined;
  if (error.statusCode !== 409 && error.statusCode !== 400) return undefined;
  const meta = (error.response as { meta?: { message?: unknown } } | undefined)
    ?.meta;
  const detail = upstreamDetail(meta?.message);
  const search = `appointments_find_free_slots with location_id ${input.location_id}, service_ids [${input.services.map((s) => s.id).join(', ')}]`;
  const next =
    error.statusCode === 409
      ? `Not created: team member ${input.team_member_id} is busy or not working at ${input.datetime} (HTTP 409). Do not guess another time: call ${search}, team_member_id ${input.team_member_id} and a date range, then retry with a listed start. Use save_if_busy=true only to record a past visit or to double-book on purpose.`
      : `Not created (HTTP 400). The usual cause is a team member not linked to every service: call ${search} (without team_member_id) to see who can take them, or link team member ${input.team_member_id} with services_link_team_member.`;
  return detail ? `${next} ${detail}` : next;
}

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
