/**
 * `[Appointments]` attendance workflow: preview, then apply by visit group.
 *
 * V1 changes attendance one appointment at a time, and one change can update
 * every appointment of the same visit. There is no bulk or atomic operation, so
 * the workflow is two calls. The preview reads the selected appointments and
 * binds that snapshot to a short-lived token. The apply re-reads them, refuses
 * when the token does not match the current snapshot, writes once per visit
 * group and re-reads after each write. Earlier groups are never rolled back.
 *
 * Statuses use the canonical appointment vocabulary of `get_appointments`
 * (waiting, confirmed, arrived, no_show); the V1 attendance codes stay here.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import {
  mintConfirmationToken,
  verifyConfirmationToken,
} from '../confirmation.js';
import { AltegioApiError, ExecutorRefusalError } from '../../utils/errors.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import type { AppointmentOutcome } from '../../api/clients-api.js';
import {
  OUTCOME_FROM_ATTENDANCE_CODE,
  OUTCOME_TO_ATTENDANCE_CODE,
} from '../../capabilities/clients/vocabulary.js';
import { probe } from '../../api/v1/probe.js';
import { readUserPermissions } from '../../api/v1/user-permissions.js';
import {
  asBoolean,
  asInteger,
  asPositiveId,
  asRecord,
  asText,
} from '../../api/v1/wire-values.js';

const PREVIEW_TOOL = 'appointments_preview_attendance';
const APPLY_TOOL = 'appointments_apply_attendance';
const MAX_APPOINTMENTS = 20;

const STATUSES = ['waiting', 'confirmed', 'arrived', 'no_show'] as const;
const OUTCOMES = [
  'updated',
  'already_target_status',
  'write_failed',
  'write_unverified',
] as const;

const objectSchema = (
  properties: Record<string, object>,
  optional: readonly string[] = []
) => ({
  type: 'object' as const,
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key)),
});
const statusSchema = { type: 'string', enum: STATUSES };

const selectionInput = z.object({
  location_id: z
    .number()
    .int()
    .positive()
    .describe(
      'Location of the appointments. Call list_locations when the id is unknown.'
    ),
  appointment_ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(MAX_APPOINTMENTS)
    .refine(
      (ids) => new Set(ids).size === ids.length,
      'Appointment ids must be unique.'
    )
    .describe(
      `1–${MAX_APPOINTMENTS} distinct appointment ids, from get_appointments.`
    ),
  target_status: z
    .enum(STATUSES)
    .describe(
      'Status to set: arrived (the client came), no_show, confirmed or waiting.'
    ),
});
type Selection = z.infer<typeof selectionInput>;

/** One selected appointment as the preview saw it. */
interface AppointmentSnapshot {
  id: number;
  visit_id: number | null;
  status: AppointmentOutcome;
  datetime: string | null;
}

/** Appointments of one visit change together; one without a visit stands alone. */
const groupKey = (appointment: AppointmentSnapshot): string =>
  appointment.visit_id !== null
    ? `visit:${appointment.visit_id}`
    : `appointment:${appointment.id}`;

/** What the preview token is bound to: the selection plus its snapshot. */
const tokenPayload = (
  selection: Selection,
  appointments: AppointmentSnapshot[]
) => ({
  location_id: selection.location_id,
  appointment_ids: selection.appointment_ids,
  target_status: selection.target_status,
  appointments,
});

/** Read the selected appointments in order; refuse any that cannot be changed safely. */
async function readSnapshot(
  client: AltegioClient,
  locationId: number,
  appointmentIds: readonly number[]
): Promise<AppointmentSnapshot[]> {
  const snapshot: AppointmentSnapshot[] = [];
  for (const id of appointmentIds) {
    const record = asRecord(
      (await client.request<unknown>('GET', `/record/${locationId}/${id}`)).data
    );
    if (
      asInteger(record.id) !== id ||
      asInteger(record.company_id) !== locationId
    )
      throw new ExecutorRefusalError(
        `Appointment ${id} does not belong to location ${locationId}. Check the id with get_appointments.`
      );
    const code = asInteger(record.attendance ?? record.visit_attendance);
    const status =
      code === null ? undefined : OUTCOME_FROM_ATTENDANCE_CODE[code];
    if (!status)
      throw new ExecutorRefusalError(
        `Appointment ${id} has an attendance status this workflow does not know. Inspect it with get_appointments.`
      );
    snapshot.push({
      id,
      visit_id: asPositiveId(record.visit_id),
      status,
      datetime: asText(record.datetime),
    });
  }
  return snapshot;
}

