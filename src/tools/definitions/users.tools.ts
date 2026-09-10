import { z } from 'zod';
import { defineTool } from '../factory.js';

export const removeLocationUserTool = defineTool({
  name: 'remove_location_user',
  category: 'Users',
  description:
    '[Users] Remove one specifically identified user from one location. AUTHENTICATION REQUIRED and subject to the caller’s user-management permission. First read get_location_users with altegio_call_operation, verify that the access is safe to revoke, and supply the same exact ID twice. Do not infer that an owner, administrator, human, CI identity, or integration is obsolete from its display name.',
  annotations: {
    title: 'Remove Location User',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z
    .object({
      location_id: z.number().int().positive().describe('Location ID'),
      user_id: z.number().int().positive().describe('Exact user ID to remove'),
      confirm_user_id: z
        .number()
        .int()
        .positive()
        .describe('Repeat the exact user ID as a destructive safeguard'),
    })
    .refine((input) => input.user_id === input.confirm_user_id, {
      path: ['confirm_user_id'],
      message: 'must exactly match user_id',
    }),
  handler: async ({ input, client }) => {
    await client.removeLocationUser(input.location_id, input.user_id);
    return {
      text: `Removed user ${input.user_id} from location ${input.location_id}`,
    };
  },
});
