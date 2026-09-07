import { describeOperation, terminologyNotes } from '../describe.js';
import { acceptedNames, canonicalName, getOperation } from '../catalog.js';

describe('altegio_describe_operation', () => {
  it('describes a curated read with its parameters, auth and response', () => {
    const { found, text, structuredContent } = describeOperation(
      'get_team_member_list'
    );

    expect(found).toBe(true);
    expect(structuredContent).toMatchObject({
      operation_id: 'get_team_member_list',
      method: 'GET',
      path: '/staff/{location_id}',
      source: 'v1',
      domain: 'team_members',
      deprecated: false,
      callable_by_executor: true,
      curated_tool: 'get_staff',
      tier: 'core',
    });

    const params = structuredContent.parameters as Array<{
      name: string;
      in: string;
      required: boolean;
      type?: string;
    }>;
    expect(params).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'location_id',
          in: 'path',
          required: true,
          type: 'integer',
        }),
      ])
    );

    expect(structuredContent.authentication).toMatchObject({ required: true });
    expect(structuredContent.response).toMatchObject({ statusCode: '200' });
    // The V1 envelope is transport; the catalog stores the payload itself.
    expect(structuredContent.response).toMatchObject({ envelope: 'v1' });

    expect(text).toContain('get_team_member_list — GET /staff/{location_id}');
    expect(text).toContain('location_id (path, required, integer)');
    expect(text).toContain('get_staff');
  });

  it('notes which legacy parameter names are accepted as canonical ones', () => {
    const { text, structuredContent } = describeOperation('get_service_list');
    const notes = structuredContent.terminology_notes as string[];

    expect(notes).toContain('`staff_id` is accepted as `team_member_id`');
    expect(text).toContain('`staff_id` is accepted as `team_member_id`');

    const params = structuredContent.parameters as Array<{
      name: string;
      spec_name?: string;
      accepted_names?: string[];
    }>;
    const teamMember = params.find((p) => p.name === 'team_member_id');
    expect(teamMember?.spec_name).toBe('staff_id');
    expect(teamMember?.accepted_names).toContain('staff_id');
  });

  it('shows the canonical path and the spec spelling when they differ', () => {
    const { structuredContent } = describeOperation('get_appointment');
    expect(structuredContent.path).toBe(
      '/record/{location_id}/{appointment_id}'
    );
    expect(structuredContent.spec_path).toBe(
      '/record/{location_id}/{record_id}'
    );
    expect(structuredContent.terminology_notes).toContain(
      '`record_id` is accepted as `appointment_id`'
    );
  });

  it('marks a write as not callable by the executor and points at the tool', () => {
    const { text, structuredContent } = describeOperation('update_appointment');
    expect(structuredContent.callable_by_executor).toBe(false);
    expect(text).toContain('is a write');
    expect(text).toContain('update_appointment');
  });

  it('marks a V3 preview operation as not callable yet', () => {
    const preview = describeOperation('registerOAuthClient');
    expect(preview.found).toBe(true);
    expect(preview.structuredContent).toMatchObject({
      source: 'v3',
      status: 'preview',
      callable_by_executor: false,
    });
  });

  it('reports deprecation', () => {
    const { text, structuredContent } = describeOperation(
      'deprecated_get_service_category_list'
    );
    expect(structuredContent.deprecated).toBe(true);
    expect(text).toContain('DEPRECATED');
  });

  it('describes the request body of a write', () => {
    const { structuredContent } = describeOperation('create_appointment');
    expect(structuredContent.request_body).toMatchObject({
      contentType: expect.stringContaining('json'),
    });
  });

  it('suggests neighbours for an unknown operationId', () => {
    const result = describeOperation('get_team_member_lst');
    expect(result.found).toBe(false);
    expect(result.text).toContain('No operation `get_team_member_lst`');
    expect(result.text).toContain('altegio_search_operations');
    expect(result.structuredContent.suggestions).toContain(
      'get_team_member_list'
    );
  });

  it('stays inside the per-result size budget for every operation', () => {
    // 14000 characters ≈ 3.5k tokens (ADR-001 D8: ≤ 4k per result).
    for (const op of [
      'get_team_member_list',
      'get_appointment_list',
      'get_client_list',
      'get_location_list',
      'create_appointment',
    ]) {
      const { structuredContent } = describeOperation(op);
      expect(JSON.stringify(structuredContent).length).toBeLessThanOrEqual(
        14000
      );
    }
  });
});

describe('canonical alias helpers', () => {
  it('maps legacy spec names to the glossary', () => {
    expect(canonicalName('company_id')).toBe('location_id');
    expect(canonicalName('staff_id')).toBe('team_member_id');
    expect(canonicalName('record_id')).toBe('appointment_id');
    expect(canonicalName('good_id')).toBe('product_id');
    // Already canonical names pass through.
    expect(canonicalName('location_id')).toBe('location_id');
  });

  it('accepts every spelling of one parameter', () => {
    expect(acceptedNames('company_id').sort()).toEqual([
      'company_id',
      'location_id',
      'salon_id',
    ]);
    expect(acceptedNames('staff_id').sort()).toEqual([
      'master_id',
      'staff_id',
      'team_member_id',
    ]);
  });

  it('produces no note when the spec is already canonical', () => {
    const op = getOperation('get_team_member_list');
    expect(op).toBeDefined();
    expect(terminologyNotes(op!)).toEqual([]);
  });
});
