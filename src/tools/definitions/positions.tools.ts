import { paginationInput, paginateCollection } from '../pagination.js';
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { positionsOutput, positionEntityOutput } from '../output-schemas.js';
import {
  withUntrustedBlock,
  sanitizeUntrusted,
  type UntrustedField,
} from '../tool-result.js';

export const getPositionsTool = defineTool({
  name: 'positions_list',
  category: 'Positions',
  description:
    'Get the positions that can be assigned to team members in a location, with their descriptions. AUTHENTICATION REQUIRED.',
  annotations: {
    title: 'Get Positions',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    ...paginationInput,
  }),
  outputSchema: positionsOutput,
  handler: async ({ input, client }) => {
    const { items: positions, pagination } = paginateCollection(
      await client.getPositions(input.location_id),
      input
    );

    if (!positions || positions.length === 0) {
      return {
        text: 'No positions found for this location.',
        structuredContent: { items: [], count: 0, ...pagination },
      };
    }

    // A position title is named by the staff of the location.
    const lines = [
      `Found ${positions.length} position(s), ids: ${positions.map((p) => p.id).join(', ')}.`,
    ];
    const untrusted: UntrustedField[] = positions.flatMap((p) => [
      { label: `position ${p.id} title`, value: p.title },
      { label: `position ${p.id} description`, value: p.description ?? null },
    ]);

    return {
      text: withUntrustedBlock(lines.join('\n'), untrusted, { maxChars: 200 }),
      structuredContent: {
        items: positions.map((p) => ({
          id: p.id,
          title: p.title,
          description: p.description ?? null,
        })),
        pagination,
      },
    };
  },
});

export const createPositionTool = defineTool({
  name: 'positions_create',
  category: 'Positions',
  description:
    'Create a new position with a title and an optional description. AUTHENTICATION REQUIRED. Positions categorize team-member roles (for example Manager, Stylist, Receptionist).',
  annotations: {
    title: 'Create Position',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    title: z.string().min(1).max(100).describe('Position title'),
    description: z
      .string()
      .max(1000)
      .optional()
      .describe('What the position does, shown to the team.'),
  }),
  outputSchema: positionEntityOutput,
  handler: async ({ input, client }) => {
    const { location_id, ...positionData } = input;
    const position = await client.createPosition(location_id, positionData);
    return {
      text: withUntrustedBlock(
        `Successfully created position ${position.id}.`,
        [{ label: 'title', value: position.title }]
      ),
      structuredContent: {
        id: position.id,
        title: sanitizeUntrusted(position.title) ?? undefined,
        description: sanitizeUntrusted(position.description ?? null),
      },
    };
  },
});
