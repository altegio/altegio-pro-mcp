/**
 * The paid-seat and work-schedule choice for a new team member.
 *
 * Quick-create takes two switches this server never defaults:
 * `is_paid_staff` (does the team member take a paid staff seat) and
 * `has_timetable_access` (are they in the work schedule, so they can have
 * working hours and take appointments). On per-seat licensing a paid seat is
 * billed, the API refuses an active team member without `is_paid_staff` and a
 * non-paid one with schedule access; elsewhere the API ignores `is_paid_staff`
 * and leaves schedule access off. A default would either spend the owner's
 * money or silently keep someone off the schedule, so both are asked of the
 * owner — `create_staff` and `onboarding_add_staff_batch` refuse a missing
 * value instead of guessing one.
 */
import { z } from 'zod';

export const PAID_SEAT_MISSING =
  'Missing. Ask the location owner whether this team member takes a paid staff seat — on per-seat licensing a paid seat is billed, so never choose it for them — then pass true or false.';

export const SCHEDULE_ACCESS_MISSING =
  'Missing. Ask the location owner whether this team member should be in the work schedule, able to have working hours and take appointments — on per-seat licensing only a paid team member can — then pass true or false.';

/** Our message for an absent value; zod's own for a wrong type. */
function missingMessage(message: string) {
  return (issue: { input?: unknown }) =>
    issue.input === undefined ? message : undefined;
}

/** A required `is_paid_staff` whose absence tells the model to ask. */
export const paidSeatChoice = z.boolean({
  error: missingMessage(PAID_SEAT_MISSING),
});

/** A required `has_timetable_access` whose absence tells the model to ask. */
export const scheduleAccessChoice = z.boolean({
  error: missingMessage(SCHEDULE_ACCESS_MISSING),
});

export interface MissingSeatChoice {
  /** 1-based position in the batch, as the owner would count the rows. */
  row: number;
  fields: Array<'is_paid_staff' | 'has_timetable_access'>;
}

/**
 * The refusal for a batch with unanswered rows. Row numbers only: names come
 * from the owner's file and are not echoed into our own text.
 */
export function seatChoiceRefusal(
  missing: readonly MissingSeatChoice[],
  total: number
): string {
  const rows = missing
    .map(({ row, fields }) => `row ${row} (${fields.join(', ')})`)
    .join('; ');
  return (
    `Refused: nothing was created. ${missing.length} of ${total} team members have no answer for the paid seat or the work schedule: ${rows}.\n\n` +
    'Ask the location owner, for each of them, and never choose for them:\n' +
    '- is_paid_staff: does this team member take a paid staff seat? On per-seat licensing a paid seat is billed.\n' +
    '- has_timetable_access: should they be in the work schedule, able to have working hours and take appointments? On per-seat licensing only a paid team member can.\n\n' +
    'Then call onboarding_add_staff_batch again with the answers per team member (JSON fields or CSV columns is_paid_staff and has_timetable_access), ' +
    'or once for the whole list with the batch-level is_paid_staff and has_timetable_access if the owner gave one answer for everybody.'
  );
}
