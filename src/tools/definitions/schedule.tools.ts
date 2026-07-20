import { z } from 'zod';
import { defineTool } from '../factory.js';
import { scheduleOutput, scheduleEntityOutput } from '../output-schemas.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const slotSchema = z.object({
  from: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .describe('Start time (HH:MM format, e.g., "09:00")'),
  to: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .describe('End time (HH:MM format, e.g., "18:00")'),
});

export const getScheduleTool = defineTool({
  name: 'get_schedule',
  category: 'Schedule',
  description:
    '[Schedule] Get employee schedule for a date range. AUTHENTICATION REQUIRED - administrative access to view staff working schedule. User must be logged in and have access to the company. Returns schedule entries with dates, times, and session lengths.',
  annotations: {
    title: 'Get Schedule',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    company_id: z.number().int().positive().describe('ID of the company'),
    staff_id: z.number().int().positive().describe('ID of the staff member'),
    start_date: z.string().describe('Start date (YYYY-MM-DD format)'),
    end_date: z.string().describe('End date (YYYY-MM-DD format)'),
  }),
  outputSchema: scheduleOutput,
  handler: async ({ input, client }) => {
    const schedule = await client.getSchedule(
      input.company_id,
      input.staff_id,
      input.start_date,
      input.end_date
    );

    const summary = `Found ${schedule.length} schedule ${schedule.length === 1 ? 'entry' : 'entries'} for staff ${input.staff_id}:\n\n`;
    const scheduleList = schedule
      .map(
        (s, idx) =>
          `${idx + 1}. ${s.date} at ${s.time} (${s.seance_length} min)`
      )
      .join('\n');

    return {
      text: summary + scheduleList,
      structuredContent: { items: schedule, count: schedule.length },
    };
  },
});

export const createScheduleTool = defineTool({
  name: 'create_schedule',
  category: 'Schedule',
  description:
    '[Schedule] Create employee work schedule. AUTHENTICATION REQUIRED - administrative access to create staff working schedule. Defines when an employee is available to work (e.g., "Monday 9:00-18:00"). Use this to set up or modify work hours.',
  annotations: {
    title: 'Create Schedule',
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    company_id: z.number().int().positive().describe('ID of the company'),
    staff_id: z.number().int().positive().describe('ID of the staff member'),
    dates: z
      .array(dateSchema)
      .min(1)
      .describe(
        'Dates for the schedule (YYYY-MM-DD format). Can set multiple dates at once.'
      ),
    slots: z
      .array(slotSchema)
      .min(1)
      .describe('Working time intervals for each date'),
  }),
  outputSchema: scheduleEntityOutput,
  handler: async ({ input, client }) => {
    const schedule = await client.setSchedule(input.company_id, {
      schedules_to_set: [
        {
          team_member_id: input.staff_id,
          dates: input.dates,
          slots: input.slots,
        },
      ],
    });

    const slotsStr = input.slots.map((s) => `${s.from}-${s.to}`).join(', ');
    return {
      text: `Successfully created schedule for staff ${input.staff_id} on ${input.dates.join(', ')}:\nSlots: ${slotsStr}\nEntries returned: ${schedule.length}`,
      structuredContent: { items: schedule, count: schedule.length },
    };
  },
});

export const updateScheduleTool = defineTool({
  name: 'update_schedule',
  category: 'Schedule',
  description:
    '[Schedule] Update employee work schedule. AUTHENTICATION REQUIRED - administrative access to modify staff working schedule. Replaces work hours for specified dates.',
  annotations: {
    title: 'Update Schedule',
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    company_id: z.number().int().positive().describe('ID of the company'),
    staff_id: z.number().int().positive().describe('ID of the staff member'),
    dates: z
      .array(dateSchema)
      .min(1)
      .describe('Dates to update schedule for (YYYY-MM-DD format)'),
    slots: z
      .array(slotSchema)
      .min(1)
      .describe('New working time intervals for each date'),
  }),
  outputSchema: scheduleEntityOutput,
  handler: async ({ input, client }) => {
    const schedule = await client.setSchedule(input.company_id, {
      schedules_to_set: [
        {
          team_member_id: input.staff_id,
          dates: input.dates,
          slots: input.slots,
        },
      ],
    });

    return {
      text: `Successfully updated schedule for staff ${input.staff_id} on ${input.dates.join(', ')}\nEntries returned: ${schedule.length}`,
      structuredContent: { items: schedule, count: schedule.length },
    };
  },
});

export const deleteScheduleTool = defineTool({
  name: 'delete_schedule',
  category: 'Schedule',
  description:
    '[Schedule] Delete employee work schedule for specified dates. AUTHENTICATION REQUIRED - administrative access to remove staff working schedule. Makes the specified dates non-working days.',
  annotations: {
    title: 'Delete Schedule',
    destructiveHint: true,
    openWorldHint: true,
  },
  input: z.object({
    company_id: z.number().int().positive().describe('ID of the company'),
    staff_id: z.number().int().positive().describe('ID of the staff member'),
    dates: z
      .array(dateSchema)
      .min(1)
      .describe('Dates to delete schedule for (YYYY-MM-DD format)'),
  }),
  handler: async ({ input, client }) => {
    await client.setSchedule(input.company_id, {
      schedules_to_delete: [
        {
          team_member_id: input.staff_id,
          dates: input.dates,
        },
      ],
    });

    return {
      text: `Successfully deleted schedule for staff ${input.staff_id} on ${input.dates.join(', ')}`,
    };
  },
});
