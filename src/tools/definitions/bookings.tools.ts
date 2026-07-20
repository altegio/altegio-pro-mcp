import { z } from 'zod';
import { defineTool } from '../factory.js';
import { bookingsOutput, bookingEntityOutput } from '../output-schemas.js';

const serviceItemSchema = z.object({
  id: z.number().int().positive().describe('Service ID'),
  amount: z.number().positive().optional().describe('Amount/quantity'),
});

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
        'Page number for pagination (starts at 0). Use to fetch subsequent pages when user needs more results.'
      ),
    count: z
      .number()
      .int()
      .positive()
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
  }),
  outputSchema: bookingsOutput,
  handler: async ({ input, client }) => {
    const { location_id, ...listParams } = input;
    const appointments = await client.getBookings(
      location_id,
      Object.keys(listParams).length > 0 ? listParams : undefined
    );

    const summary = `Found ${appointments.length} ${appointments.length === 1 ? 'appointment' : 'appointments'} for location ${location_id}:\n\n`;
    const appointmentsList = appointments
      .map(
        (b, idx) =>
          `${idx + 1}. Appointment ID: ${b.id}\n` +
          `   Date: ${b.datetime || b.date}\n` +
          `   Client: ${b.client?.name || 'N/A'} (${b.client?.phone || 'no phone'})\n` +
          `   Team member: ${b.staff?.name || 'N/A'}\n` +
          `   Services: ${b.services?.map((s) => s.title).join(', ') || 'N/A'}\n` +
          `   Status: ${b.status}`
      )
      .join('\n\n');

    return {
      text: summary + appointmentsList,
      structuredContent: { items: appointments, count: appointments.length },
    };
  },
});

export const createAppointmentTool = defineTool({
  name: 'create_appointment',
  category: 'Appointments',
  description:
    '[Appointments] Create a new client appointment. AUTHENTICATION REQUIRED. Required fields: team_member_id, services, datetime, client info.',
  annotations: {
    title: 'Create Appointment',
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    team_member_id: z.number().int().positive().describe('Team member ID'),
    services: z.array(serviceItemSchema).describe('Array of service objects'),
    datetime: z
      .string()
      .describe('Appointment datetime (ISO format: YYYY-MM-DDTHH:MM:SS)'),
    seance_length: z
      .number()
      .positive()
      .optional()
      .describe('Session length in seconds'),
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
    attendance: z.number().int().optional().describe('Attendance status'),
  }),
  outputSchema: bookingEntityOutput,
  handler: async ({ input, client }) => {
    const { location_id, team_member_id, ...appointmentData } = input;
    const appointment = await client.createBooking(location_id, {
      staff_id: team_member_id,
      ...appointmentData,
    });
    return {
      text: `Successfully created appointment:\nID: ${appointment.id}\nTeam member ID: ${appointment.staff_id}\nDate: ${appointment.datetime || appointment.date}`,
      structuredContent: {
        id: appointment.id,
        staff_id: appointment.staff_id,
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
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    record_id: z.number().int().positive().describe('Appointment/record ID'),
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
    seance_length: z
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
    const { location_id, record_id, team_member_id, ...updateData } = input;
    const appointment = await client.updateBooking(location_id, record_id, {
      ...(team_member_id !== undefined ? { staff_id: team_member_id } : {}),
      ...updateData,
    });
    return {
      text: `Successfully updated appointment ${record_id}:\nDate: ${appointment.datetime || appointment.date}`,
      structuredContent: {
        id: appointment.id,
        staff_id: appointment.staff_id,
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
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    record_id: z
      .number()
      .int()
      .positive()
      .describe('Appointment/record ID to delete'),
  }),
  handler: async ({ input, client }) => {
    await client.deleteBooking(input.location_id, input.record_id);
    return {
      text: `Successfully deleted appointment ${input.record_id} from location ${input.location_id}`,
    };
  },
});
