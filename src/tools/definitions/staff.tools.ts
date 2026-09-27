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

export const getStaffTool = defineTool({
  name: 'team_members_list',
  category: 'Team members',
  description:
    'List the team members of a location with their position, rating, online-booking visibility and dismissal state. Paged and ordered by id: 25 per page by default; pagination.total is exact and pagination.next_page is null on the last page.',
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
    'Create a team member. Required: name, specialization, position_id, has_paid_seat and has_schedule_access. Ask the location owner for has_paid_seat and has_schedule_access and never choose them yourself: on per-seat licensing a paid seat is billed, and only a paid team member can be in the work schedule. A team member needs has_schedule_access=true to get working hours or appointments. Omit user_email and user_phone to create a team member without a user account; pass them to link an existing Altegio user, or add invite_user=true to invite that person (the API refuses an unknown email or phone without an invitation). This call stores no contact phone for the team member.',
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
      .describe(
        'Email of an existing Altegio user to link, or of the person to invite with invite_user=true. Omit for a team member without a user account.'
      ),
    user_phone: z
      .string()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Phone of an existing Altegio user to link (without +, 9-15 digits), or of the person to invite. Omit for a team member without a user account.'
      ),
    invite_user: z
      .boolean()
      .optional()
      .describe(
        'Invite user_email/user_phone to create their user account (default false). Without it, they must belong to an existing Altegio user.'
      ),
    has_schedule_access: scheduleAccessChoice.describe(
      "The owner's answer: should the team member be in the work schedule, able to have working hours and take appointments? Locations on the new team-member model refuse a schedule or appointments without it; per-seat licensing allows it only with has_paid_seat=true. Never defaulted."
    ),
    has_paid_seat: paidSeatChoice.describe(
      "The owner's answer: does the team member take a paid seat? On per-seat licensing a paid seat is billed and counts against the location's team member limit; false creates a team member without a seat (for example test or demo data). Ignored by locations without per-seat licensing. Never defaulted."
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
    return {
      text: withUntrustedBlock(
        `Created team member ${staff.id}.`,
        [
          { label: 'name', value: staff.name },
          { label: 'specialization', value: staff.specialization },
        ]
      ),
      structuredContent: {
        id: staff.id,
        name: sanitizeUntrusted(staff.name) ?? undefined,
        specialization: sanitizeUntrusted(staff.specialization) ?? undefined,
      },
    };
  },
});

export const updateStaffTool = defineTool({
  name: 'team_members_update',
  category: 'Team members',
  description:
    'Update a team member: name, specialization, profile text, display order, online-booking visibility, dismissal state, external id or linked user. Pass only the fields to change.',
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
    sort_weight: z
      .number()
      .optional()
      .describe('Display order weight; a higher value sorts first'),
    information: z
      .string()
      .optional()
      .describe('Profile text shown in online booking (HTML allowed)'),
    external_id: z
      .string()
      .optional()
      .describe("The team member's identifier in an external system"),
    hidden_from_online_booking: z
      .boolean()
      .optional()
      .describe('Hide the team member from online booking'),
    dismissed: z
      .boolean()
      .optional()
      .describe('Mark the team member as dismissed (no longer working here)'),
    user_id: z
      .number()
      .int()
      .optional()
      .describe('Linked Altegio user id; 0 unlinks the user account'),
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
