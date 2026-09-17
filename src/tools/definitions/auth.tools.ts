import { z } from 'zod';
import { defineTool } from '../factory.js';
import { loginOutput } from '../output-schemas.js';
import { upstreamDetail } from '../tool-result.js';

export const loginTool = defineTool({
  name: 'altegio_login',
  category: 'Auth',
  description:
    '[Auth] Exchange an Altegio email and password the user has already chosen to provide for a user token, which is then reused for administrative operations (list_locations with my=1, appointments, and the rest of the business-management surface). Only for local stdio use: a hosted deployment gets its identity from the host and does not need this tool. Do not ask the user for a password, and do not offer this tool as a way to unblock a failed call — say what access is missing and let the user decide how to authenticate.',
  annotations: {
    title: 'Login to Altegio',
    destructiveHint: false,
    // Each call mints and stores a fresh user token upstream, so a repeat
    // is not a no-op.
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
  outputSchema: loginOutput,
  handler: async ({ input, client }) => {
    const result = await client.login(input.email, input.password);
    // The failure sentence is ours; the API's own wording is quoted after it as
    // data, never spliced into an instruction (ADR-001 D8).
    const detail = result.success ? null : upstreamDetail(result.error);
    return {
      text: result.success
        ? 'Successfully logged in to Altegio'
        : [
            'Login failed. The credentials were not accepted; ask the user to check them or to authenticate through the host instead.',
            ...(detail ? [detail] : []),
          ].join(' '),
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
    destructiveHint: false,
    // Clearing an already-cleared credential store changes nothing.
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({}),
  handler: async ({ client }) => {
    await client.logout();
    return { text: 'Successfully logged out from Altegio' };
  },
});
