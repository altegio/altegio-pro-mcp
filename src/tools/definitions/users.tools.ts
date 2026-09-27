import { z } from 'zod';
import { defineTool } from '../factory.js';
import { currentUserOutput } from '../output-schemas.js';
import { withUntrustedBlock, type UntrustedField } from '../tool-result.js';

/** `lang` as Altegio stores it (`pt-BR`, `EN`) → a lowercase ISO 639-1 code. */
function isoLanguage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return /^[a-z]{2,3}$/.test(code) ? code : null;
}

export const getCurrentUserTool = defineTool({
  name: 'users_get_current',
  category: 'Users',
  description:
    'Who is signed in: the user id, display name, approval state and the interface language this person chose in Altegio (ISO 639-1, null when the API build predates the field). AUTHENTICATION REQUIRED. Use it to answer in the language the user reads Altegio in; it reads no location data and needs no location_id.',
  annotations: {
    title: 'Get Current User',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({}),
  outputSchema: currentUserOutput,
  handler: async ({ client }) => {
    const user = await client.getCurrentUser();
    const language = isoLanguage(user.lang);
    const lines = [
      `Signed in as user ${user.id}${user.is_approved === false ? ' (not yet approved)' : ''}.`,
      language
        ? `Altegio interface language: ${language}.`
        : 'Altegio did not report an interface language.',
    ];
    // The display name is typed by the person themselves.
    const untrusted: UntrustedField[] = user.name
      ? [{ label: 'user name', value: user.name }]
      : [];
    return {
      text: withUntrustedBlock(lines.join('\n'), untrusted, { maxChars: 120 }),
      structuredContent: {
        id: user.id,
        name: user.name ?? null,
        language,
        is_approved: user.is_approved ?? null,
      },
    };
  },
});

export const removeLocationUserTool = defineTool({
  name: 'locations_remove_user',
  category: 'Users',
  description:
    'Remove one specifically identified user from one location. AUTHENTICATION REQUIRED and subject to the caller’s user-management permission. First read get_location_users with api_call_operation, verify that the access is safe to revoke, and supply the same exact ID twice. Do not infer that an owner, administrator, human, CI identity, or integration is obsolete from its display name.',
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
