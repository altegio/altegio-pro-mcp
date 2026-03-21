import { AltegioClient } from '../providers/altegio-client.js';
import { z, ZodError } from 'zod';
import {
  AuthenticationError,
  AltegioApiError,
} from '../utils/errors.js';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export async function withErrorHandling(
  toolName: string,
  fn: () => Promise<ToolResult>
): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    let message: string;

    if (error instanceof ZodError) {
      const issues = error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      message = `Invalid parameters for ${toolName}: ${issues}`;
    } else if (error instanceof AuthenticationError) {
      message = `Authentication required. Call altegio_login before using ${toolName}.`;
    } else if (error instanceof AltegioApiError) {
      message = error.message;
    } else if (error instanceof Error) {
      message = `${toolName} failed: ${error.message}`;
    } else {
      message = `${toolName} failed with an unexpected error`;
    }

    return {
      content: [{ type: 'text' as const, text: message }],
      isError: true,
    };
  }
}

// Input schemas
const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const CompaniesParamsSchema = z
  .object({
    my: z.number().int().min(0).max(1).optional(),
    page: z.number().int().positive().optional(),
    count: z.number().int().positive().optional(),
  })
  .optional();

const BookingsParamsSchema = z.object({
  company_id: z.number().int().positive(),
  page: z.number().int().positive().optional(),
  count: z.number().int().positive().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
});

const PublicListParamsSchema = z.object({
  company_id: z.number().int().positive(),
  page: z.number().int().positive().optional(),
  count: z.number().int().positive().optional(),
});

// ========== Staff CRUD Schemas ==========
const CreateStaffSchema = z.object({
  company_id: z.number().int().positive(),
  name: z.string().min(1),
  specialization: z.string().min(1),
  position_id: z.number().int().positive().nullable(),
  phone_number: z.string().nullable(),
  user_email: z.string().email(),
  user_phone: z.string().min(1),
  is_user_invite: z.boolean(),
});

const UpdateStaffSchema = z.object({
  company_id: z.number().int().positive(),
  staff_id: z.number().int().positive(),
  name: z.string().min(1).optional(),
  specialization: z.string().optional(),
  weight: z.number().optional(),
  information: z.string().optional(),
  api_id: z.string().optional(),
  hidden: z.number().int().min(0).max(1).optional(),
  fired: z.number().int().min(0).max(1).optional(),
  user_id: z.number().int().optional(),
});

const DeleteStaffSchema = z.object({
  company_id: z.number().int().positive(),
  staff_id: z.number().int().positive(),
});

// ========== Services CRUD Schemas ==========
const CreateServiceSchema = z.object({
  company_id: z.number().int().positive(),
  title: z.string().min(1),
  category_id: z.number().int().positive(),
  price_min: z.number().nonnegative().optional(),
  price_max: z.number().nonnegative().optional(),
  discount: z.number().nonnegative().optional(),
  comment: z.string().optional(),
  duration: z.number().positive().optional(),
  prepaid: z.string().optional(),
});

const UpdateServiceSchema = z.object({
  company_id: z.number().int().positive(),
  service_id: z.number().int().positive(),
  title: z.string().min(1).optional(),
  category_id: z.number().int().positive().optional(),
  price_min: z.number().nonnegative().optional(),
  price_max: z.number().nonnegative().optional(),
  discount: z.number().nonnegative().optional(),
  comment: z.string().optional(),
  duration: z.number().positive().optional(),
  active: z.number().int().min(0).max(1).optional(),
});

// ========== Positions CRUD Schemas ==========
const CreatePositionSchema = z.object({
  company_id: z.number().int().positive(),
  title: z.string().min(1),
  api_id: z.string().optional(),
});

const UpdatePositionSchema = z.object({
  company_id: z.number().int().positive(),
  position_id: z.number().int().positive(),
  title: z.string().min(1).optional(),
  api_id: z.string().optional(),
});

