import { paginationInput, paginateCollection } from '../pagination.js';
import { z } from 'zod';
import { defineTool } from '../factory.js';
import {
  withUntrustedBlock,
  sanitizeUntrusted,
  type UntrustedField,
} from '../tool-result.js';
import { staffListOutput, staffEntityOutput } from '../output-schemas.js';
import { paidSeatChoice, scheduleAccessChoice } from '../staff-seat-choice.js';

/** A stored 0/1 or boolean flag; null when the response omits it. */
function readFlag(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 0 || value === 1) return value === 1;
  if (value === '0' || value === '1') return value === '1';
  return null;
}

export const getStaffTool = defineTool({
  name: 'team_members_list',
  category: 'Team members',
  description:
    'Team members of a location: position, rating, online-booking visibility, dismissal. Paged by id with exact total.',
  annotations: {
    title: 'List Team Members',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z
      .number()
      .int()
      .positive()
      .describe('ID of the location to list team members for'),
    ...paginationInput,
  }),
  outputSchema: staffListOutput,
  handler: async ({ input, client }) => {
    const { location_id } = input;
    const { items: staff, pagination } = paginateCollection(
      await client.getStaff(location_id),
      input
    );

    const lines = [
      `Found ${staff.length} team ${staff.length === 1 ? 'member' : 'members'} for location ${location_id}:`,
    ];
    // Names, specializations and position titles are free input typed at the
    // location, so they are fenced and keyed back by team-member id.
    const untrusted: UntrustedField[] = [];
    for (const member of staff) {
      lines.push(
        `- Team member ${member.id}: rating ${member.rating ?? 'not reported'}` +
          `${member.position?.id ? ` · position id ${member.position.id}` : ''}`
      );
      untrusted.push({
        label: `team member ${member.id} name`,
        value: member.name,
      });
      untrusted.push({
        label: `team member ${member.id} specialization`,
        value: member.specialization,
      });
      untrusted.push({
        label: `team member ${member.id} position`,
        value: member.position?.title,
      });
    }

    return {
      text: withUntrustedBlock(lines.join('\n'), untrusted, { maxChars: 200 }),
      structuredContent: {
        items: staff.map((s) => ({
          id: s.id,
          name: sanitizeUntrusted(s.name) ?? undefined,
          specialization: sanitizeUntrusted(s.specialization) ?? undefined,
          rating: s.rating,
          position_id: s.position?.id,
          position_title: sanitizeUntrusted(s.position?.title) ?? undefined,
          hidden_from_online_booking:
            s.hidden === undefined ? null : Boolean(s.hidden),
          dismissed: s.fired === undefined ? null : Boolean(s.fired),
        })),
        pagination,
      },
    };
  },
});

export const createStaffTool = defineTool({
  name: 'team_members_create',
  category: 'Team members',
  description:
    'Create a team member. Ask the owner for has_paid_seat and has_schedule_access, never choose them: a paid seat is billed on per-seat licensing, and only schedule access gives working hours and appointments. user_email/user_phone link an Altegio user (invite_user=true invites a new one); omit both for no account.',
  annotations: {
    title: 'Create Team Member',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    name: z.string().min(1).describe('Team member name'),
    specialization: z.string().min(1).describe('Specialization, e.g. Stylist'),
    position_id: z.number().int().positive().nullable().describe('Position ID'),
    user_email: z
      .string()
      .email()
      .nullable()
      .optional()
      .describe('Email of an Altegio user to link or invite.'),
    user_phone: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Phone of an Altegio user to link or invite, digits without +.'
      ),
    invite_user: z
      .boolean()
      .optional()
      .describe('Invite user_email/user_phone as a new user (default false).'),
    has_schedule_access: scheduleAccessChoice.describe(
      "Owner's answer: in the work schedule, can have hours and appointments (per-seat licensing needs has_paid_seat). Never defaulted."
    ),
    has_paid_seat: paidSeatChoice.describe(
      "Owner's answer: takes a paid seat (billed and counted on per-seat licensing; false e.g. for demo data). Never defaulted."
    ),
  }),
  outputSchema: staffEntityOutput,
  handler: async ({ input, client }) => {
    const {
      location_id,
      invite_user,
      has_schedule_access,
      has_paid_seat,
      ...staffData
    } = input;
    // The API expects both user keys, null when no user is linked or invited.
    const staff = await client.createStaff(location_id, {
      ...staffData,
      user_email: staffData.user_email ?? null,
      user_phone: staffData.user_phone ?? null,
      is_user_invite: invite_user ?? false,
      has_timetable_access: has_schedule_access,
      is_paid_staff: has_paid_seat,
    });
    // Altegio applies the paid-seat flag only on per-seat licensing and
    // ignores it elsewhere, so report what was stored instead of echoing the
    // request.
    const paidSeat = readFlag(staff.is_paid_staff);
    const scheduleAccess = readFlag(staff.has_access_timetable);
    const notes: string[] = [];
    if (paidSeat !== null && paidSeat !== has_paid_seat) {
      notes.push(
        has_paid_seat
          ? 'has_paid_seat was not applied: the location is not on per-seat licensing, where Altegio ignores the paid-seat flag and stores false.'
          : 'Altegio stored a paid seat although has_paid_seat was false.'
      );
    }
    if (scheduleAccess !== null && scheduleAccess !== has_schedule_access) {
      notes.push(
        `has_schedule_access is stored as ${scheduleAccess}, not ${has_schedule_access} as requested.`
      );
    }
    return {
      text: withUntrustedBlock(
        [`Created team member ${staff.id}.`, ...notes].join(' '),
        [
          { label: 'name', value: staff.name },
          { label: 'specialization', value: staff.specialization },
        ]
      ),
      structuredContent: {
        id: staff.id,
        name: sanitizeUntrusted(staff.name) ?? undefined,
        specialization: sanitizeUntrusted(staff.specialization) ?? undefined,
        has_paid_seat: paidSeat,
        has_schedule_access: scheduleAccess,
        ...(notes.length > 0 ? { notes } : {}),
      },
    };
  },
});

