import { z } from 'zod';
import { defineTool } from '../factory.js';
import { bookingsOutput, bookingEntityOutput } from '../output-schemas.js';
import { withUntrustedBlock, type UntrustedField } from '../tool-result.js';
import { includeContactsArg, CONTACTS_WITHHELD_NOTICE } from '../contacts.js';
import { visitStatusFromLegacyCode } from '../../capabilities/analytics/vocabulary.js';
import type { AltegioBooking } from '../../types/altegio.types.js';

const serviceItemSchema = z.object({
  id: z.number().int().positive().describe('Service ID'),
  amount: z.number().positive().optional().describe('Amount/quantity'),
});

function appointmentStatus(appointment: AltegioBooking): string {
  if (appointment.deleted) return 'cancelled';
  const code = appointment.attendance ?? appointment.visit_attendance;
  // Some V1 responses keep attendance=0 but set the separate confirmation
  // flag. Prefer the more specific state in that combination.
  if (code === 0 && appointment.confirmed === 1) return 'confirmed';
  if (typeof code === 'number') {
    const mapped = visitStatusFromLegacyCode(code);
    if (mapped) return mapped;
  }
  const reported = appointment.status?.trim().toLowerCase();
  if (
    reported &&
    ['waiting', 'confirmed', 'arrived', 'no_show', 'cancelled'].includes(
      reported
    )
  ) {
    return reported;
  }
  return 'unknown';
}

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
    status: appointmentStatus(appointment),
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
  name: 'get_appointments',
  category: 'Appointments',
  description:
    '[Appointments] Get appointments for a location. AUTHENTICATION REQUIRED - this is administrative data. User must be logged in and have access to the location. If location_id not known, first call list_locations with my=1 to get user locations, then ask user to choose one. PAGINATION STRATEGY: Default may return many appointments. RECOMMENDED: Start with count=20-50 for recent appointments. Use start_date/end_date to filter by date range. Show first batch to user, fetch more only if needed. This saves context and computation.',
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
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        '1-based page number for pagination (default 1). Use 2 for the next page.'
      ),
    count: z
      .number()
      .int()
      .positive()
      .max(300)
      .optional()
      .describe(
        'Results per page. Default may be large. RECOMMENDED: Use 20-50 for initial requests. Only increase if user explicitly requests more. Max 300.'
      ),
    start_date: z
      .string()
      .optional()
      .describe(
        'Filter appointments from this date (YYYY-MM-DD format). Use to reduce result set.'
      ),
    end_date: z
      .string()
      .optional()
      .describe(
        'Filter appointments until this date (YYYY-MM-DD format). Use to reduce result set.'
      ),
    include_contacts: includeContactsArg,
  }),
  outputSchema: bookingsOutput,
  handler: async ({ input, client }) => {
    const { location_id, include_contacts, ...listParams } = input;
    const includeContacts = include_contacts === true;
    const appointments = await client.getBookings(
      location_id,
      Object.keys(listParams).length > 0 ? listParams : undefined
    );

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
        count: appointments.length,
        contacts_included: includeContacts,
      },
    };
  },
});

export const createAppointmentTool = defineTool({
  name: 'create_appointment',
  category: 'Appointments',
  description:
    '[Appointments] Create a new client appointment. AUTHENTICATION REQUIRED. Required fields: team_member_id, services, datetime, session_length, client info. ' +
    'PREREQUISITES: the team member must be LINKED to each service (use link_service_team_member, else HTTP 400 "team member does not provide the selected services") AND scheduled/available at the datetime (use create_schedule, else HTTP 409 "time not available"). ' +
    'To back-date a completed visit or force a booking onto a busy/off slot, pass save_if_busy=true. Set attendance=1 to mark a past visit as attended.',
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
      .number()
      .int()
      .min(0)
      .max(1)
      .optional()
      .describe('Send SMS reminder (0 or 1)'),
    attendance: z
      .number()
      .int()
      .optional()
      .describe(
        'Attendance status: 2 confirmed, 1 arrived/attended, 0 waiting, -1 no-show'
      ),
    save_if_busy: z
      .boolean()
      .optional()
      .describe(
        'Keep the appointment even if the slot is busy or the team member is not scheduled (avoids HTTP 409). Useful for back-dated visits and test/demo data.'
      ),
  }),
  outputSchema: bookingEntityOutput,
  handler: async ({ input, client }) => {
    const { location_id, team_member_id, session_length, ...appointmentData } =
      input;
    const appointment = await client.createBooking(location_id, {
      staff_id: team_member_id,
      seance_length: session_length,
      ...appointmentData,
    });
    return {
      text: `Successfully created appointment:\nID: ${appointment.id}\nTeam member ID: ${appointment.staff_id}\nDate: ${appointment.datetime || appointment.date}`,
      structuredContent: {
        id: appointment.id,
        team_member_id: appointment.staff_id,
        datetime: appointment.datetime,
        date: appointment.date,
      },
    };
  },
});

export const updateAppointmentTool = defineTool({
  name: 'update_appointment',
  category: 'Appointments',
  description:
    '[Appointments] Update existing appointment. AUTHENTICATION REQUIRED. Provide only fields to update.',
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
    attendance: z.number().int().optional().describe('Attendance status'),
  }),
  outputSchema: bookingEntityOutput,
  handler: async ({ input, client }) => {
    const {
      location_id,
      appointment_id,
      team_member_id,
      session_length,
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
        ...updateData,
      }
    );
    return {
      text: `Successfully updated appointment ${appointment_id}:\nDate: ${appointment.datetime || appointment.date}`,
      structuredContent: {
        id: appointment.id,
        team_member_id: appointment.staff_id,
        datetime: appointment.datetime,
        date: appointment.date,
      },
    };
  },
});

export const deleteAppointmentTool = defineTool({
  name: 'delete_appointment',
  category: 'Appointments',
  description:
    '[Appointments] Delete/cancel appointment. AUTHENTICATION REQUIRED.',
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
        `/record/${input.location_id}/${input.appointment_id}`
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
