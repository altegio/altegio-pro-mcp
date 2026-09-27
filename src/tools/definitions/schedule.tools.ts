import { z } from 'zod';
import { defineTool } from '../factory.js';
import { scheduleOutput, scheduleWriteOutput } from '../output-schemas.js';
import { completeCollection } from '../pagination.js';
import type { AltegioScheduleEntry } from '../../types/altegio.types.js';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function projectEntry(entry: AltegioScheduleEntry) {
  const slots = entry.slots ?? [];
  return {
    date: entry.date,
    slots,
    is_working:
      entry.is_working === undefined
        ? slots.length > 0
        : Boolean(entry.is_working),
  };
}

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
  name: 'schedules_get',
  category: 'Schedule',
  description:
    "Read a team member's work schedule for a date range: one entry per day with its working intervals and whether it is a working day. The range is returned whole; keep it to a few weeks.",
  annotations: {
    title: 'Get Schedule',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    team_member_id: z.number().int().positive().describe('Team member ID'),
    date_from: dateSchema.describe('First day of the range, YYYY-MM-DD'),
    date_to: dateSchema.describe('Last day of the range, YYYY-MM-DD'),
  }),
  outputSchema: scheduleOutput,
  handler: async ({ input, client }) => {
    const schedule = await client.getSchedule(
      input.location_id,
      input.team_member_id,
      input.date_from,
      input.date_to
    );
    const entries = schedule.map(projectEntry);

    const describe = (entry: (typeof entries)[number]): string =>
      entry.slots.length > 0
        ? entry.slots.map((slot) => `${slot.from}-${slot.to}`).join(', ')
        : 'day off';
    const summary = `${entries.length} schedule ${entries.length === 1 ? 'entry' : 'entries'} for team member ${input.team_member_id}, ${input.date_from} to ${input.date_to}:\n\n`;
    const scheduleList = entries
      .map((entry, idx) => `${idx + 1}. ${entry.date} ${describe(entry)}`)
      .join('\n');

    return {
      text: summary + scheduleList,
      structuredContent: {
        team_member_id: input.team_member_id,
        date_from: input.date_from,
        date_to: input.date_to,
        ...completeCollection(entries),
      },
    };
  },
});

export const createScheduleTool = defineTool({
  name: 'schedules_create',
  category: 'Schedule',
  description:
    "Set a team member's working hours: the given intervals apply to every listed date. Use it to open the booking grid for new dates.",
  annotations: {
    title: 'Create Schedule',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    team_member_id: z.number().int().positive().describe('Team member ID'),
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
  outputSchema: scheduleWriteOutput,
  handler: async ({ input, client }) => {
    const schedule = await client.setSchedule(input.location_id, {
      schedules_to_set: [
        {
          team_member_id: input.team_member_id,
          dates: input.dates,
          slots: input.slots,
        },
      ],
    });
    const entries = schedule.map(projectEntry);
    const slotsStr = input.slots.map((s) => `${s.from}-${s.to}`).join(', ');
    return {
      text: `Set the schedule of team member ${input.team_member_id} on ${input.dates.join(', ')} to ${slotsStr}; ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} returned.`,
      structuredContent: {
        team_member_id: input.team_member_id,
        dates: input.dates,
        slots: input.slots,
        entries,
      },
    };
  },
});

export const updateScheduleTool = defineTool({
  name: 'schedules_update',
  category: 'Schedule',
  description:
    "Replace a team member's working hours on the given dates with new intervals.",
  annotations: {
    title: 'Update Schedule',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    team_member_id: z.number().int().positive().describe('Team member ID'),
    dates: z
      .array(dateSchema)
      .min(1)
      .describe('Dates to update schedule for (YYYY-MM-DD format)'),
    slots: z
      .array(slotSchema)
      .min(1)
      .describe('New working time intervals for each date'),
  }),
  outputSchema: scheduleWriteOutput,
  handler: async ({ input, client }) => {
    const schedule = await client.setSchedule(input.location_id, {
      schedules_to_set: [
        {
          team_member_id: input.team_member_id,
          dates: input.dates,
          slots: input.slots,
        },
      ],
    });
    const entries = schedule.map(projectEntry);
    return {
      text: `Updated the schedule of team member ${input.team_member_id} on ${input.dates.join(', ')}; ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} returned.`,
      structuredContent: {
        team_member_id: input.team_member_id,
        dates: input.dates,
        slots: input.slots,
        entries,
      },
    };
  },
});

export const deleteScheduleTool = defineTool({
  name: 'schedules_delete',
  category: 'Schedule',
  description:
    'Make the given dates non-working days for a team member by deleting their schedule there. Asks for confirmation first.',
  annotations: {
    title: 'Delete Schedule',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    team_member_id: z.number().int().positive().describe('Team member ID'),
    dates: z
      .array(dateSchema)
      .min(1)
      .describe('Dates to delete schedule for (YYYY-MM-DD format)'),
  }),
  confirm: {
    action: 'Delete work schedule',
    target: (input) =>
      `${input.dates.length} day(s) (${input.dates.join(', ')}) for team member ${input.team_member_id} at location ${input.location_id}`,
    resolve: async (input, client) => {
      const member = (await client.getStaff(input.location_id)).find(
        (candidate) => candidate.id === input.team_member_id
      );
      if (!member) return undefined;
      return `${input.dates.length} day(s) (${input.dates.join(', ')}) for ${member.name}, id ${member.id}, at location ${input.location_id}`;
    },
    consequence:
      'Those dates become non-working days: the slots stop being offered for booking, online and in the calendar. Appointments already booked on them are not deleted and stay in the calendar without a matching shift.',
  },
  handler: async ({ input, client }) => {
    await client.setSchedule(input.location_id, {
      schedules_to_delete: [
        {
          team_member_id: input.team_member_id,
          dates: input.dates,
        },
      ],
    });

    return {
      text: `Deleted the schedule of team member ${input.team_member_id} on ${input.dates.join(', ')}.`,
    };
  },
});