const httpStatus = (error: unknown): number | null =>
  error instanceof AltegioApiError ? (error.statusCode ?? null) : null;

export const appointmentsPreviewAttendanceTool = defineTool({
  name: PREVIEW_TOOL,
  category: 'Appointments',
  description: `[Appointments] Preview an attendance change for at most ${MAX_APPOINTMENTS} appointments. Reads each appointment’s current status and visit, plus the user’s appointment edit rights and edit window when available, and returns a preview token valid for ten minutes. Changing one appointment can change the other appointments of its visit, including unselected ones. The backend stays authoritative for the edit window, online payment and printed-receipt rules. Nothing is changed; pass the token to ${APPLY_TOOL}.`,
  annotations: {
    title: 'Preview attendance changes',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: selectionInput,
  outputSchema: objectSchema({
    location_id: { type: 'integer' },
    appointment_ids: { type: 'array', items: { type: 'integer' } },
    target_status: statusSchema,
    appointments: {
      type: 'array',
      items: objectSchema({
        id: { type: 'integer' },
        visit_id: { type: ['integer', 'null'] },
        status: statusSchema,
        datetime: { type: ['string', 'null'] },
      }),
    },
    groups: { type: 'array', items: { type: 'string' } },
    permission_check: objectSchema({
      status: {
        type: 'string',
        enum: ['ok', 'forbidden', 'not_found', 'unavailable'],
      },
      can_open_appointment_form: { type: ['boolean', 'null'] },
      can_edit_appointments: { type: ['boolean', 'null'] },
      edit_window_days: {
        type: ['integer', 'null'],
        description:
          'Days back the user may edit appointments; -1 is no limit.',
      },
    }),
    preview_token: { type: 'string' },
    atomic: { type: 'boolean' },
    linked_appointments_may_change: { type: 'boolean' },
  }),
  handler: async ({ input, client }) => {
    const appointments = await readSnapshot(
      client,
      input.location_id,
      input.appointment_ids
    );
    const rights = await probe(() =>
      readUserPermissions(client, input.location_id)
    );
    const form = rights.status === 'ok' ? (rights.data.record_form ?? {}) : {};
    const groups = [...new Set(appointments.map(groupKey))];
    const unchanged = appointments.filter(
      (a) => a.status === input.target_status
    ).length;
    return {
      text: `Previewed ${appointments.length} appointment(s) in ${groups.length} visit group(s); ${unchanged} already have status ${input.target_status}. One write per group can also change unselected appointments of the same visit, and the workflow is not atomic. Review, then call ${APPLY_TOOL} with the same selection and the preview token.`,
      structuredContent: {
        location_id: input.location_id,
        appointment_ids: input.appointment_ids,
        target_status: input.target_status,
        appointments,
        groups,
        permission_check: {
          status: rights.status,
          can_open_appointment_form: asBoolean(form.record_form_access),
          can_edit_appointments: asBoolean(form.edit_records_access),
          edit_window_days: asInteger(form.records_edit_last_days_count),
        },
        preview_token: mintConfirmationToken(
          PREVIEW_TOOL,
          tokenPayload(input, appointments)
        ),
        atomic: false,
        linked_appointments_may_change: true,
      },
    };
  },
});

type Outcome = (typeof OUTCOMES)[number];

interface GroupOutcome {
  group: string;
  appointment_id: number;
  outcome: Outcome;
  http_status?: number | null;
}

export const appointmentsApplyAttendanceTool = defineTool({
  name: APPLY_TOOL,
  category: 'Appointments',
  description: `[Appointments] Apply an attendance change previewed by ${PREVIEW_TOOL}. Pass the same location, appointment ids and target status with the preview token. Re-reads every appointment first and refuses when anything changed since the preview. Sends one single-appointment request per visit group, re-reads the selected appointments after each write and stops at the first failure. Earlier groups cannot be rolled back automatically; permissions, the edit window, online payment and a printed receipt may refuse a group.`,
  annotations: {
    title: 'Apply attendance changes',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: selectionInput.extend({
    preview_token: z
      .string()
      .min(1)
      .describe(
        `preview_token returned by ${PREVIEW_TOOL} for this selection.`
      ),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' },
    target_status: statusSchema,
    complete: { type: 'boolean' },
    outcomes: {
      type: 'array',
      items: objectSchema(
        {
          group: { type: 'string' },
          appointment_id: { type: 'integer' },
          outcome: { type: 'string', enum: OUTCOMES },
          http_status: { type: ['integer', 'null'] },
        },
        ['http_status']
      ),
    },
  }),
  confirm: {
    action: 'Change attendance',
    target: (input) =>
      `${input.appointment_ids.length} appointment(s) at location ${input.location_id} to ${input.target_status}`,
    consequence:
      'Other appointments of the same visits may also change, and completed groups cannot be rolled back automatically. Payments, loyalty and notifications may be triggered.',
  },
  handler: async ({ input, client }) => {
    const current = await readSnapshot(
      client,
      input.location_id,
      input.appointment_ids
    );
    if (
      !verifyConfirmationToken(
        input.preview_token,
        PREVIEW_TOOL,
        tokenPayload(input, current)
      )
    )
      throw new ExecutorRefusalError(
        `The preview token is invalid or expired, or the appointments changed since the preview. Run ${PREVIEW_TOOL} again before applying.`
      );

    const targetCode = OUTCOME_TO_ATTENDANCE_CODE[input.target_status];
    const outcomes: GroupOutcome[] = [];
    const stopped = (text: string) => ({
      text,
      isError: true,
      structuredContent: {
        location_id: input.location_id,
        target_status: input.target_status,
        complete: false,
        outcomes,
      },
    });

    for (const group of new Set(current.map(groupKey))) {
      const members = current.filter((a) => groupKey(a) === group);
      const pending = members.find((a) => a.status !== input.target_status);
      if (!pending) {
        outcomes.push({
          group,
          appointment_id: members[0]!.id,
          outcome: 'already_target_status',
        });
        continue;
      }
      try {
        await client.postJson(
          `/company/${input.location_id}/records/${pending.id}/attendance`,
          { attendance: targetCode }
        );
      } catch (error) {
        outcomes.push({
          group,
          appointment_id: pending.id,
          outcome: 'write_failed',
          http_status: httpStatus(error),
        });
        // An API error message is already our sentence plus the quoted
        // upstream detail, so it can follow ours as is.
        const reason =
          error instanceof AltegioApiError ? ` ${error.message}` : '';
        return stopped(
          `Stopped: the attendance write failed for ${group}. Earlier groups in this call cannot be rolled back automatically.${reason}`
        );
      }
      const after = await readSnapshot(
        client,
        input.location_id,
        members.map((a) => a.id)
      ).catch(() => null);
      if (!after || after.some((a) => a.status !== input.target_status)) {
        outcomes.push({
          group,
          appointment_id: pending.id,
          outcome: 'write_unverified',
        });
        return stopped(
          `The write for ${group} was accepted, but re-reading its appointments did not confirm status ${input.target_status}. Inspect the visit with get_appointments before retrying; earlier groups cannot be rolled back automatically.`
        );
      }
      outcomes.push({ group, appointment_id: pending.id, outcome: 'updated' });
    }

    const updated = outcomes.filter((o) => o.outcome === 'updated').length;
    return {
      text: `Set ${input.target_status} for ${outcomes.length} visit group(s): ${updated} updated and re-read, ${outcomes.length - updated} already had that status.`,
      structuredContent: {
        location_id: input.location_id,
        target_status: input.target_status,
        complete: true,
        outcomes,
      },
    };
  },
});
