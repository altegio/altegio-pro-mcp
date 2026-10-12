/**
 * `[Location]` access diagnosis after an HTTP 403.
 *
 * Reads, with the request's own credential pair: whether the location is
 * readable, the user's effective rights there and, optionally, the rights a
 * Marketplace application declares. Partner-token grants have no introspection
 * endpoint, so a 403 can be narrowed but never attributed to one grant.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { sanitizeUntrustedDeep } from '../tool-result.js';
import { probe } from '../../api/v1/probe.js';
import { readUserPermissions } from '../../api/v1/user-permissions.js';
import { asRecords, asText } from '../../api/v1/wire-values.js';

/** Declared groups and child rights kept from one application response. */
const APPLICATION_GROUP_LIMIT = 20;
const APPLICATION_RIGHTS_LIMIT = 100;

const READ_STATUS = ['ok', 'forbidden', 'not_found', 'unavailable'] as const;
const objectSchema = (properties: Record<string, object>) => ({
  type: 'object' as const,
  properties,
  required: Object.keys(properties),
});

export const diagnoseLocationAccessTool = defineTool({
  name: 'locations_diagnose_access',
  category: 'Location',
  description:
    'Diagnose an HTTP 403 at a location: location access and the user’s effective permission groups, optionally an application’s declared permissions (not proof of installation). Partner-token grants cannot be inspected. Changes nothing.',
  annotations: {
    title: 'Diagnose location access',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('From locations_list.'),
    permission_keys: z
      .array(z.string().regex(/^[a-z_]+\.[a-z_]+$/))
      .max(20)
      .optional()
      .describe(
        'Rights to check, as group.key (e.g. clients.client_files_list_access).'
      ),
    application_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Marketplace application id (needs Manage user rights).'),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' },
    location_access: { type: 'string', enum: READ_STATUS },
    effective_user_permissions: {
      type: 'string',
      enum: [...READ_STATUS, 'not_inspected'],
    },
    checked_permissions: {
      type: 'object',
      additionalProperties: { type: ['boolean', 'null'] },
    },
    application_declared_permissions: objectSchema({
      status: {
        type: 'string',
        enum: [...READ_STATUS, 'not_inspected', 'not_requested'],
      },
      groups: {
        type: ['array', 'null'],
        items: objectSchema({
          slug: { type: ['string', 'null'] },
          child_permissions: { type: 'array', items: { type: 'string' } },
        }),
      },
      groups_truncated: { type: 'boolean' },
      proves_installation: { type: 'boolean' },
      proves_effective_system_user_rights: { type: 'boolean' },
    }),
    partner_token_permissions: { type: 'string' },
    diagnosis: { type: 'string' },
  }),
  handler: async ({ input, client }) => {
    const location = await probe(() =>
      client.getLocation(input.location_id, { my: 1 })
    );
    const permissions =
      location.status === 'ok'
        ? await probe(() => readUserPermissions(client, input.location_id))
        : ({ status: 'not_inspected' } as const);
    const effective = permissions.status === 'ok' ? permissions.data : {};
    const checked = Object.fromEntries(
      (input.permission_keys ?? []).map((key) => {
        const [group = '', right = ''] = key.split('.');
        const value = effective[group]?.[right];
        return [key, typeof value === 'boolean' ? value : null];
      })
    );

    const application =
      input.application_id === undefined
        ? ({ status: 'not_requested' } as const)
        : location.status !== 'ok'
          ? ({ status: 'not_inspected' } as const)
          : await probe(
              async () =>
                (
                  await client.request<unknown>(
                    'GET',
                    `/company/${input.location_id}/marketplace/applications/${input.application_id}/permissions`
                  )
                ).data
            );
    const declared =
      application.status === 'ok' ? asRecords(application.data) : [];

    const diagnosis =
      location.status === 'forbidden'
        ? 'This partner-and-user credential pair cannot read the location. The API does not identify whether the user, application or partner grant caused this 403.'
        : location.status === 'not_found'
          ? 'The location was not found for this credential pair. Verify location_id with locations_list.'
          : location.status === 'unavailable'
            ? 'The location could not be read right now; retry before drawing conclusions about access.'
            : permissions.status === 'ok'
              ? 'Compare the checked effective user rights with the failing operation. An application or partner-token restriction may still cause 403.'
              : 'The API cannot establish the missing right from this credential; ask a location owner to inspect access.';

    const result = {
      location_id: input.location_id,
      location_access: location.status,
      effective_user_permissions: permissions.status,
      checked_permissions: checked,
      application_declared_permissions: {
        status: application.status,
        groups:
          application.status === 'ok'
            ? declared.slice(0, APPLICATION_GROUP_LIMIT).map((entry) => ({
                slug: asText(entry.slug),
                child_permissions: Array.isArray(entry.child_permissions)
                  ? entry.child_permissions
                      .filter((v): v is string => typeof v === 'string')
                      .slice(0, APPLICATION_RIGHTS_LIMIT)
                  : [],
              }))
            : null,
        groups_truncated: declared.length > APPLICATION_GROUP_LIMIT,
        proves_installation: false,
        proves_effective_system_user_rights: false,
      },
      partner_token_permissions: 'not_inspectable',
      diagnosis,
    };

    const checkedLine = Object.entries(checked)
      .map(([key, value]) => `${key}=${value === null ? 'unknown' : value}`)
      .join(', ');
    return {
      text: [
        `Location access: ${location.status}; effective user permissions: ${permissions.status}; application declarations: ${application.status}.`,
        ...(checkedLine ? [`Checked rights: ${checkedLine}.`] : []),
        diagnosis,
      ].join('\n'),
      structuredContent: sanitizeUntrustedDeep(result),
    };
  },
});
