import { paginationInput, pageMetadata } from '../pagination.js';
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { bookingsOutput, bookingEntityOutput } from '../output-schemas.js';
import { withUntrustedBlock, type UntrustedField } from '../tool-result.js';
import { includeContactsArg, CONTACTS_WITHHELD_NOTICE } from '../contacts.js';
import {
  visitStatusOfAppointment,
  visitStatusToLegacyCode,
} from '../../capabilities/analytics/vocabulary.js';
import type { AltegioBooking } from '../../types/altegio.types.js';

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
    'List the appointments of a location, optionally within a date range. Each item carries the canonical status (waiting, confirmed, arrived, no_show, cancelled), team member, client and services. Client phones are withheld unless include_contacts is true. Paged: 25 per page by default; follow pagination.next_page until it is null (a full last page may need one empty request). Find the location_id with locations_list first.',
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
          ` · total ${projected.total_cost ?? 'not reported'}`
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
    'Pass save_if_busy=true to back-date a completed visit or force a slot that is busy or unscheduled, and status=arrived to record a past visit as attended.',
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
  }),
  outputSchema: bookingEntityOutput,
  handler: async ({ input, client }) => {
    const {
      location_id,
      team_member_id,
      session_length,
      send_sms,
      status,
      ...appointmentData
    } = input;
    const appointment = await client.createBooking(location_id, {
      staff_id: team_member_id,
      seance_length: session_length,
      ...(send_sms !== undefined ? { send_sms: send_sms ? 1 : 0 } : {}),
      ...(status !== undefined
        ? { attendance: visitStatusToLegacyCode(status) ?? undefined }
        : {}),
      ...appointmentData,
    });
    return {
      text: `Created appointment ${appointment.id} with team member ${appointment.staff_id} on ${appointment.datetime || appointment.date}.`,
      structuredContent: projectAppointmentReference(appointment),
    };
  },
});

export const updateAppointmentTool = defineTool({
  name: 'appointments_update',
  category: 'Appointments',
  description:
    'Update an appointment: move it, change the team member, services, session length, client details, comment or status. Pass only the fields to change.',
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
      .optional()
      .describe('Array of service objects'),
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
  }),
  outputSchema: bookingEntityOutput,
  handler: async ({ input, client }) => {
    const {
      location_id,
      appointment_id,
      team_member_id,
      session_length,
      status,
      ...updateData
    } = input;
    const appointment = await client.updateBooking(
      location_id,
      appointment_id,
      {
        ...(team_member_id !== undefined ? { staff_id: team_member_id } : {}),
        ...(session_length !== undefined
          ? { seance_length: session_length }
          : {}),
        ...(status !== undefined
          ? { attendance: visitStatusToLegacyCode(status) ?? undefined }
          : {}),
        ...updateData,
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
