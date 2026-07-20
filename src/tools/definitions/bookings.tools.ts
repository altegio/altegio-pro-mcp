import { z } from 'zod';
import { defineTool } from '../factory.js';
import { bookingsOutput, bookingEntityOutput } from '../output-schemas.js';

const serviceItemSchema = z.object({
  id: z.number().int().positive().describe('Service ID'),
  amount: z.number().positive().optional().describe('Amount/quantity'),
});

export const getBookingsTool = defineTool({
  name: 'get_bookings',
  category: 'Bookings',
  description:
    '[Bookings] Get bookings for a company. AUTHENTICATION REQUIRED - this is administrative data. User must be logged in and have access to the company. If company_id not known, first call list_companies with my=1 to get user companies, then ask user to choose one. PAGINATION STRATEGY: Default may return many bookings. RECOMMENDED: Start with count=20-50 for recent bookings. Use start_date/end_date to filter by date range. Show first batch to user, fetch more only if needed. This saves context and computation.',
  annotations: {
    title: 'Get Bookings',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    company_id: z
      .number()
      .int()
      .positive()
      .describe('ID of the company to get bookings for'),
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
        'Filter bookings from this date (YYYY-MM-DD format). Use to reduce result set.'
      ),
    end_date: z
      .string()
      .optional()
      .describe(
        'Filter bookings until this date (YYYY-MM-DD format). Use to reduce result set.'
      ),
  }),
  outputSchema: bookingsOutput,
  handler: async ({ input, client }) => {
    const { company_id, ...listParams } = input;
    const bookings = await client.getBookings(
      company_id,
      Object.keys(listParams).length > 0 ? listParams : undefined
    );

    const summary = `Found ${bookings.length} ${bookings.length === 1 ? 'booking' : 'bookings'} for company ${company_id}:\n\n`;
    const bookingsList = bookings
      .map(
        (b, idx) =>
          `${idx + 1}. Booking ID: ${b.id}\n` +
          `   Date: ${b.datetime || b.date}\n` +
          `   Client: ${b.client?.name || 'N/A'} (${b.client?.phone || 'no phone'})\n` +
          `   Staff: ${b.staff?.name || 'N/A'}\n` +
          `   Services: ${b.services?.map((s) => s.title).join(', ') || 'N/A'}\n` +
          `   Status: ${b.status}`
      )
      .join('\n\n');

    return {
      text: summary + bookingsList,
      structuredContent: { items: bookings, count: bookings.length },
    };
  },
});

export const createBookingTool = defineTool({
  name: 'create_booking',
  category: 'Bookings',
  description:
    '[Bookings] Create a new client booking/appointment. AUTHENTICATION REQUIRED. Required fields: staff_id, services, datetime, client info.',
  annotations: {
    title: 'Create Booking',
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    staff_id: z.number().int().positive().describe('Staff member ID'),
    services: z.array(serviceItemSchema).describe('Array of service objects'),
    datetime: z
      .string()
      .describe('Booking datetime (ISO format: YYYY-MM-DDTHH:MM:SS)'),
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
    comment: z.string().optional().describe('Booking comment'),
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
    const { company_id, ...bookingData } = input;
    const booking = await client.createBooking(company_id, bookingData);
    return {
      text: `Successfully created booking:\nID: ${booking.id}\nStaff ID: ${booking.staff_id}\nDate: ${booking.datetime || booking.date}`,
      structuredContent: {
        id: booking.id,
        staff_id: booking.staff_id,
        datetime: booking.datetime,
        date: booking.date,
      },
    };
  },
});

export const updateBookingTool = defineTool({
  name: 'update_booking',
  category: 'Bookings',
  description:
    '[Bookings] Update existing booking/appointment. AUTHENTICATION REQUIRED. Provide only fields to update.',
  annotations: {
    title: 'Update Booking',
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    record_id: z.number().int().positive().describe('Booking/record ID'),
    staff_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Staff member ID'),
    services: z
      .array(serviceItemSchema)
      .optional()
      .describe('Array of service objects'),
    datetime: z.string().optional().describe('New booking datetime'),
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
    comment: z.string().optional().describe('Booking comment'),
    attendance: z.number().int().optional().describe('Attendance status'),
  }),
  outputSchema: bookingEntityOutput,
  handler: async ({ input, client }) => {
    const { company_id, record_id, ...updateData } = input;
    const booking = await client.updateBooking(
      company_id,
      record_id,
      updateData
    );
    return {
      text: `Successfully updated booking ${record_id}:\nDate: ${booking.datetime || booking.date}`,
      structuredContent: {
        id: booking.id,
        staff_id: booking.staff_id,
        datetime: booking.datetime,
        date: booking.date,
      },
    };
  },
});

export const deleteBookingTool = defineTool({
  name: 'delete_booking',
  category: 'Bookings',
  description:
    '[Bookings] Delete/cancel booking/appointment. AUTHENTICATION REQUIRED.',
  annotations: {
    title: 'Delete Booking',
    destructiveHint: true,
    openWorldHint: true,
  },
  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    record_id: z
      .number()
      .int()
      .positive()
      .describe('Booking/record ID to delete'),
  }),
  handler: async ({ input, client }) => {
    await client.deleteBooking(input.company_id, input.record_id);
    return {
      text: `Successfully deleted booking ${input.record_id} from company ${input.company_id}`,
    };
  },
});
