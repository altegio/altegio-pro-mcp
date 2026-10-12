/**
 * Find free appointment times: which team members can take the requested
 * services, and when, so `appointments_create` is called with a time the
 * calendar accepts instead of guessing until it stops answering 409.
 *
 * Inputs are the product's: a location, the services the appointment will
 * consist of, a date range and optionally one team member. The session length
 * is each team member's own length for each service (the service ↔ team member
 * link), so two team members can need different free windows for the same
 * services. A team member qualifies only when linked to every service — the
 * same rule `appointments_create` enforces with a 400.
 *
 * The calendar is read per team member and day, so the reads are bounded:
 * at most `MAX_CALENDAR_READS` per call, taken day by day; a range that needs
 * more is cut at a day boundary and continues from `next_date_from`.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import type { AltegioService } from '../../types/altegio.types.js';
import { AvailabilityAdapter } from '../../api/v1/availability-adapter.js';
import type {
  AvailabilityApi,
  CalendarCell,
} from '../../api/availability-api.js';
import { fitPrefixToBudget, windowPagination } from '../../tools/pagination.js';
import {
  withUntrustedBlock,
  type UntrustedField,
} from '../../tools/tool-result.js';

/** Longest date range one call accepts, in days. */
export const MAX_RANGE_DAYS = 7;
/** Calendar reads one call may make (team members × days). */
export const MAX_CALENDAR_READS = 28;
/** Calendar reads in flight at once; the API rate-limits per token. */
const CONCURRENCY = 4;

export interface FindFreeSlotsInput {
  location_id: number;
  service_ids: number[];
  date_from: string;
  date_to?: string;
  team_member_id?: number;
}

/** A free stretch long enough for the session, and the starts that fit it. */
export interface FreeWindow {
  team_member_id: number;
  date: string;
  /** Free from / to, `HH:MM`, location time. */
  free_from: string;
  free_to: string;
  /** Earliest and latest start that fits, `YYYY-MM-DDTHH:MM:00`. */
  first_start: string;
  last_start: string;
  /** Minutes between possible starts (the calendar step). */
  step_minutes: number;
  /** Session length this team member needs for the services. */
  session_length_seconds: number;
}

export interface AvailabilityResult {
  text: string;
  structuredContent?: unknown;
  isError?: boolean;
}

function api(client: AltegioClient): AvailabilityApi {
  return AvailabilityAdapter.forClient(client);
}

function minutesOf(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function hhmm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000
  );
}

/**
 * Free windows of one day's calendar that hold `sessionMinutes`.
 *
 * Cells are calendar steps; a window is a run of free cells with no gap (a
 * break between two working intervals has no cells at all, so it splits the
 * run). Any step-aligned start from the window's start to `end − session`
 * fits.
 */
export function freeWindows(
  cells: readonly CalendarCell[],
  sessionMinutes: number
): Array<{ from: number; to: number; lastStart: number; step: number }> {
  const sorted = [...cells]
    .map((cell) => ({ at: minutesOf(cell.time), free: cell.free }))
    .sort((a, b) => a.at - b.at);
  let step = Infinity;
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = sorted[i]!.at - sorted[i - 1]!.at;
    if (gap > 0 && gap < step) step = gap;
  }
  if (!Number.isFinite(step)) step = 5;

  const windows: Array<{
    from: number;
    to: number;
    lastStart: number;
    step: number;
  }> = [];
  let runStart: number | null = null;
  let runEnd = 0;
  const close = () => {
    if (runStart === null) return;
    const lastStart = runEnd - sessionMinutes;
    if (lastStart >= runStart) {
      windows.push({ from: runStart, to: runEnd, lastStart, step });
    }
    runStart = null;
  };
  for (const cell of sorted) {
    if (!cell.free) {
      close();
      continue;
    }
    if (runStart !== null && cell.at !== runEnd) close();
    if (runStart === null) runStart = cell.at;
    runEnd = cell.at + step;
  }
  close();
  return windows;
}

/** Run `tasks` with at most `limit` in flight, keeping their order. */
async function inBatches<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker)
  );
  return results;
}

function refusal(text: string): AvailabilityResult {
  return { text, isError: true };
}

