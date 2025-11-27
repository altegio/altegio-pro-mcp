import { z } from 'zod';
import { defineTool } from '../factory.js';

export const loginTool = defineTool({
  name: 'altegio_login',
  category: 'Auth',
  description:
    '[Auth] Login to Altegio with email and password. REQUIRED for administrative operations.',
  requiresAuth: false,

  input: z.object({
    email: z.string().email().describe('User email address'),
    password: z.string().min(1).describe('User password'),
  }),

  handler: async ({ input, client }) => {
    const result = await client.login(input.email, input.password);

    if (result.success) {
      return 'Successfully logged in to Altegio';
    }
    return `Login failed: ${result.error}`;
  },
});

export const logoutTool = defineTool({
  name: 'altegio_logout',
  category: 'Auth',
  description: '[Auth] Logout from Altegio and clear stored credentials.',
  requiresAuth: false,

  input: z.object({}),

  handler: async ({ client }) => {
    await client.logout();
    return 'Successfully logged out from Altegio';
  },
});
