import { z } from 'zod';
import { defineTool } from '../factory.js';
import { positionsOutput, positionEntityOutput } from '../output-schemas.js';

export const getPositionsTool = defineTool({
  name: 'get_positions',
  category: 'Positions',
  description:
    '[Positions] Get list of positions in company. AUTHENTICATION REQUIRED. Returns all available positions that can be assigned to staff members.',
  annotations: {
    title: 'Get Positions',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
  }),
  outputSchema: positionsOutput,
  handler: async ({ input, client }) => {
    const positions = await client.getPositions(input.company_id);

    if (!positions || positions.length === 0) {
      return {
        text: 'No positions found for this company.',
        structuredContent: { items: [], count: 0 },
      };
    }

    const positionsList = positions
      .map((p, idx) => `${idx + 1}. ${p.title} (ID: ${p.id})`)
      .join('\n');

    return {
      text: `Found ${positions.length} position(s):\n\n${positionsList}`,
      structuredContent: { items: positions, count: positions.length },
    };
  },
});

export const createPositionTool = defineTool({
  name: 'create_position',
  category: 'Positions',
  description:
    '[Positions] Create a new position. AUTHENTICATION REQUIRED. Positions are used to categorize staff roles (e.g., "Manager", "Stylist", "Receptionist").',
  annotations: {
    title: 'Create Position',
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    title: z.string().min(1).describe('Position title'),
    api_id: z.string().optional().describe('External API ID (optional)'),
  }),
  outputSchema: positionEntityOutput,
  handler: async ({ input, client }) => {
    const { company_id, ...positionData } = input;
    const position = await client.createPosition(company_id, positionData);
    return {
      text: `Successfully created position:\nID: ${position.id}\nTitle: ${position.title}`,
      structuredContent: { id: position.id, title: position.title },
    };
  },
});

export const updatePositionTool = defineTool({
  name: 'update_position',
  category: 'Positions',
  description:
    '[Positions] Update existing position. AUTHENTICATION REQUIRED. Modify position title or external ID.',
  annotations: {
    title: 'Update Position',
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    position_id: z.number().int().positive().describe('Position ID'),
    title: z.string().min(1).optional().describe('New position title'),
    api_id: z.string().optional().describe('External API ID (optional)'),
  }),
  outputSchema: positionEntityOutput,
  handler: async ({ input, client }) => {
    const { company_id, position_id, ...updateData } = input;
    const position = await client.updatePosition(
      company_id,
      position_id,
      updateData
    );
    return {
      text: `Successfully updated position ${position_id}:\nTitle: ${position.title}`,
      structuredContent: { id: position.id, title: position.title },
    };
  },
});

export const deletePositionTool = defineTool({
  name: 'delete_position',
  category: 'Positions',
  description:
    '[Positions] Delete position. AUTHENTICATION REQUIRED. Note: Cannot delete positions that are assigned to staff members.',
  annotations: {
    title: 'Delete Position',
    destructiveHint: true,
    openWorldHint: true,
  },
  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    position_id: z.number().int().positive().describe('Position ID to delete'),
  }),
  handler: async ({ input, client }) => {
    await client.deletePosition(input.company_id, input.position_id);
    return {
      text: `Successfully deleted position ${input.position_id}`,
    };
  },
});