const DeletePositionSchema = z.object({
  company_id: z.number().int().positive(),
  position_id: z.number().int().positive(),
});

// ========== Bookings CRUD Schemas ==========
const CreateBookingSchema = z.object({
  company_id: z.number().int().positive(),
  staff_id: z.number().int().positive(),
  services: z.array(
    z.object({
      id: z.number().int().positive(),
      amount: z.number().positive().optional(),
    })
  ),
  datetime: z.string(),
  seance_length: z.number().positive().optional(),
  client: z.object({
    name: z.string().min(1),
    phone: z.string().min(1),
    email: z.string().email().optional(),
  }),
  comment: z.string().optional(),
  send_sms: z.number().int().min(0).max(1).optional(),
  attendance: z.number().int().optional(),
});

const UpdateBookingSchema = z.object({
  company_id: z.number().int().positive(),
  record_id: z.number().int().positive(),
  staff_id: z.number().int().positive().optional(),
  services: z
    .array(
      z.object({
        id: z.number().int().positive(),
        amount: z.number().positive().optional(),
      })
    )
    .optional(),
  datetime: z.string().optional(),
  seance_length: z.number().positive().optional(),
  client: z
    .object({
      name: z.string().optional(),
      phone: z.string().optional(),
      email: z.string().email().optional(),
    })
    .optional(),
  comment: z.string().optional(),
  attendance: z.number().int().optional(),
});

const DeleteBookingSchema = z.object({
  company_id: z.number().int().positive(),
  record_id: z.number().int().positive(),
});

// ========== Schedule CRUD Schemas ==========
// Matches PUT /company/{location_id}/staff/schedule spec

const ScheduleSlotSchema = z.object({
  from: z.string().regex(/^\d{2}:\d{2}$/),
  to: z.string().regex(/^\d{2}:\d{2}$/),
});

const CreateScheduleSchema = z.object({
  company_id: z.number().int().positive(),
  staff_id: z.number().int().positive(),
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
  slots: z.array(ScheduleSlotSchema).min(1),
});

const UpdateScheduleSchema = z.object({
  company_id: z.number().int().positive(),
  staff_id: z.number().int().positive(),
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
  slots: z.array(ScheduleSlotSchema).min(1),
});

const DeleteScheduleSchema = z.object({
  company_id: z.number().int().positive(),
  staff_id: z.number().int().positive(),
  dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1),
});

export class ToolHandlers {
  constructor(private client: AltegioClient) {}

  async login(args: unknown) {
    return withErrorHandling('altegio_login', async () => {
      const params = LoginSchema.parse(args);
      const result = await this.client.login(params.email, params.password);

      return {
        content: [
          {
            type: 'text' as const,
            text: result.success
              ? 'Successfully logged in to Altegio'
              : `Login failed: ${result.error}`,
          },
        ],
        structuredContent: { success: result.success, ...(result.error && { error: result.error }) },
      };
    });
  }

  async logout() {
    return withErrorHandling('altegio_logout', async () => {
      await this.client.logout();

      return {
        content: [
          {
            type: 'text' as const,
            text: 'Successfully logged out from Altegio',
          },
        ],
      };
    });
  }

