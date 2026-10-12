import { z } from 'zod';
import { defineTool } from '../factory.js';
import { windowPaginationOutput } from '../pagination.js';
import {
  findFreeSlots,
  MAX_RANGE_DAYS,
} from '../../capabilities/availability/use-cases.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const windowSchema = {
  type: 'object' as const,
  properties: {
    team_member_id: { type: 'integer' as const },
    date: { type: 'string' as const },
    free_from: { type: 'string' as const },
    free_to: { type: 'string' as const },
    first_start: { type: 'string' as const },
    last_start: { type: 'string' as const },
    step_minutes: { type: 'integer' as const },
    session_length_seconds: { type: 'integer' as const },
  },
  required: [
    'team_member_id',
    'date',
    'first_start',
    'last_start',
    'session_length_seconds',
  ],
};

export const findFreeSlotsTool = defineTool({
  name: 'appointments_find_free_slots',
  category: 'Appointments',
  description:
    `Find when an appointment fits before creating it: free start times for the given services, per team member linked to all of them, from the appointment calendar. Up to ${MAX_RANGE_DAYS} days per call; omit team_member_id to search every linked team member. ` +
    'Each window gives first_start..last_start (location time) and the session length to pass to appointments_create.',
  annotations: {
    title: 'Find Free Appointment Times',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    service_ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(5)
      .describe('Service ids of the appointment.'),
    date_from: isoDate.describe('First day to search, YYYY-MM-DD.'),
    date_to: isoDate
      .optional()
      .describe(
        `Last day to search, YYYY-MM-DD; default date_from, at most ${MAX_RANGE_DAYS} days in all.`
      ),
    team_member_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Only this team member.'),
  }),
  outputSchema: {
    type: 'object' as const,
    properties: {
      location_id: { type: 'integer' as const },
      service_ids: {
        type: 'array' as const,
        items: { type: 'integer' as const },
      },
      date_from: { type: 'string' as const },
      date_to: { type: 'string' as const },
      team_members: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            team_member_id: { type: 'integer' as const },
            session_length_seconds: { type: 'integer' as const },
          },
          required: ['team_member_id', 'session_length_seconds'],
        },
      },
      items: { type: 'array' as const, items: windowSchema },
      pagination: windowPaginationOutput,
    },
    required: ['items', 'pagination'],
  },
  handler: async ({ input, client }) => findFreeSlots(client, input),
});