export async function findFreeSlots(
  client: AltegioClient,
  input: FindFreeSlotsInput
): Promise<AvailabilityResult> {
  const dateTo = input.date_to ?? input.date_from;
  const span = daysBetween(input.date_from, dateTo);
  if (span < 0) {
    return refusal(
      `date_to (${dateTo}) is before date_from (${input.date_from}). Nothing was searched.`
    );
  }
  if (span >= MAX_RANGE_DAYS) {
    return refusal(
      `The range ${input.date_from} to ${dateTo} is longer than ${MAX_RANGE_DAYS} days. Search at most ${MAX_RANGE_DAYS} days per call (for example date_to=${addDays(input.date_from, MAX_RANGE_DAYS - 1)}), then continue from the next day.`
    );
  }

  const serviceIds = [...new Set(input.service_ids)];
  const all = await client.getServices(input.location_id);
  const byId = new Map(all.map((service) => [service.id, service]));
  const missing = serviceIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    return refusal(
      `Service ${missing.join(', ')} is not a service of location ${input.location_id}. Find service ids with services_list.`
    );
  }
  const services = serviceIds.map((id) => byId.get(id)!);

  // Team members linked to every requested service, with their total length.
  const lengths = new Map<number, number>();
  for (const [index, service] of services.entries()) {
    const links = new Map(
      (service.staff ?? []).map((link) => [link.id, link.seance_length])
    );
    if (index === 0) {
      for (const [id, length] of links) lengths.set(id, length);
      continue;
    }
    for (const id of [...lengths.keys()]) {
      const length = links.get(id);
      if (length === undefined) lengths.delete(id);
      else lengths.set(id, lengths.get(id)! + length);
    }
  }
  for (const [id, length] of lengths) {
    if (!(length > 0)) lengths.delete(id);
  }

  if (input.team_member_id !== undefined) {
    if (!lengths.has(input.team_member_id)) {
      const unlinked = services
        .filter(
          (service) =>
            !(service.staff ?? []).some(
              (link) => link.id === input.team_member_id
            )
        )
        .map((service) => service.id);
      return refusal(
        `Team member ${input.team_member_id} cannot take service ${unlinked.join(', ') || serviceIds.join(', ')}: not linked to it, so appointments_create would answer 400. ` +
          (lengths.size > 0
            ? `Team members linked to every requested service: ${[...lengths.keys()].join(', ')} — search without team_member_id, or `
            : '') +
          `link the team member with services_link_team_member first.`
      );
    }
    for (const id of [...lengths.keys()]) {
      if (id !== input.team_member_id) lengths.delete(id);
    }
  }
  if (lengths.size === 0) {
    return refusal(
      `No team member at location ${input.location_id} is linked to every requested service (${serviceIds.join(', ')}), so none can take this appointment. Link one with services_link_team_member, or split the services into separate appointments.`
    );
  }

  // Day by day, every candidate, within the read budget.
  const teamMembers = [...lengths.keys()].sort((a, b) => a - b);
  const allDates = Array.from({ length: span + 1 }, (_, i) =>
    addDays(input.date_from, i)
  );
  const daysServed = Math.max(
    1,
    Math.min(
      allDates.length,
      Math.floor(MAX_CALENDAR_READS / teamMembers.length)
    )
  );
  const dates = allDates.slice(0, daysServed);
  const readMembers =
    teamMembers.length > MAX_CALENDAR_READS
      ? teamMembers.slice(0, MAX_CALENDAR_READS)
      : teamMembers;
  const port = api(client);
  const reads = dates.flatMap((date) =>
    readMembers.map((teamMemberId) => ({ date, teamMemberId }))
  );
  const cells = await inBatches(
    reads.map(
      ({ date, teamMemberId }) =>
        () =>
          port.calendarCells(input.location_id, teamMemberId, date)
    ),
    CONCURRENCY
  );

  const windows: FreeWindow[] = [];
  reads.forEach(({ date, teamMemberId }, index) => {
    const seconds = lengths.get(teamMemberId)!;
    for (const w of freeWindows(cells[index]!, Math.ceil(seconds / 60))) {
      windows.push({
        team_member_id: teamMemberId,
        date,
        free_from: hhmm(w.from),
        free_to: hhmm(w.to),
        first_start: `${date}T${hhmm(w.from)}:00`,
        last_start: `${date}T${hhmm(w.lastStart)}:00`,
        step_minutes: w.step,
        session_length_seconds: seconds,
      });
    }
  });
  const nextDate =
    dates.length < allDates.length ? allDates[dates.length]! : null;
  const skippedMembers = teamMembers.slice(readMembers.length);

  return fitPrefixToBudget({
    items: windows,
    render: (served, cutAt) => {
      // A cut inside the windows continues from the day of the first one left.
      const resumeFrom =
        cutAt !== undefined ? windows[cutAt]!.date : (nextDate ?? null);
      const pagination = windowPagination({
        returned: served.length,
        has_more: resumeFrom !== null,
        next_date_from: resumeFrom,
        next_date_to: dateTo,
      });
      return renderSlots(input, services, dates, served, {
        lengths,
        pagination,
        skippedMembers,
      });
    },
  });
}