  async listCompanies(args?: unknown) {
    return withErrorHandling('list_companies', async () => {
      const params = args ? CompaniesParamsSchema.parse(args) : undefined;
      const companies = await this.client.getCompanies(params);

      const summary = `Found ${companies.length} ${companies.length === 1 ? 'company' : 'companies'}${params?.my === 1 ? ' (user companies)' : ''}:\n\n`;
      const companiesList = companies
        .map(
          (c, idx) =>
            `${idx + 1}. ID: ${c.id} - "${c.title || c.public_title}"\n   Address: ${c.address || 'N/A'}\n   Phone: ${c.phone || 'N/A'}`
        )
        .join('\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: summary + companiesList,
          },
        ],
        structuredContent: { items: companies, count: companies.length },
      };
    });
  }

  async getBookings(args: unknown) {
    return withErrorHandling('get_bookings', async () => {
      const params = BookingsParamsSchema.parse(args);
      const { company_id, ...listParams } = params;
      const bookings = await this.client.getBookings(
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
        content: [
          {
            type: 'text' as const,
            text: summary + bookingsList,
          },
        ],
        structuredContent: { items: bookings, count: bookings.length },
      };
    });
  }

  async getStaff(args: unknown) {
    return withErrorHandling('get_staff', async () => {
      const params = PublicListParamsSchema.parse(args);
      const { company_id, ...listParams } = params;
      const staff = await this.client.getStaff(
        company_id,
        Object.keys(listParams).length > 0 ? listParams : undefined
      );

      const summary = `Found ${staff.length} staff ${staff.length === 1 ? 'member' : 'members'} for company ${company_id}:\n\n`;
      const staffList = staff
        .map(
          (s, idx) =>
            `${idx + 1}. ID: ${s.id} - ${s.name}\n` +
            `   Specialization: ${s.specialization || 'N/A'}\n` +
            `   Rating: ${s.rating !== undefined ? s.rating : 'N/A'}${s.position?.title ? `\n   Position: ${s.position.title} (ID: ${s.position.id})` : ''}`
        )
        .join('\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: summary + staffList,
          },
        ],
        structuredContent: { items: staff, count: staff.length },
      };
    });
  }

  async getServices(args: unknown) {
    return withErrorHandling('get_services', async () => {
      const params = PublicListParamsSchema.parse(args);
      const { company_id, ...listParams } = params;
      const services = await this.client.getServices(
        company_id,
        Object.keys(listParams).length > 0 ? listParams : undefined
      );

      const summary = `Found ${services.length} ${services.length === 1 ? 'service' : 'services'} for company ${company_id}:\n\n`;
      const servicesList = services
        .map(
          (s, idx) =>
            `${idx + 1}. ID: ${s.id} - "${s.title}"\n` +
            `   Price: ${s.cost}${s.duration ? `\n   Duration: ${s.duration} min` : ''}${s.category_id ? `\n   Category ID: ${s.category_id}` : ''}`
        )
        .join('\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: summary + servicesList,
          },
        ],
        structuredContent: { items: services, count: services.length },
      };
    });
  }

  async getServiceCategories(args: unknown) {
    return withErrorHandling('get_service_categories', async () => {
      const params = z
        .object({
          company_id: z.number().int().positive(),
          category_id: z.number().int().min(0).optional().default(0),
          page: z.number().int().positive().optional(),
          count: z.number().int().positive().optional(),
        })
        .parse(args);
      const { company_id, category_id, ...listParams } = params;
      const categories = await this.client.getServiceCategories(
        company_id,
        category_id,
        Object.keys(listParams).length > 0 ? listParams : undefined
      );

      const summary = `Found ${categories.length} service ${categories.length === 1 ? 'category' : 'categories'} for company ${company_id}:\n\n`;
      const categoriesList = categories
        .map(
          (c, idx) =>
            `${idx + 1}. ID: ${c.id} - "${c.title}"${c.services ? `\n   Services count: ${c.services.length}` : ''}`
        )
        .join('\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: summary + categoriesList,
          },
        ],
        structuredContent: { items: categories, count: categories.length },
      };
    });
  }

  async getSchedule(args: unknown) {
    return withErrorHandling('get_schedule', async () => {
      const params = z
        .object({
          company_id: z.number().int().positive(),
          staff_id: z.number().int().positive(),
          start_date: z.string(),
          end_date: z.string(),
        })
        .parse(args);

      const schedule = await this.client.getSchedule(
        params.company_id,
        params.staff_id,
        params.start_date,
        params.end_date
      );

      const summary = `Found ${schedule.length} schedule ${schedule.length === 1 ? 'entry' : 'entries'} for staff ${params.staff_id}:\n\n`;
      const scheduleList = schedule
        .map(
          (s, idx) =>
            `${idx + 1}. ${s.date} at ${s.time} (${s.seance_length} min)`
        )
        .join('\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: summary + scheduleList,
          },
        ],
        structuredContent: { items: schedule, count: schedule.length },
      };
    });
  }

  // ========== Schedule CRUD Operations ==========

  async createSchedule(args: unknown) {
    return withErrorHandling('create_schedule', async () => {
      const params = CreateScheduleSchema.parse(args);

      const schedule = await this.client.setSchedule(params.company_id, {
        schedules_to_set: [
          {
            team_member_id: params.staff_id,
            dates: params.dates,
            slots: params.slots,
          },
        ],
      });

      const slotsStr = params.slots.map((s) => `${s.from}-${s.to}`).join(', ');
      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully created schedule for staff ${params.staff_id} on ${params.dates.join(', ')}:\nSlots: ${slotsStr}\nEntries returned: ${schedule.length}`,
          },
        ],
        structuredContent: { items: schedule, count: schedule.length },
      };
    });
  }

  async updateSchedule(args: unknown) {
    return withErrorHandling('update_schedule', async () => {
      const params = UpdateScheduleSchema.parse(args);

      const schedule = await this.client.setSchedule(params.company_id, {
        schedules_to_set: [
          {
            team_member_id: params.staff_id,
            dates: params.dates,
            slots: params.slots,
          },
        ],
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully updated schedule for staff ${params.staff_id} on ${params.dates.join(', ')}\nEntries returned: ${schedule.length}`,
          },
        ],
        structuredContent: { items: schedule, count: schedule.length },
      };
    });
  }

  async deleteSchedule(args: unknown) {
    return withErrorHandling('delete_schedule', async () => {
      const params = DeleteScheduleSchema.parse(args);

      await this.client.setSchedule(params.company_id, {
        schedules_to_delete: [
          {
            team_member_id: params.staff_id,
            dates: params.dates,
          },
        ],
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully deleted schedule for staff ${params.staff_id} on ${params.dates.join(', ')}`,
          },
        ],
      };
    });
  }

  // ========== Staff CRUD Operations ==========

  async createStaff(args: unknown) {
    return withErrorHandling('create_staff', async () => {
      const params = CreateStaffSchema.parse(args);
      const { company_id, ...staffData } = params;

      const staff = await this.client.createStaff(company_id, staffData);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully created staff member:\nID: ${staff.id}\nName: ${staff.name}\nSpecialization: ${staff.specialization}`,
          },
        ],
        structuredContent: { id: staff.id, name: staff.name, specialization: staff.specialization },
      };
    });
  }

  async updateStaff(args: unknown) {
    return withErrorHandling('update_staff', async () => {
      const params = UpdateStaffSchema.parse(args);
      const { company_id, staff_id, ...updateData } = params;

      const staff = await this.client.updateStaff(
        company_id,
        staff_id,
        updateData
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully updated staff member ${staff_id}:\nName: ${staff.name}\nSpecialization: ${staff.specialization}`,
          },
        ],
        structuredContent: { id: staff.id, name: staff.name, specialization: staff.specialization },
      };
    });
  }

  async deleteStaff(args: unknown) {
    return withErrorHandling('delete_staff', async () => {
      const params = DeleteStaffSchema.parse(args);

      await this.client.deleteStaff(params.company_id, params.staff_id);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully deleted staff member ${params.staff_id} from company ${params.company_id}`,
          },
        ],
      };
    });
  }

  // ========== Services CRUD Operations ==========

  async createService(args: unknown) {
    return withErrorHandling('create_service', async () => {
      const params = CreateServiceSchema.parse(args);
      const { company_id, ...serviceData } = params;

      const service = await this.client.createService(company_id, serviceData);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully created service:\nID: ${service.id}\nTitle: ${service.title}\nCategory: ${service.category_id}`,
          },
        ],
        structuredContent: { id: service.id, title: service.title, category_id: service.category_id },
      };
    });
  }

  async updateService(args: unknown) {
    return withErrorHandling('update_service', async () => {
      const params = UpdateServiceSchema.parse(args);
      const { company_id, service_id, ...updateData } = params;

      const service = await this.client.updateService(
        company_id,
        service_id,
        updateData
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully updated service ${service_id}:\nTitle: ${service.title}`,
          },
        ],
        structuredContent: { id: service.id, title: service.title, category_id: service.category_id },
      };
    });
  }

  // ========== Positions CRUD Operations ==========

  async getPositions(args: unknown) {
    return withErrorHandling('get_positions', async () => {
      const params = z
        .object({
          company_id: z.number().int().positive(),
        })
        .parse(args);

      const positions = await this.client.getPositions(params.company_id);

      if (!positions || positions.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No positions found for this company.',
            },
          ],
          structuredContent: { items: [], count: 0 },
        };
      }

      const positionsList = positions
        .map((p, idx) => `${idx + 1}. ${p.title} (ID: ${p.id})`)
        .join('\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${positions.length} position(s):\n\n${positionsList}`,
          },
        ],
        structuredContent: { items: positions, count: positions.length },
      };
    });
  }

  async createPosition(args: unknown) {
    return withErrorHandling('create_position', async () => {
      const params = CreatePositionSchema.parse(args);
      const { company_id, ...positionData } = params;

      const position = await this.client.createPosition(
        company_id,
        positionData
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully created position:\nID: ${position.id}\nTitle: ${position.title}`,
          },
        ],
        structuredContent: { id: position.id, title: position.title },
      };
    });
  }

  async updatePosition(args: unknown) {
    return withErrorHandling('update_position', async () => {
      const params = UpdatePositionSchema.parse(args);
      const { company_id, position_id, ...updateData } = params;

      const position = await this.client.updatePosition(
        company_id,
        position_id,
        updateData
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully updated position ${position_id}:\nTitle: ${position.title}`,
          },
        ],
        structuredContent: { id: position.id, title: position.title },
      };
    });
  }

  async deletePosition(args: unknown) {
    return withErrorHandling('delete_position', async () => {
      const params = DeletePositionSchema.parse(args);

      await this.client.deletePosition(params.company_id, params.position_id);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully deleted position ${params.position_id}`,
          },
        ],
      };
    });
  }

  // ========== Bookings CRUD Operations ==========

  async createBooking(args: unknown) {
    return withErrorHandling('create_booking', async () => {
      const params = CreateBookingSchema.parse(args);
      const { company_id, ...bookingData } = params;

      const booking = await this.client.createBooking(company_id, bookingData);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully created booking:\nID: ${booking.id}\nStaff ID: ${booking.staff_id}\nDate: ${booking.datetime || booking.date}`,
          },
        ],
        structuredContent: { id: booking.id, staff_id: booking.staff_id, datetime: booking.datetime, date: booking.date },
      };
    });
  }

  async updateBooking(args: unknown) {
    return withErrorHandling('update_booking', async () => {
      const params = UpdateBookingSchema.parse(args);
      const { company_id, record_id, ...updateData } = params;

      const booking = await this.client.updateBooking(
        company_id,
        record_id,
        updateData
      );

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully updated booking ${record_id}:\nDate: ${booking.datetime || booking.date}`,
          },
        ],
        structuredContent: { id: booking.id, staff_id: booking.staff_id, datetime: booking.datetime, date: booking.date },
      };
    });
  }

  async deleteBooking(args: unknown) {
    return withErrorHandling('delete_booking', async () => {
      const params = DeleteBookingSchema.parse(args);

      await this.client.deleteBooking(params.company_id, params.record_id);

      return {
        content: [
          {
            type: 'text' as const,
            text: `Successfully deleted booking ${params.record_id} from company ${params.company_id}`,
          },
        ],
      };
    });
  }
}
