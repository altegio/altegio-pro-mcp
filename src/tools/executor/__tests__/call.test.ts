import { AltegioClient } from '../../../providers/altegio-client.js';
import type { AltegioConfig } from '../../../types/altegio.types.js';
import { buildRequest, callOperation, PAYLOAD_BUDGET_CHARS } from '../call.js';
import { getOperation } from '../catalog.js';
import { ExecutorRefusalError } from '../../../utils/errors.js';

const config: AltegioConfig = {
  partnerToken: 'test-token',
  userToken: 'test-user-token',
};

function mockOk(body: unknown, status = 200): void {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok: true,
    status,
    json: async () => body,
  });
}

/** The URL the client was asked to fetch, for the most recent call. */
function fetchedUrl(): string {
  return (global.fetch as jest.Mock).mock.calls[0]?.[0] as string;
}

describe('altegio_call_operation', () => {
  let client: AltegioClient;

  beforeEach(() => {
    client = new AltegioClient(config, '/tmp/altegio-executor-test');
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('happy path', () => {
    it('executes a documented GET, unwraps the envelope and projects the result', async () => {
      mockOk({
        success: true,
        data: [
          {
            id: 11,
            name: 'Ann',
            specialization: 'Stylist',
            position: { id: 3, title: 'Senior stylist' },
            hidden: 0,
            fired: 0,
            avatar_big: 'https://example.test/a.png',
            information: '<p>bio</p>',
          },
        ],
        meta: { total_count: 1 },
      });

      const result = await callOperation(client, 'get_team_member_list', {
        location_id: 4564,
      });

      expect(fetchedUrl()).toBe('https://api.alteg.io/api/v1/staff/4564');
      expect(result.structuredContent).toMatchObject({
        operation_id: 'get_team_member_list',
        method: 'GET',
        path: '/staff/4564',
        meta: { total_count: 1 },
      });

      // The overlay projection for this operation drops avatar_big/information.
      expect(result.structuredContent.data).toEqual([
        {
          id: 11,
          name: 'Ann',
          specialization: 'Stylist',
          position: { title: 'Senior stylist' },
          hidden: 0,
          fired: 0,
        },
      ]);
      expect(result.structuredContent.projection_applied).toBeDefined();
      expect(result.text).toContain('GET /staff/4564');
      expect(result.text).toContain('1 item');
    });

    it('sends documented query parameters', async () => {
      mockOk({ success: true, data: [] });

      await callOperation(client, 'get_appointment_list', {
        location_id: 4564,
        start_date: '2026-09-01',
        end_date: '2026-09-07',
        count: 30,
      });

      const url = fetchedUrl();
      expect(url).toContain('/records/4564?');
      expect(url).toContain('start_date=2026-09-01');
      expect(url).toContain('end_date=2026-09-07');
      expect(url).toContain('count=30');
    });

    it('passes a payload through untouched when the overlay has no projection', async () => {
      mockOk({ success: true, data: { id: 5, whatever: true } });

      const result = await callOperation(client, 'get_team_member', {
        location_id: 4564,
        team_member_id: 5,
      });

      expect(result.structuredContent.data).toEqual({
        id: 5,
        whatever: true,
      });
      expect(result.structuredContent.projection_applied).toBeUndefined();
    });

    it('handles a response that is not wrapped in the V1 envelope', async () => {
      mockOk([{ id: 1 }]);

      const result = await callOperation(client, 'get_resource_list', {
        location_id: 4564,
      });
      expect(result.structuredContent.data).toEqual([{ id: 1 }]);
    });
  });

  describe('canonical parameter names', () => {
    it('binds a canonical name onto a legacy path segment', () => {
      const op = getOperation('get_appointment');
      expect(op).toBeDefined();

      const built = buildRequest(op!, {
        location_id: 4564,
        appointment_id: 987,
      });
      expect(built.path).toBe('/record/4564/987');
      expect(built.warnings).toEqual([]);
    });

    it('still accepts the legacy spelling on that same path', () => {
      const op = getOperation('get_appointment');
      const built = buildRequest(op!, { location_id: 4564, record_id: 987 });
      expect(built.path).toBe('/record/4564/987');
    });

    it('forwards a canonical query name unchanged — V1 accepts the alias', () => {
      const op = getOperation('get_service_list');
      const built = buildRequest(op!, {
        location_id: 4564,
        team_member_id: 11,
      });
      expect(built.path).toBe('/services/4564');
      expect(built.query).toEqual({ team_member_id: 11 });
      expect(built.warnings).toEqual([]);
    });

    it('forwards `location_id` where the spec still says `company_id`', () => {
      const op = getOperation('get_client_memberships');
      expect(op?.parameters.some((p) => p.name === 'company_id')).toBe(true);

      const built = buildRequest(op!, {
        location_id: 4564,
        phone: '79000000000',
      });
      expect(built.query).toEqual({
        location_id: 4564,
        phone: '79000000000',
      });
    });
  });

  describe('parameter validation', () => {
    it('refuses a call missing a required parameter', async () => {
      await expect(
        callOperation(client, 'get_team_member_list', {})
      ).rejects.toThrow(ExecutorRefusalError);
      await expect(
        callOperation(client, 'get_team_member_list', {})
      ).rejects.toThrow(/missing required: location_id/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('names the canonical parameter in the missing-parameter message', async () => {
      await expect(
        callOperation(client, 'get_appointment', { location_id: 4564 })
      ).rejects.toThrow(/missing required: appointment_id/);
    });

    it('refuses a value of the wrong type', async () => {
      await expect(
        callOperation(client, 'get_team_member_list', {
          location_id: 'not-a-number',
        })
      ).rejects.toThrow(/`location_id` must be integer/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('accepts a numeric string for an integer parameter', async () => {
      mockOk({ success: true, data: [] });
      await callOperation(client, 'get_team_member_list', {
        location_id: '4564',
      });
      expect(fetchedUrl()).toBe('https://api.alteg.io/api/v1/staff/4564');
    });

    it('points at describe_operation when arguments do not fit', async () => {
      await expect(
        callOperation(client, 'get_team_member_list', {})
      ).rejects.toThrow(/altegio_describe_operation/);
    });

    it('forwards an undocumented parameter and says so', async () => {
      mockOk({ success: true, data: [] });

      // The V1 spec does not document page/count on /staff/{location_id},
      // although the API honours them — refusing would block paging.
      const result = await callOperation(client, 'get_team_member_list', {
        location_id: 4564,
        count: 30,
      });

      expect(fetchedUrl()).toContain('count=30');
      expect(result.structuredContent.warnings).toEqual([
        expect.stringContaining('count'),
      ]);
    });
  });

  describe('read-only policy (ADR-001 D2)', () => {
    it.each([
      ['create_appointment', 'POST'],
      ['update_appointment', 'PUT'],
      ['delete_appointment', 'DELETE'],
      ['patch_service', 'PATCH'],
    ])('refuses %s (%s) without calling the API', async (operationId) => {
      await expect(
        callOperation(client, operationId, { location_id: 4564 })
      ).rejects.toThrow(
        /writes are available through curated tools; executor writes require the allowlist from ADR-001 D2/
      );
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('names the curated tool in the refusal when one exists', async () => {
      await expect(
        callOperation(client, 'create_appointment', { location_id: 4564 })
      ).rejects.toThrow(/curated tool `create_appointment`/);
    });

    it('refuses a V3 preview read, which the live API does not serve yet', async () => {
      await expect(
        callOperation(client, 'getLocation', { location_id: 4564 })
      ).rejects.toThrow(/preview contract/);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('refuses an unknown operationId and points at search', async () => {
      await expect(
        callOperation(client, 'no_such_operation', {})
      ).rejects.toThrow(/altegio_search_operations/);
    });
  });

  describe('size budget (ADR-001 D8)', () => {
    it('truncates a large list and returns the narrow-the-query hint', async () => {
      mockOk({
        success: true,
        data: Array.from({ length: 3000 }, (_, i) => ({
          id: i,
          name: `Team member ${i}`,
          specialization: 'Stylist',
          position: { id: 1, title: 'Stylist' },
          hidden: 0,
          fired: 0,
        })),
      });

      const result = await callOperation(client, 'get_team_member_list', {
        location_id: 4564,
      });

      expect(result.structuredContent.truncated).toBe(true);
      expect(result.structuredContent.total).toBe(3000);
      expect(result.structuredContent.returned).toBeLessThan(3000);
      expect(result.structuredContent.hint).toContain('Narrow the query');
      expect(
        JSON.stringify(result.structuredContent.data).length
      ).toBeLessThanOrEqual(PAYLOAD_BUDGET_CHARS);
      expect(result.text).toContain('Narrow the query');
    });

    it('keeps the whole result when it fits', async () => {
      mockOk({ success: true, data: [{ id: 1, name: 'Ann' }] });
      const result = await callOperation(client, 'get_team_member_list', {
        location_id: 4564,
      });
      expect(result.structuredContent.truncated).toBeUndefined();
    });
  });

  describe('errors from the API', () => {
    it('maps a 404 to an actionable message', async () => {
      (global.fetch as jest.Mock).mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ meta: { message: 'Not found' } }),
      });

      await expect(
        callOperation(client, 'get_team_member_list', { location_id: 1 })
      ).rejects.toThrow(/Verify the ID is correct/);
    });

    it('requires authentication', async () => {
      const anonymous = new AltegioClient(
        { partnerToken: 'test' },
        '/tmp/altegio-executor-test-anon'
      );
      await expect(
        callOperation(anonymous, 'get_team_member_list', { location_id: 4564 })
      ).rejects.toThrow(/Not authenticated/);
    });
  });
});
