import { Ajv2020 } from 'ajv/dist/2020.js';
import { AltegioApiError } from '../../utils/errors.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import type { DefinedTool } from '../factory.js';
import {
  appointmentsApplyAttendanceTool,
  appointmentsPreviewAttendanceTool,
} from '../definitions/attendance.tools.js';

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

/**
 * A location with appointments keyed by id. `attendance` is the V1 code
 * (-1 no-show, 0 waiting, 1 arrived, 2 confirmed); `write` decides what one
 * attendance POST does to the stored codes.
 */
function location(
  appointments: Record<number, { visit_id: number; attendance: number }>,
  write: (
    appointmentId: number,
    code: number,
    store: typeof appointments
  ) => void = (id, code, store) => {
    for (const other of Object.values(store))
      if (other.visit_id === store[id]!.visit_id) other.attendance = code;
  }
) {
  const request = jest.fn(async (_method: string, path: string) => {
    if (path.startsWith('/user/permissions/'))
      return {
        data: {
          record_form: {
            record_form_access: true,
            edit_records_access: true,
            records_edit_last_days_count: -1,
          },
        },
      };
    const id = Number(path.split('/').at(-1));
    return {
      data: {
        id,
        company_id: 7,
        ...appointments[id],
        datetime: '2026-09-24T10:00:00-03:00',
      },
    };
  });
  const postJson = jest.fn(async (path: string, body: object) => {
    const id = Number(path.split('/').at(-2));
    write(id, (body as { attendance: number }).attendance, appointments);
    return { attendance: (body as { attendance: number }).attendance };
  });
  const client = {
    request: request as unknown as AltegioClient['request'],
    postJson: postJson as unknown as AltegioClient['postJson'],
  } as AltegioClient;
  return { client, request, postJson, appointments };
}

async function preview(
  client: AltegioClient,
  selection: { appointment_ids: number[]; target_status: string }
) {
  return appointmentsPreviewAttendanceTool.createHandler(client)({
    location_id: 7,
    ...selection,
  });
}

async function apply(
  client: AltegioClient,
  selection: { appointment_ids: number[]; target_status: string },
  previewToken: unknown
) {
  return appointmentsApplyAttendanceTool.createHandler(client)({
    location_id: 7,
    ...selection,
    preview_token: previewToken,
  });
}

describe('attendance preview', () => {
  it('reports canonical statuses, visit groups and the edit rights', async () => {
    const { client, postJson } = location({
      1: { visit_id: 21, attendance: 0 },
      2: { visit_id: 21, attendance: -1 },
      3: { visit_id: 0, attendance: 2 },
    });
    const result = await preview(client, {
      appointment_ids: [1, 2, 3],
      target_status: 'arrived',
    });
    expect(content(result)).toMatchObject({
      appointments: [
        { id: 1, visit_id: 21, status: 'waiting' },
        { id: 2, visit_id: 21, status: 'no_show' },
        // A zero visit id means "no visit": the appointment stands alone.
        { id: 3, visit_id: null, status: 'confirmed' },
      ],
      groups: ['visit:21', 'appointment:3'],
      permission_check: {
        status: 'ok',
        can_open_appointment_form: true,
        can_edit_appointments: true,
        edit_window_days: -1,
      },
      atomic: false,
      linked_appointments_may_change: true,
    });
    expect(typeof content(result).preview_token).toBe('string');
    expectOutputContract(appointmentsPreviewAttendanceTool, result);
    expect(postJson).not.toHaveBeenCalled();
  });

  it('refuses an appointment of another location', async () => {
    const { client, request } = location({
      1: { visit_id: 21, attendance: 0 },
    });
    request.mockResolvedValueOnce({ data: { id: 1, company_id: 9 } } as never);
    const result = await preview(client, {
      appointment_ids: [1],
      target_status: 'arrived',
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('does not belong to location 7');
  });
});

describe('attendance apply', () => {
  const one = { appointment_ids: [1], target_status: 'arrived' };

  it('refuses a stale preview before any write', async () => {
    const { client, postJson, appointments } = location({
      1: { visit_id: 21, attendance: 0 },
    });
    const token = content(await preview(client, one)).preview_token;
    appointments[1]!.attendance = -1;
    const result = await apply(client, one, token);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('changed since the preview');
    expect(postJson).not.toHaveBeenCalled();
  });

  it('refuses a token minted for another selection', async () => {
    const { client, postJson } = location({
      1: { visit_id: 21, attendance: 0 },
    });
    const token = content(await preview(client, one)).preview_token;
    const result = await apply(
      client,
      { appointment_ids: [1], target_status: 'no_show' },
      token
    );
    expect(result.isError).toBe(true);
    expect(postJson).not.toHaveBeenCalled();
  });

  it('writes once per visit group and skips a group already at the target', async () => {
    const { client, postJson } = location({
      1: { visit_id: 21, attendance: 1 },
      2: { visit_id: 21, attendance: 0 },
      3: { visit_id: 22, attendance: 1 },
    });
    const selection = { appointment_ids: [1, 2, 3], target_status: 'arrived' };
    const token = content(await preview(client, selection)).preview_token;
    const result = await apply(client, selection, token);
    expect(result.isError).toBeUndefined();
    expect(content(result)).toEqual({
      location_id: 7,
      target_status: 'arrived',
      complete: true,
      outcomes: [
        { group: 'visit:21', appointment_id: 2, outcome: 'updated' },
        {
          group: 'visit:22',
          appointment_id: 3,
          outcome: 'already_target_status',
        },
      ],
    });
    expectOutputContract(appointmentsApplyAttendanceTool, result);
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(postJson).toHaveBeenCalledWith('/company/7/records/2/attendance', {
      attendance: 1,
    });
  });

  it('stops after a failed group and keeps the earlier confirmed one', async () => {
    const { client } = location(
      {
        1: { visit_id: 21, attendance: 0 },
        2: { visit_id: 22, attendance: 0 },
      },
      (id, code, store) => {
        if (id === 2) throw new AltegioApiError('forbidden', 403);
        store[id]!.attendance = code;
      }
    );
    const selection = { appointment_ids: [1, 2], target_status: 'arrived' };
    const token = content(await preview(client, selection)).preview_token;
    const result = await apply(client, selection, token);
    expect(result.isError).toBe(true);
    expect(content(result)).toMatchObject({
      complete: false,
      outcomes: [
        { group: 'visit:21', appointment_id: 1, outcome: 'updated' },
        {
          group: 'visit:22',
          appointment_id: 2,
          outcome: 'write_failed',
          http_status: 403,
        },
      ],
    });
    // The failed call still returns a result strict clients accept.
    expectOutputContract(appointmentsApplyAttendanceTool, result);
    // The API's own refusal follows our sentence.
    expect(result.content[0]!.text).toMatch(
      /rolled back automatically\. forbidden$/
    );
  });

  it('marks an accepted write that the re-read does not confirm', async () => {
    const { client } = location(
      { 1: { visit_id: 21, attendance: 0 } },
      () => undefined
    );
    const token = content(await preview(client, one)).preview_token;
    const result = await apply(client, one, token);
    expect(result.isError).toBe(true);
    expect(content(result).outcomes).toEqual([
      { group: 'visit:21', appointment_id: 1, outcome: 'write_unverified' },
    ]);
  });
});
