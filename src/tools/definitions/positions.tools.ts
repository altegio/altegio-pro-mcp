import { z } from 'zod';
import { defineTool } from '../factory.js';
import { formatPositionsList } from '../formatters.js';

export const getPositionsTool = defineTool({
  name: 'get_positions',
  category: 'Positions',
  description:
    '[Positions] Get list of staff positions/roles for a company. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
  }),

  handler: async ({ input, client }) => {
    const positions = await client.getPositions(input.company_id);
    return formatPositionsList(positions);
  },
});

export const createPositionTool = defineTool({
  name: 'create_position',
  category: 'Positions',
  description:
    '[Positions] Create a new staff position/role. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    title: z.string().min(1).describe('Position title'),
    api_id: z.string().optional().describe('External API identifier'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, ...positionData } = input;
    const position = await client.createPosition(company_id, positionData);
    return `Successfully created position:\nID: ${position.id}\nTitle: ${position.title}`;
  },
});

export const updatePositionTool = defineTool({
  name: 'update_position',
  category: 'Positions',
  description: '[Positions] Update existing position. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    position_id: z.number().int().positive().describe('Position ID'),
    title: z.string().min(1).optional().describe('Position title'),
    api_id: z.string().optional().describe('External API identifier'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, position_id, ...updateData } = input;
    const position = await client.updatePosition(
      company_id,
      position_id,
      updateData
    );
    return `Successfully updated position ${position_id}:\nTitle: ${position.title}`;
  },
});

export const deletePositionTool = defineTool({
  name: 'delete_position',
  category: 'Positions',
  description:
    '[Positions] Delete/remove position. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    position_id: z.number().int().positive().describe('Position ID'),
  }),

  handler: async ({ input, client }) => {
    await client.deletePosition(input.company_id, input.position_id);
    return `Successfully deleted position ${input.position_id}`;
  },
});
