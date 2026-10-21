import { paginationInput, paginateCollection } from '../pagination.js';
import { z } from 'zod';
import { defineTool } from '../factory.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import type { AltegioPosition } from '../../types/altegio.types.js';
import { AltegioApiError } from '../../utils/errors.js';
import {
  ConfirmationRefusal,
  stateVersion,
  type ConfirmedCall,
} from '../confirmation.js';
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
    'Get the positions that can be assigned to team members in a location, with their descriptions.',
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
    'Create a position (team-member role, e.g. Stylist) with a title and optional description.',
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

// ========== changing and deleting a position ==========

/** A change the call cannot make; nothing was sent. */
class PositionChangeError extends Error {}

interface PositionUpdateInput {
  location_id: number;
  position_id: number;
  title?: string;
  description?: string;
}

interface PositionPlan {
  version: string;
  before: AltegioPosition;
  after: { title: string; description: string };
}

/**
 * V2 replaces the title and description together and clears a description
 * left out, so the change is merged onto a fresh read and sent whole.
 */
async function planPositionUpdate(
  client: AltegioClient,
  input: PositionUpdateInput
): Promise<PositionPlan> {
  if (input.title === undefined && input.description === undefined) {
    throw new PositionChangeError(
      'Nothing was changed: pass a title, a description or both.'
    );
  }
  const before = await client.getPosition(input.location_id, input.position_id);
  const after = {
    title: input.title ?? before.title,
    description: input.description ?? before.description ?? '',
  };
  if (
    after.title === before.title &&
    after.description === (before.description ?? '')
  ) {
    throw new PositionChangeError(
      `Nothing was changed: position ${before.id} already has that title and description.`
    );
  }
  return { version: stateVersion(before), before, after };
}

function positionChangeText(plan: PositionPlan, lead: string): string {
  const { before, after } = plan;
  const lines = [
    lead,
    ...(after.title !== before.title ? ['- title: changed'] : []),
    ...(after.description !== (before.description ?? '')
      ? [
          after.description
            ? '- description: changed'
            : '- description: cleared',
        ]
      : []),
  ];
  return withUntrustedBlock(
    lines.join('\n'),
    [
      { label: `position ${before.id} title before`, value: before.title },
      { label: `position ${before.id} title after`, value: after.title },
      {
        label: `position ${before.id} description before`,
        value: before.description ?? null,
      },
      {
        label: `position ${before.id} description after`,
        value: after.description || null,
      },
    ],
    { maxChars: 300 }
  );
}

export const updatePositionTool = defineTool({
  name: 'positions_update',
  category: 'Positions',
  description:
    'Rename a position or change its description; what is left out stays. Asks for confirmation first, showing before → after; refused if the position changes after that.',
  annotations: {
    title: 'Update Position',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    position_id: z
      .number()
      .int()
      .positive()
      .describe('Position ID (positions_list).'),
    title: z.string().trim().min(1).max(100).optional().describe('New title.'),
    description: z
      .string()
      .max(1000)
      .optional()
      .describe('New description; an empty string clears it.'),
  }),
  outputSchema: positionEntityOutput,
  confirm: {
    action: 'Update position',
    target: (input) =>
      `position ${input.position_id} at location ${input.location_id}`,
    consequence:
      'The team members who hold the position show the new title and description.',
    detail: async (input, client) => {
      try {
        const plan = await planPositionUpdate(client, input);
        return {
          text: positionChangeText(plan, `Position ${plan.before.id}:`),
          version: plan.version,
        };
      } catch (error) {
        if (error instanceof PositionChangeError) {
          throw new ConfirmationRefusal(
            error.message.replace(/^Nothing was changed: /, '')
          );
        }
        throw error;
      }
    },
  },
  handler: async ({ input, client, confirmation }) => {
    const plan = await planPositionUpdate(client, input);
    refuseMoved(plan, confirmation);
    await client.updatePosition(
      input.location_id,
      input.position_id,
      plan.after
    );
    return {
      text: positionChangeText(
        plan,
        `Updated position ${plan.before.id} at location ${input.location_id}:`
      ),
      structuredContent: {
        id: plan.before.id,
        title: sanitizeUntrusted(plan.after.title) ?? undefined,
        description: sanitizeUntrusted(plan.after.description || null),
      },
    };
  },
});

function refuseMoved(
  plan: { version: string },
  confirmation: ConfirmedCall | undefined
): void {
  if (
    confirmation?.version !== undefined &&
    confirmation.version !== plan.version
  ) {
    throw new PositionChangeError(
      'Nothing was changed: the position changed after the confirmation was shown. Read it again with positions_list and confirm the change again.'
    );
  }
}

export const deletePositionTool = defineTool({
  name: 'positions_delete',
  category: 'Positions',
  description:
    'Delete a position from a location. The confirmation names the team members who hold it; give them another position first with team_members_update if they need one.',
  annotations: {
    title: 'Delete Position',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    position_id: z
      .number()
      .int()
      .positive()
      .describe('Exact position ID to delete (positions_list).'),
  }),
  confirm: {
    action: 'Delete position',
    target: (input) =>
      `position ${input.position_id} at location ${input.location_id}`,
    resolve: async (input, client) => {
      const position = await client.getPosition(
        input.location_id,
        input.position_id
      );
      return `position "${position.title}", id ${position.id}, at location ${input.location_id}`;
    },
    consequence:
      'The position leaves the location’s list for good and cannot be restored; the team members who hold it are listed below.',
    detail: async (input, client) => {
      const holders = (await client.getStaff(input.location_id)).filter(
        (member) => member.position?.id === input.position_id
      );
      return holders.length
        ? `${holders.length} team member(s) hold it: ids ${holders.map((m) => m.id).join(', ')}.`
        : 'No team member holds it.';
    },
  },
  handler: async ({ input, client }) => {
    // A repeat finds the position gone: V2 answers 404.
    const gone = await client
      .deletePosition(input.location_id, input.position_id)
      .then(
        () => false,
        (error: unknown) => {
          if (error instanceof AltegioApiError && error.statusCode === 404)
            return true;
          throw error;
        }
      );
    return {
      text: gone
        ? `Position ${input.position_id} is not at location ${input.location_id}: it was deleted already, or the id is wrong (positions_list).`
        : `Deleted position ${input.position_id} from location ${input.location_id}.`,
      structuredContent: {
        location_id: input.location_id,
        position_id: input.position_id,
        deleted: !gone,
        already_deleted: gone,
      },
    };
  },
});
