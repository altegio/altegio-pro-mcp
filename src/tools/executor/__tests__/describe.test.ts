import { describeOperation, terminologyNotes } from '../describe.js';
import { acceptedNames, canonicalName, getOperation } from '../catalog.js';

describe('api_describe_operation', () => {
  it('describes a curated read with its parameters, auth and response', () => {
    const { found, text, structuredContent } =
      describeOperation('list_team_members');

    expect(found).toBe(true);
    // A live operation names no API version.
    expect(structuredContent).not.toHaveProperty('source');
    expect(text).not.toContain('Source:');
    expect(structuredContent).toMatchObject({
      operation_id: 'list_team_members',
      method: 'GET',
      path: '/locations/{location_id}/team_members',
      domain: 'team_members',
      deprecated: false,
      callable_by_executor: true,
      curated_tool: 'team_members_list',
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
    // The wrapper is transport; the catalog stores the payload itself and
    // names the wrapper by its shape, never by an API version.
    expect(structuredContent.response).toMatchObject({
      unwrapped_from: '{data, meta}',
    });
    expect(structuredContent.response).not.toHaveProperty('envelope');

    expect(text).toContain(
      'list_team_members — GET /locations/{location_id}/team_members'
    );
    expect(text).toContain('location_id (path, required, integer)');
    expect(text).toContain('team_members_list');
  });

  it('notes which legacy parameter names are accepted as canonical ones', () => {
    const { text, structuredContent } = describeOperation('get_appointment');
    const notes = structuredContent.terminology_notes as string[];

    expect(notes).toContain('`record_id` is accepted as `appointment_id`');
    expect(text).toContain('`record_id` is accepted as `appointment_id`');

    const params = structuredContent.parameters as Array<{
      name: string;
      spec_name?: string;
      accepted_names?: string[];
    }>;
    const appointment = params.find((p) => p.name === 'appointment_id');
    expect(appointment?.spec_name).toBe('record_id');
    expect(appointment?.accepted_names).toContain('record_id');
  });

  it('still accepts the legacy spelling where the spec is already canonical', () => {
    const { structuredContent } = describeOperation('get_service_list');
    const params = structuredContent.parameters as Array<{
      name: string;
      spec_name?: string;
      accepted_names?: string[];
    }>;
    const teamMember = params.find((p) => p.name === 'team_member_id');
    expect(teamMember?.spec_name).toBeUndefined();
    expect(teamMember?.accepted_names).toContain('staff_id');
    expect(structuredContent.terminology_notes ?? []).toEqual([]);
  });

  it('shows the canonical path and the spec spelling when they differ', () => {
    const { structuredContent } = describeOperation('get_appointment');
    expect(structuredContent.path).toBe(
      '/locations/{location_id}/appointments/{appointment_id}'
    );
    expect(structuredContent.spec_path).toBe(
      '/locations/{location_id}/appointments/{record_id}'
    );
    expect(structuredContent.terminology_notes).toContain(
      '`record_id` is accepted as `appointment_id`'
    );
  });

  it('adds reading notes that legend coded fields and point at the analytics resources', () => {
    const { text, structuredContent } = describeOperation('get_appointment');
    const readingNotes = structuredContent.reading_notes as string[];

    // The attendance legend is the most valuable note on an appointment read.
    expect(readingNotes.join('\n')).toContain('-1 no-show');
    expect(readingNotes.join('\n')).toContain('altegio://analytics/data-model');
    expect(text).toContain('Reading the data:');
  });

  it('leaves domains without a legend free of reading notes', () => {
    // team_members carries no coded-value legend, so no reading_notes are added.
    const { structuredContent } = describeOperation('get_team_member_list');
    expect(structuredContent.reading_notes).toBeUndefined();
  });

  it('marks a write as not callable by the executor and points at the tool', () => {
    const { text, structuredContent } = describeOperation('update_appointment');
    expect(structuredContent.callable_by_executor).toBe(false);
    expect(text).toContain('is a write');
    expect(text).toContain('appointments_update');
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

  it('describes a canonical read with a clean id and no version', () => {
    const { text, structuredContent } = describeOperation(
      'get_event_date_range'
    );
    expect(structuredContent).toMatchObject({
      operation_id: 'get_event_date_range',
      path: '/locations/{location_id}/events/dates/range',
      callable_by_executor: true,
      curated_tool: 'events_list_dates',
    });
    expect(structuredContent).not.toHaveProperty('source');
    expect(structuredContent).not.toHaveProperty('spec_operation_id');
    expect(text).toContain('`{data, meta}` wrapper is unwrapped');
    expect(text).not.toMatch(/\bv[12]\b|JSON:API/i);
    expect(text).not.toContain('Not callable');
    // The live API refuses a period that starts in the past; the note says so.
    expect(structuredContent.reading_notes).toEqual(
      expect.arrayContaining([expect.stringContaining('filter[from]')])
    );
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

  it('strips the spec suffix from a V2 id', () => {
    expect(getOperation('list_event_duplication_strategies')).toMatchObject({
      specOperationId: 'list_event_duplication_strategies_v2',
    });
    expect(
      describeOperation('list_event_duplication_strategies_v2').found
    ).toBe(false);
  });

  it('points a superseded id at the operation that replaced it', () => {
    const result = describeOperation('get_team_member_list');
    expect(result.found).toBe(false);
    expect(result.text).toContain('`list_team_members` replaces it');
    expect(result.structuredContent).toMatchObject({
      replaced_by: 'list_team_members',
    });
  });

  it('suggests neighbours for an unknown operationId', () => {
    const result = describeOperation('get_team_member_lst');
    expect(result.found).toBe(false);
    expect(result.text).toContain('No operation `get_team_member_lst`');
    expect(result.text).toContain('api_search_operations');
    expect(result.structuredContent.suggestions).toContain('get_team_member');
  });

  it('stays inside the per-result size budget for every operation', () => {
    // 14000 characters ≈ 3.5k tokens (ADR-001 D8: ≤ 4k per result).
    for (const op of [
      'list_team_members',
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
    const op = getOperation('list_team_members');
    expect(op).toBeDefined();
    expect(terminologyNotes(op!)).toEqual([]);
  });
});
