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
  confirm: {
    action: 'Remove user access',
    target: (input) => `user ${input.user_id} at location ${input.location_id}`,
    resolve: async (input, client) => {
      const { data } = await client.request<
        Array<{ id?: number; user_id?: number; name?: string; email?: string }>
      >('GET', `/company/${input.location_id}/users`);
      const user = (Array.isArray(data) ? data : []).find(
        (candidate) => (candidate.user_id ?? candidate.id) === input.user_id
      );
      if (!user) return undefined;
      const email = user.email ? `, ${user.email}` : '';
      return `user ${user.name ?? 'without a name'}${email}, id ${input.user_id}, at location ${input.location_id}`;
    },
    consequence:
      'They lose all access to this location, including any integration or CI identity that signs in as them, and any automation using that account stops working. Data they created is kept. Re-adding access is a separate invitation flow this server does not cover.',
  },
  handler: async ({ input, client }) => {
    await client.removeLocationUser(input.location_id, input.user_id);
    return {
      text: `Removed user ${input.user_id} from location ${input.location_id}`,
    };
  },
});