function renderSlots(
  input: FindFreeSlotsInput,
  services: readonly AltegioService[],
  dates: readonly string[],
  windows: readonly FreeWindow[],
  context: {
    lengths: ReadonlyMap<number, number>;
    pagination: ReturnType<typeof windowPagination>;
    skippedMembers: readonly number[];
  }
): AvailabilityResult {
  const { lengths, pagination, skippedMembers } = context;
  const serviceIds = services.map((service) => service.id);
  const lines = [
    `Free start times for service ${serviceIds.join(' + ')} at location ${input.location_id}, ${dates[0]} to ${dates[dates.length - 1]}: ${windows.length} free ${windows.length === 1 ? 'window' : 'windows'} across ${lengths.size} team ${lengths.size === 1 ? 'member' : 'members'}.`,
  ];
  if (windows.length > 0) {
    lines.push(
      'Any start from the first to the last start, on the step, fits; times are the location’s local time. A technical break set on a service needs extra free time after the session.'
    );
  }
  const byDay = new Map<string, FreeWindow[]>();
  for (const w of windows) {
    const key = `${w.date} · team member ${w.team_member_id} (session ${Math.round(w.session_length_seconds / 60)} min)`;
    byDay.set(key, [...(byDay.get(key) ?? []), w]);
  }
  for (const [key, list] of byDay) {
    lines.push(
      `- ${key}: ` +
        list
          .map((w) => {
            const first = w.first_start.slice(11, 16);
            const last = w.last_start.slice(11, 16);
            return `${first === last ? first : `${first}–${last}`} (free ${w.free_from}–${w.free_to})`;
          })
          .join('; ')
    );
  }
  if (windows.length === 0) {
    lines.push(
      'No free window holds the session on these days. Try later dates, another team member, or check working hours with schedules_get.'
    );
  }
  if (pagination.has_more) {
    lines.push(
      `More days to search: call again with date_from=${pagination.next_date_from}, date_to=${pagination.next_date_to}.`
    );
  }
  if (skippedMembers.length > 0) {
    lines.push(
      `Not searched (too many team members for one call): ${skippedMembers.join(', ')} — pass team_member_id to search one of them.`
    );
  }
  if (windows.length > 0) {
    const sample = windows[0]!;
    lines.push(
      `To book, call appointments_create with team_member_id, services [${serviceIds.map((id) => `{id: ${id}}`).join(', ')}], datetime = a start (e.g. ${sample.first_start}) and session_length = that team member's session (${sample.session_length_seconds} for team member ${sample.team_member_id}). A slot can be taken meanwhile; on a 409, search again.`
    );
  }

  const untrusted: UntrustedField[] = services.map((service) => ({
    label: `service ${service.id}`,
    value: service.title,
  }));
  return {
    text: withUntrustedBlock(lines.join('\n'), untrusted, { maxChars: 200 }),
    structuredContent: {
      location_id: input.location_id,
      service_ids: serviceIds,
      date_from: dates[0],
      date_to: dates[dates.length - 1],
      team_members: [...lengths].map(([team_member_id, seconds]) => ({
        team_member_id,
        session_length_seconds: seconds,
      })),
      items: windows,
      pagination,
    },
  };
}