export const updateStaffTool = defineTool({
  name: 'team_members_update',
  category: 'Team members',
  description:
    'Update a team member: name, specialization, profile, order, online-booking visibility, dismissal, external id or user. Pass only changes.',
  annotations: {
    title: 'Update Team Member',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    team_member_id: z.number().int().positive().describe('Team member ID'),
    name: z.string().min(1).optional().describe('Team member name'),
    specialization: z.string().optional().describe('Specialization'),
    sort_weight: z.number().optional().describe('Sort weight, higher first.'),
    information: z
      .string()
      .optional()
      .describe('Online booking profile (HTML).'),
    external_id: z.string().optional().describe('External system id.'),
    hidden_from_online_booking: z
      .boolean()
      .optional()
      .describe('Hide the team member from online booking'),
    dismissed: z
      .boolean()
      .optional()
      .describe('Dismissed (no longer working here).'),
    user_id: z
      .number()
      .int()
      .optional()
      .describe('Altegio user id; 0 unlinks.'),
  }),
  outputSchema: staffEntityOutput,
  handler: async ({ input, client }) => {
    const {
      location_id,
      team_member_id,
      sort_weight,
      external_id,
      hidden_from_online_booking,
      dismissed,
      ...updateData
    } = input;
    // The v1 endpoint refuses any update without `name` (422), although it
    // keeps every other omitted field. Send the stored name so a partial update
    // stays partial.
    if (updateData.name === undefined) {
      const current = (await client.getStaff(location_id)).find(
        (member) => member.id === team_member_id
      );
      if (!current?.name) {
        throw new Error(
          `Team member ${team_member_id} was not found at location ${location_id}; check the id with team_members_list, or pass name.`
        );
      }
      updateData.name = current.name;
    }
    // Canonical names at the boundary; V1 field names and 0/1 flags on the wire.
    const staff = await client.updateStaff(location_id, team_member_id, {
      ...updateData,
      ...(sort_weight !== undefined ? { weight: sort_weight } : {}),
      ...(external_id !== undefined ? { api_id: external_id } : {}),
      ...(hidden_from_online_booking !== undefined
        ? { hidden: hidden_from_online_booking ? 1 : 0 }
        : {}),
      ...(dismissed !== undefined ? { fired: dismissed ? 1 : 0 } : {}),
    });
    return {
      // A partial update reads back fields this call never sent, so the name
      // and specialization here may be someone else's text, not the caller's.
      text: withUntrustedBlock(
        `Updated team member ${team_member_id}. Name and specialization as stored are below.`,
        [
          { label: 'name', value: staff.name },
          { label: 'specialization', value: staff.specialization },
        ],
        { maxChars: 200 }
      ),
      structuredContent: {
        id: staff.id,
        name: sanitizeUntrusted(staff.name) ?? undefined,
        specialization: sanitizeUntrusted(staff.specialization) ?? undefined,
      },
    };
  },
});

export const deleteStaffTool = defineTool({
  name: 'team_members_delete',
  category: 'Team members',
  description:
    'Remove a team member from the location, with their schedule and service links. Asks for confirmation first.',
  annotations: {
    title: 'Delete Team Member',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    team_member_id: z
      .number()
      .int()
      .positive()
      .describe('Team member ID to delete'),
  }),
  confirm: {
    action: 'Delete team member',
    target: (input) =>
      `team member ${input.team_member_id} at location ${input.location_id}`,
    resolve: async (input, client) => {
      const member = (await client.getStaff(input.location_id)).find(
        (candidate) => candidate.id === input.team_member_id
      );
      if (!member) return undefined;
      const position = member.position?.title
        ? `, ${member.position.title}`
        : '';
      return `team member ${member.name}${position}, id ${member.id}, at location ${input.location_id}`;
    },
    consequence:
      'They are removed from the location together with their work schedule and every service they were linked to, so they disappear from the booking grid and can no longer be booked. Appointments already in the calendar keep their record of who served the client. This cannot be undone through this server.',
  },
  handler: async ({ input, client }) => {
    await client.deleteStaff(input.location_id, input.team_member_id);
    return {
      text: `Deleted team member ${input.team_member_id} from location ${input.location_id}.`,
    };
  },
});
