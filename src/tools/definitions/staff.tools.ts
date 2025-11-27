import { z } from 'zod';
import { defineTool } from '../factory.js';
import { formatStaffList } from '../formatters.js';

export const getStaffTool = defineTool({
  name: 'get_staff',
  category: 'Staff',
  description:
    '[Staff] Get list of staff members for a company. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    page: z.number().int().positive().optional().describe('Page number'),
    count: z.number().int().positive().optional().describe('Results per page'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, ...params } = input;
    const staff = await client.getStaff(company_id, params);
    return formatStaffList(staff, company_id);
  },
});

export const createStaffTool = defineTool({
  name: 'create_staff',
  category: 'Staff',
  description: '[Staff] Create a new employee/staff member. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    name: z.string().min(1).describe('Employee name'),
    specialization: z.string().min(1).describe('Employee specialization'),
    position_id: z.number().int().positive().nullable().describe('Position ID'),
    phone_number: z.string().nullable().describe('Phone number'),
    user_email: z.string().email().describe('User email'),
    user_phone: z.string().min(1).describe('User phone'),
    is_user_invite: z.boolean().describe('Send user invite'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, ...staffData } = input;
    const staff = await client.createStaff(company_id, staffData);
    return `Successfully created staff member:\nID: ${staff.id}\nName: ${staff.name}\nSpecialization: ${staff.specialization}`;
  },
});

export const updateStaffTool = defineTool({
  name: 'update_staff',
  category: 'Staff',
  description: '[Staff] Update existing staff member. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    staff_id: z.number().int().positive().describe('Staff member ID'),
    name: z.string().min(1).optional().describe('Employee name'),
    specialization: z.string().optional().describe('Specialization'),
    position_id: z.number().int().positive().nullable().optional().describe('Position ID'),
    phone_number: z.string().nullable().optional().describe('Phone number'),
    hidden: z.number().int().min(0).max(1).optional().describe('Hidden flag'),
    fired: z.number().int().min(0).max(1).optional().describe('Fired flag'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, staff_id, ...updateData } = input;
    const staff = await client.updateStaff(company_id, staff_id, updateData);
    return `Successfully updated staff member ${staff_id}:\nName: ${staff.name}\nSpecialization: ${staff.specialization}`;
  },
});

export const deleteStaffTool = defineTool({
  name: 'delete_staff',
  category: 'Staff',
  description: '[Staff] Delete/remove staff member. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    staff_id: z.number().int().positive().describe('Staff member ID'),
  }),

  handler: async ({ input, client }) => {
    await client.deleteStaff(input.company_id, input.staff_id);
    return `Successfully deleted staff member ${input.staff_id} from company ${input.company_id}`;
  },
});
