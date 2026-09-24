import { Ajv2020 } from 'ajv/dist/2020.js';
import { AltegioApiError, AuthenticationError } from '../../utils/errors.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import type { DefinedTool } from '../factory.js';
import { diagnoseLocationAccessTool } from '../definitions/location-access.tools.js';

const fake = (parts: Partial<AltegioClient>): AltegioClient =>
  parts as AltegioClient;
const content = (result: { structuredContent?: unknown }) =>
  result.structuredContent as Record<string, unknown>;

/** The result must satisfy the schema strict MCP clients validate it against. */
function expectOutputContract(
  tool: DefinedTool,
  result: { structuredContent?: unknown }
) {
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(
    tool.toMcpTool().outputSchema!
  );
  if (!validate(result.structuredContent))
    throw new Error(JSON.stringify(validate.errors, null, 2));
}

describe('diagnose_location_access', () => {
  it('stops at a forbidden location without guessing partner rights', async () => {
    const request = jest.fn();
    const result = await diagnoseLocationAccessTool.createHandler(
      fake({
        getLocation: jest
          .fn()
          .mockRejectedValue(new AltegioApiError('forbidden', 403)),
        request: request as unknown as AltegioClient['request'],
      })
    )({
      location_id: 7,
      permission_keys: ['clients.client_files_list_access'],
      application_id: 4,
    });
    expect(result.isError).toBeUndefined();
    expect(content(result)).toMatchObject({
      location_access: 'forbidden',
      effective_user_permissions: 'not_inspected',
      checked_permissions: { 'clients.client_files_list_access': null },
      application_declared_permissions: { status: 'not_inspected' },
      partner_token_permissions: 'not_inspectable',
    });
    expect(request).not.toHaveBeenCalled();
    expectOutputContract(diagnoseLocationAccessTool, result);
  });

  it('separates effective user rights from an application declaration', async () => {
    const request = jest.fn(async (_method: string, path: string) => ({
      data: path.includes('/marketplace/')
        ? [{ slug: 'clients', child_permissions: ['create_client'] }]
        : { clients: { client_files_list_access: false } },
    }));
    const result = await diagnoseLocationAccessTool.createHandler(
      fake({
        getLocation: jest.fn().mockResolvedValue({ id: 7 }),
        request: request as AltegioClient['request'],
      })
    )({
      location_id: 7,
      permission_keys: ['clients.client_files_list_access', 'finances.x'],
      application_id: 4,
    });
    expect(content(result).checked_permissions).toEqual({
      'clients.client_files_list_access': false,
      'finances.x': null,
    });
    expect(content(result).application_declared_permissions).toMatchObject({
      status: 'ok',
      proves_effective_system_user_rights: false,
      groups: [{ slug: 'clients', child_permissions: ['create_client'] }],
    });
    expect(result.content[0]!.text).toContain(
      'clients.client_files_list_access=false, finances.x=unknown'
    );
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/company/7/marketplace/applications/4/permissions'
    );
    expectOutputContract(diagnoseLocationAccessTool, result);
  });

  it('names a missing location instead of a missing right', async () => {
    const result = await diagnoseLocationAccessTool.createHandler(
      fake({
        getLocation: jest
          .fn()
          .mockRejectedValue(new AltegioApiError('missing', 404)),
      })
    )({ location_id: 7 });
    expect(content(result)).toMatchObject({
      location_access: 'not_found',
      application_declared_permissions: { status: 'not_requested' },
    });
    expect(content(result).diagnosis).toContain('list_locations');
  });

  it('reports a lost session as an authentication error, not a finding', async () => {
    const result = await diagnoseLocationAccessTool.createHandler(
      fake({
        getLocation: jest.fn().mockRejectedValue(new AuthenticationError()),
      })
    )({ location_id: 7 });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('Authentication required');
  });
});
