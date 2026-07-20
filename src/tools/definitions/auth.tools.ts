import { z } from 'zod';
import { defineTool } from '../factory.js';
import { loginOutput } from '../output-schemas.js';

export const loginTool = defineTool({
  name: 'altegio_login',
  category: 'Auth',
  description:
    '[Auth] Login to Altegio with email and password. REQUIRED for administrative operations: getting user companies (list_companies with my=1), viewing bookings, and other business management tasks. Ask user for credentials when they request administrative data.',
  annotations: {
    title: 'Login to Altegio',
    openWorldHint: true,
  },
  input: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
  outputSchema: loginOutput,
  handler: async ({ input, client }) => {
    const result = await client.login(input.email, input.password);
    return {
      text: result.success
        ? 'Successfully logged in to Altegio'
        : `Login failed: ${result.error}`,
      structuredContent: {
        success: result.success,
        ...(result.error && { error: result.error }),
      },
    };
  },
});

export const logoutTool = defineTool({
  name: 'altegio_logout',
  category: 'Auth',
  description: '[Auth] Logout from Altegio and clear stored credentials.',
  annotations: {
    title: 'Logout from Altegio',
    openWorldHint: true,
  },
  input: z.object({}),
  handler: async ({ client }) => {
    await client.logout();
    return { text: 'Successfully logged out from Altegio' };
  },
});
