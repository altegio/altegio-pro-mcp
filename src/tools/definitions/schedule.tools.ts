import { z } from 'zod';
import { defineTool } from '../factory.js';
import { formatScheduleList } from '../formatters.js';

export const getScheduleTool = defineTool({
  name: 'get_schedule',
  category: 'Schedule',
  description:
    '[Schedule] Get work schedule for a staff member. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    staff_id: z.number().int().positive().describe('Staff member ID'),
    start_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Start date (YYYY-MM-DD)'),
    end_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('End date (YYYY-MM-DD)'),
  }),

  handler: async ({ input, client }) => {
    const schedule = await client.getSchedule(
      input.company_id,
      input.staff_id,
      input.start_date,
      input.end_date
    );
    return formatScheduleList(schedule, input.staff_id);
  },
});

export const createScheduleTool = defineTool({
  name: 'create_schedule',
  category: 'Schedule',
  description:
    '[Schedule] Create work schedule for a staff member. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    staff_id: z.number().int().positive().describe('Staff member ID'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Schedule date (YYYY-MM-DD)'),
    time_from: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .describe('Start time (HH:MM)'),
    time_to: z.string().regex(/^\d{2}:\d{2}$/).describe('End time (HH:MM)'),
    seance_length: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Seance length in minutes'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, ...scheduleData } = input;
    const schedule = await client.createSchedule(company_id, scheduleData);
    return `Successfully created schedule for staff ${input.staff_id} on ${input.date}:\nTime: ${input.time_from} - ${input.time_to}\nEntries created: ${schedule.length}`;
  },
});

export const updateScheduleTool = defineTool({
  name: 'update_schedule',
  category: 'Schedule',
  description:
    '[Schedule] Update work schedule for a staff member. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    staff_id: z.number().int().positive().describe('Staff member ID'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Schedule date (YYYY-MM-DD)'),
    time_from: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional()
      .describe('Start time (HH:MM)'),
    time_to: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional()
      .describe('End time (HH:MM)'),
    seance_length: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Seance length in minutes'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, ...scheduleData } = input;
    const schedule = await client.updateSchedule(company_id, scheduleData);
    return `Successfully updated schedule for staff ${input.staff_id} on ${input.date}\nEntries updated: ${schedule.length}`;
  },
});

export const deleteScheduleTool = defineTool({
  name: 'delete_schedule',
  category: 'Schedule',
  description:
    '[Schedule] Delete work schedule for a staff member. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    staff_id: z.number().int().positive().describe('Staff member ID'),
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe('Schedule date (YYYY-MM-DD)'),
  }),

  handler: async ({ input, client }) => {
    await client.deleteSchedule(
      input.company_id,
      input.staff_id,
      input.date
    );
    return `Successfully deleted schedule for staff ${input.staff_id} on ${input.date}`;
  },
});
