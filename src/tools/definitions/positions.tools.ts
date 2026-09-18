import { z } from 'zod';
import { defineTool } from '../factory.js';
import { positionsOutput, positionEntityOutput } from '../output-schemas.js';
import { withUntrustedBlock, type UntrustedField } from '../tool-result.js';

export const getPositionsTool = defineTool({
  name: 'get_positions',
  category: 'Positions',
  description:
    '[Positions] Get the positions that can be assigned to team members in a location. AUTHENTICATION REQUIRED. This uses the deprecated but still documented public V1 read; public V1 does not provide position update or delete operations.',
  annotations: {
    title: 'Get Positions',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
  }),
  outputSchema: positionsOutput,
  handler: async ({ input, client }) => {
    const positions = await client.getPositions(input.location_id);

    if (!positions || positions.length === 0) {
      return {
        text: 'No positions found for this location.',
        structuredContent: { items: [], count: 0 },
      };
    }

    // A position title is named by the staff of the location.
    const lines = [
      `Found ${positions.length} position(s), ids: ${positions.map((p) => p.id).join(', ')}.`,
    ];
    const untrusted: UntrustedField[] = positions.map((p) => ({
      label: `position ${p.id} title`,
      value: p.title,
    }));

    return {
      text: withUntrustedBlock(lines.join('\n'), untrusted, { maxChars: 200 }),
      structuredContent: {
        items: positions.map((p) => ({
          id: p.id,
          title: p.title,
        })),
        count: positions.length,
      },
    };
  },
});

export const createPositionTool = defineTool({
  name: 'create_position',
  category: 'Positions',
  description:
    '[Positions] Create a new position through the deprecated but still documented public V1 quick-create operation. AUTHENTICATION REQUIRED. Positions categorize team-member roles (for example Manager, Stylist, Receptionist). Public V1 accepts only the title and does not provide position update or delete operations.',
  annotations: {
    title: 'Create Position',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    title: z.string().min(1).describe('Position title'),
  }),
  outputSchema: positionEntityOutput,
  handler: async ({ input, client }) => {
    const { location_id, ...positionData } = input;
    const position = await client.createPosition(location_id, positionData);
    return {
      text: `Successfully created position:\nID: ${position.id}\nTitle: ${position.title}`,
      structuredContent: { id: position.id, title: position.title },
    };
  },
});
