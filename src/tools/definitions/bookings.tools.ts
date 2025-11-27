import { z } from 'zod';
import { defineTool } from '../factory.js';
import { formatBookingsList } from '../formatters.js';

export const getBookingsTool = defineTool({
  name: 'get_bookings',
  category: 'Bookings',
  description:
    '[Bookings] Get list of bookings/appointments for a company. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    page: z.number().int().positive().optional().describe('Page number'),
    count: z.number().int().positive().optional().describe('Results per page'),
    start_date: z
      .string()
      .optional()
      .describe('Start date filter (YYYY-MM-DD)'),
    end_date: z.string().optional().describe('End date filter (YYYY-MM-DD)'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, ...params } = input;
    const bookings = await client.getBookings(company_id, params);
    return formatBookingsList(bookings, company_id);
  },
});

export const createBookingTool = defineTool({
  name: 'create_booking',
  category: 'Bookings',
  description:
    '[Bookings] Create a new booking/appointment. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    staff_id: z.number().int().positive().describe('Staff member ID'),
    services: z
      .array(
        z.object({
          id: z.number().int().positive().describe('Service ID'),
          amount: z.number().positive().optional().describe('Service quantity'),
        })
      )
      .min(1)
      .describe('Array of services'),
    datetime: z
      .string()
      .describe('Appointment date and time (YYYY-MM-DD HH:MM:SS)'),
    seance_length: z
      .number()
      .positive()
      .optional()
      .describe('Duration in minutes'),
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
      .describe('Send SMS notification (0/1)'),
    attendance: z.number().int().optional().describe('Attendance status'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, ...bookingData } = input;
    const booking = await client.createBooking(company_id, bookingData);
    return `Successfully created booking:\nID: ${booking.id}\nStaff ID: ${booking.staff_id}\nDate: ${booking.datetime || booking.date}`;
  },
});

export const updateBookingTool = defineTool({
  name: 'update_booking',
  category: 'Bookings',
  description:
    '[Bookings] Update existing booking/appointment. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

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
      .array(
        z.object({
          id: z.number().int().positive().describe('Service ID'),
          amount: z.number().positive().optional().describe('Service quantity'),
        })
      )
      .optional()
      .describe('Array of services'),
    datetime: z
      .string()
      .optional()
      .describe('Appointment date and time (YYYY-MM-DD HH:MM:SS)'),
    seance_length: z
      .number()
      .positive()
      .optional()
      .describe('Duration in minutes'),
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

  handler: async ({ input, client }) => {
    const { company_id, record_id, ...updateData } = input;
    const booking = await client.updateBooking(
      company_id,
      record_id,
      updateData
    );
    return `Successfully updated booking ${record_id}:\nDate: ${booking.datetime || booking.date}`;
  },
});

export const deleteBookingTool = defineTool({
  name: 'delete_booking',
  category: 'Bookings',
  description:
    '[Bookings] Delete/cancel booking/appointment. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    record_id: z.number().int().positive().describe('Booking/record ID'),
  }),

  handler: async ({ input, client }) => {
    await client.deleteBooking(input.company_id, input.record_id);
    return `Successfully deleted booking ${input.record_id} from company ${input.company_id}`;
  },
});
