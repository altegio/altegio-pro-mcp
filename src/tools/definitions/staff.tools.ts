import { z } from 'zod';
import { defineTool } from '../factory.js';
import { withUntrustedBlock, type UntrustedField } from '../tool-result.js';
import { staffListOutput, staffEntityOutput } from '../output-schemas.js';

export const getStaffTool = defineTool({
  name: 'get_staff',
  category: 'Staff',
  description:
    '[Staff] Get list of staff members for a location. AUTHENTICATION REQUIRED - administrative access to view all staff with full details (not just public online-booking info). User must be logged in and have access to the location. PAGINATION STRATEGY: May return many staff (100+). RECOMMENDED: Start with count=30-50 to show initial options. User can browse and request more if needed. This saves context for large salons.',
  annotations: {
    title: 'Get Staff',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z
      .number()
      .int()
      .positive()
      .describe('ID of the location to get staff list for'),
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        '1-based page number for pagination (default 1). Use 2 for the next page.'
      ),
    count: z
      .number()
      .int()
      .positive()
      .max(300)
      .optional()
      .describe(
        'Results per page. Default may be large. RECOMMENDED: Use 30-50 for initial display. Max 300.'
      ),
  }),
  outputSchema: staffListOutput,
  handler: async ({ input, client }) => {
    const { location_id, ...listParams } = input;
    const staff = await client.getStaff(
      location_id,
      Object.keys(listParams).length > 0 ? listParams : undefined
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
          name: s.name,
          specialization: s.specialization,
          rating: s.rating,
          position_id: s.position?.id,
          position_title: s.position?.title,
          hidden: s.hidden,
          fired: s.fired,
        })),
        count: staff.length,
      },
    };
  },
});

export const createStaffTool = defineTool({
  name: 'create_staff',
  category: 'Staff',
  description:
    '[Staff] Create a new staff member. AUTHENTICATION REQUIRED. Required fields: name, specialization, position_id, phone_number, user_email, user_phone, is_user_invite. Set is_paid_staff=false to create test/demo staff without consuming a paid-staff license seat.',
  annotations: {
    title: 'Create Staff Member',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    name: z.string().min(1).describe('Staff member name'),
    specialization: z.string().min(1).describe('Staff member specialization'),
    position_id: z.number().int().positive().nullable().describe('Position ID'),
    phone_number: z
      .string()
      .nullable()
      .describe('Phone number (without +, 9-15 digits)'),
    user_email: z.string().email().describe('User email address'),
    user_phone: z.string().min(1).describe('User phone number'),
    is_user_invite: z.boolean().describe('User invitation flag'),
    is_paid_staff: z
      .boolean()
      .optional()
      .describe(
        'Whether this team member counts against the paid-staff license cap. Omit or set false to create test/demo staff without consuming a seat.'
      ),
  }),
  outputSchema: staffEntityOutput,
  handler: async ({ input, client }) => {
    const { location_id, ...staffData } = input;
    const staff = await client.createStaff(location_id, staffData);
    return {
      text: `Successfully created staff member:\nID: ${staff.id}\nName: ${staff.name}\nSpecialization: ${staff.specialization}`,
      structuredContent: {
        id: staff.id,
        name: staff.name,
        specialization: staff.specialization,
      },
    };
  },
});

export const updateStaffTool = defineTool({
  name: 'update_staff',
  category: 'Staff',
  description:
    '[Staff] Update existing staff member. AUTHENTICATION REQUIRED. Provide only fields to update.',
  annotations: {
    title: 'Update Staff Member',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    team_member_id: z.number().int().positive().describe('Team member ID'),
    name: z.string().min(1).optional().describe('Staff member name'),
    specialization: z
      .string()
      .optional()
      .describe('Staff member specialization'),
    weight: z
      .number()
      .optional()
      .describe('Display order weight (higher = first)'),
    information: z
      .string()
      .optional()
      .describe('Staff member info (HTML format)'),
    api_id: z.string().optional().describe('External API ID'),
    hidden: z
      .number()
      .int()
      .min(0)
      .max(1)
      .optional()
      .describe('Hidden from online booking (0 or 1)'),
    fired: z
      .number()
      .int()
      .min(0)
      .max(1)
      .optional()
      .describe('Dismissed status (0 or 1)'),
    user_id: z
      .number()
      .int()
      .optional()
      .describe('Linked user ID (0 to unlink)'),
  }),
  outputSchema: staffEntityOutput,
  handler: async ({ input, client }) => {
    const { location_id, team_member_id, ...updateData } = input;
    const staff = await client.updateStaff(
      location_id,
      team_member_id,
      updateData
    );
    return {
      // A partial update reads back fields this call never sent, so the name
      // and specialization here may be someone else's text, not the caller's.
      text: withUntrustedBlock(
        `Successfully updated staff member ${team_member_id}. Name and specialization as stored are below.`,
        [
          { label: 'name', value: staff.name },
          { label: 'specialization', value: staff.specialization },
        ],
        { maxChars: 200 }
      ),
      structuredContent: {
        id: staff.id,
        name: staff.name,
        specialization: staff.specialization,
      },
    };
  },
});

export const deleteStaffTool = defineTool({
  name: 'delete_staff',
  category: 'Staff',
  description: '[Staff] Delete/remove staff member. AUTHENTICATION REQUIRED.',
  annotations: {
    title: 'Delete Staff Member',
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
      text: `Successfully deleted staff member ${input.team_member_id} from location ${input.location_id}`,
    };
  },
});
