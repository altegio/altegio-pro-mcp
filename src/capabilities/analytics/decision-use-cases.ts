/** Task-oriented analytics assembled from stable read sources. */
import type { AltegioClient } from '../../providers/altegio-client.js';
import type {
  AltegioBooking,
  AltegioScheduleEntry,
  AltegioStaff,
} from '../../types/altegio.types.js';
import { V1LegacyAnalyticsAdapter } from '../../api/v1/legacy-analytics-adapter.js';
import { V1AnalyticsAdapter } from '../../api/v1/analytics-adapter.js';
import { httpFromClient } from '../../api/altegio-http.js';
import { AnalyticsInputError } from './errors.js';
import { previousPeriod, resolvePeriod, type PeriodInput } from './periods.js';
import { resolveLocationTimezone } from './location-timezone.js';
import { sanitizeUntrusted, UNTRUSTED_NOTE } from '../../tools/tool-result.js';

export interface DecisionAnalyticsResult {
  text: string;
  structuredContent: unknown;
}

const APPOINTMENT_PAGE_SIZE = 300;
const MAX_APPOINTMENT_PAGES = 10;
const MAX_TEAM_MEMBERS = 25;
const MATRIX_MEMBER_LIMIT = 10;
const MATRIX_SOURCE_PAGE_SIZE = 100;
const MATRIX_SOURCE_MAX_PAGES = 5;
const PROFIT_AND_LOSS_CATEGORY_LIMIT = 500;

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
}

function safe(value: string | null | undefined, maxChars = 180): string | null {
  return sanitizeUntrusted(value, { maxChars });
}

function statusOf(
  appointment: AltegioBooking
): 'waiting' | 'confirmed' | 'arrived' | 'no_show' | 'cancelled' | 'unknown' {
  if (appointment.deleted) return 'cancelled';
  const code = appointment.attendance ?? appointment.visit_attendance;
  if (code === 1) return 'arrived';
  if (code === -1) return 'no_show';
  if (code === 2 || (code === 0 && appointment.confirmed === 1))
    return 'confirmed';
  if (code === 0) return 'waiting';
  const value = appointment.status?.trim().toLowerCase();
  if (
    value &&
    ['waiting', 'confirmed', 'arrived', 'no_show', 'cancelled'].includes(value)
  ) {
    return value as ReturnType<typeof statusOf>;
  }
  return 'unknown';
}

type AppointmentService = AltegioBooking['services'][number];

function appointmentPrice(
  appointment: AltegioBooking,
  include: (service: AppointmentService) => boolean = () => true
): number | null {
  const services = (appointment.services ?? []).filter(include);
  if (services.length === 0) return null;
  let found = false;
  let total = 0;
  for (const service of services) {
    const price =
      typeof service.cost_to_pay === 'number'
        ? service.cost_to_pay
        : typeof service.cost === 'number'
          ? service.cost
          : null;
    if (price === null) continue;
    found = true;
    total += price * (service.amount ?? 1);
  }
  return found ? round(total) : null;
}

function appointmentDiscount(
  appointment: AltegioBooking,
  include: (service: AppointmentService) => boolean = () => true
): number | null {
  let found = false;
  let total = 0;
  for (const service of (appointment.services ?? []).filter(include)) {
    const before =
      typeof service.first_cost === 'number'
        ? service.first_cost
        : typeof service.manual_cost === 'number'
          ? service.manual_cost
          : null;
    const after =
      typeof service.cost_to_pay === 'number'
        ? service.cost_to_pay
        : typeof service.cost === 'number'
          ? service.cost
          : null;
    if (before === null || after === null) continue;
    found = true;
    total += Math.max(0, before - after) * (service.amount ?? 1);
  }
  return found ? round(total) : null;
}

async function fetchAppointments(
  client: AltegioClient,
  input: {
    location_id: number;
    date_from: string;
    date_to: string;
  }
): Promise<{ rows: AltegioBooking[]; truncated: boolean; pages: number }> {
  const rows: AltegioBooking[] = [];
  let page = 1;
  let full = false;
  for (; page <= MAX_APPOINTMENT_PAGES; page += 1) {
    const batch = await client.getBookings(input.location_id, {
      start_date: input.date_from,
      end_date: input.date_to,
      page,
      count: APPOINTMENT_PAGE_SIZE,
      with_deleted: 1,
      include_finance_transactions: 1,
    });
    rows.push(...batch);
    full = batch.length === APPOINTMENT_PAGE_SIZE;
    if (!full) break;
  }
  return {
    rows,
    truncated: full && page > MAX_APPOINTMENT_PAGES,
    pages: Math.min(page, MAX_APPOINTMENT_PAGES),
  };
}

async function selectTeamMembers(
  client: AltegioClient,
  input: {
    location_id: number;
    team_member_ids?: number[];
    position_ids?: number[];
    limit?: number;
  }
): Promise<{
  rows: AltegioStaff[];
  requested_count: number;
  truncated: boolean;
}> {
  const all = await client.getStaff(input.location_id);
  const requested = new Set(input.team_member_ids ?? []);
  const positions = new Set(input.position_ids ?? []);
  let selected = all.filter((member) => {
    if (requested.size > 0 && !requested.has(member.id)) return false;
    if (positions.size > 0 && !positions.has(member.position?.id ?? -1))
      return false;
    return true;
  });
  const requestedCount = selected.length;
  const limit = input.limit ?? MAX_TEAM_MEMBERS;
  selected = selected.slice(0, limit);
  return {
    rows: selected,
    requested_count: requestedCount,
    truncated: requestedCount > selected.length,
  };
}

interface MinuteInterval {
  start: number;
  end: number;
}

function minutes(value: string): number | null {
  const match = value.match(/^(\d{2}):(\d{2})/);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

function unionMinutes(intervals: MinuteInterval[]): number {
  const sorted = intervals
    .filter((item) => item.end > item.start)
    .sort((a, b) => a.start - b.start);
  let total = 0;
  let start: number | null = null;
  let end: number | null = null;
  for (const item of sorted) {
    if (start === null || end === null) {
      start = item.start;
      end = item.end;
    } else if (item.start <= end) {
      end = Math.max(end, item.end);
    } else {
      total += end - start;
      start = item.start;
      end = item.end;
    }
  }
  return total + (start === null || end === null ? 0 : end - start);
}

function intersection(
  interval: MinuteInterval,
  start: number,
  end: number
): MinuteInterval | null {
  const clipped = {
    start: Math.max(interval.start, start),
    end: Math.min(interval.end, end),
  };
  return clipped.end > clipped.start ? clipped : null;
}

function appointmentInterval(
  appointment: AltegioBooking
): { date: string; interval: MinuteInterval } | null {
  const source = appointment.datetime ?? appointment.date;
  const match = source?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
  if (!match) return null;
  const durationSeconds =
    appointment.seance_length ?? appointment.length ?? appointment.duration;
  if (typeof durationSeconds !== 'number' || durationSeconds <= 0) return null;
  const start = Number(match[2]) * 60 + Number(match[3]);
  return {
    date: match[1]!,
    interval: { start, end: start + durationSeconds / 60 },
  };
}

interface CapacityBucket {
  key: string;
  scheduled_hours: number;
  booked_hours: number;
  completed_utilized_hours: number;
  idle_hours: number;
  occupancy_percent: number | null;
  completed_appointments_count: number;
  no_show_appointments_count: number;
  cancelled_appointments_count: number;
  pending_appointments_count: number;
  revenue: number | null;
  revenue_per_scheduled_hour: number | null;
}

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

function weekday(date: string): string {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;
}

function capacityKey(
  granularity: 'hour_of_day' | 'weekday' | 'date_hour',
  date: string,
  hour: number
): string {
  if (granularity === 'hour_of_day')
    return `${String(hour).padStart(2, '0')}:00`;
  if (granularity === 'weekday') return weekday(date);
  return `${date}T${String(hour).padStart(2, '0')}:00`;
}

function calculateCapacity(args: {
  schedules: AltegioScheduleEntry[];
  appointments: AltegioBooking[];
  selectedIds: Set<number>;
  granularity: 'hour_of_day' | 'weekday' | 'date_hour';
}): { buckets: CapacityBucket[]; unscheduled_appointment_count: number } {
  const appointmentsByMemberDate = new Map<string, AltegioBooking[]>();
  let unscheduledAppointmentCount = 0;
  for (const appointment of args.appointments) {
    const teamMemberId = appointment.staff_id ?? appointment.staff?.id;
    const timed = appointmentInterval(appointment);
    if (!teamMemberId || !timed || !args.selectedIds.has(teamMemberId))
      continue;
    const key = `${teamMemberId}|${timed.date}`;
    const list = appointmentsByMemberDate.get(key) ?? [];
    list.push(appointment);
    appointmentsByMemberDate.set(key, list);
  }

  const sums = new Map<
    string,
    Omit<
      CapacityBucket,
      'key' | 'idle_hours' | 'occupancy_percent' | 'revenue_per_scheduled_hour'
    >
  >();
  const scheduledMemberDates = new Set<string>();
  for (const schedule of args.schedules) {
    const teamMemberId = schedule.team_member_id ?? schedule.staff_id;
    if (!teamMemberId || !args.selectedIds.has(teamMemberId)) continue;
    const slots = schedule.slots ?? [];
    if (slots.length === 0) continue;
    const memberDate = `${teamMemberId}|${schedule.date}`;
    scheduledMemberDates.add(memberDate);
    const dayAppointments = appointmentsByMemberDate.get(memberDate) ?? [];
    const scheduleIntervals = slots.flatMap((slot) => {
      const start = minutes(slot.from);
      const rawEnd = minutes(slot.to);
      if (start === null || rawEnd === null) return [];
      const end = rawEnd <= start ? rawEnd + 24 * 60 : rawEnd;
      return [{ start, end }];
    });
    for (let hour = 0; hour < 24; hour += 1) {
      const start = hour * 60;
      const end = start + 60;
      const scheduled = unionMinutes(
        scheduleIntervals.flatMap((item) => {
          const value = intersection(item, start, end);
          return value ? [value] : [];
        })
      );
      if (scheduled === 0) continue;
      const withinSchedule = (
        appointment: AltegioBooking
      ): MinuteInterval[] => {
        const timed = appointmentInterval(appointment);
        if (!timed) return [];
        const hourPart = intersection(timed.interval, start, end);
        if (!hourPart) return [];
        return scheduleIntervals.flatMap((slot) => {
          const clipped = intersection(hourPart, slot.start, slot.end);
          return clipped ? [clipped] : [];
        });
      };
      const bookedIntervals: MinuteInterval[] = (
        schedule.busy_intervals ?? []
      ).flatMap((busy) => {
        const busyStart = minutes(busy.from);
        const rawBusyEnd = minutes(busy.to);
        if (busyStart === null || rawBusyEnd === null) return [];
        const busyEnd =
          rawBusyEnd <= busyStart ? rawBusyEnd + 24 * 60 : rawBusyEnd;
        const hourPart = intersection(
          { start: busyStart, end: busyEnd },
          start,
          end
        );
        if (!hourPart) return [];
        return scheduleIntervals.flatMap((slot) => {
          const clipped = intersection(hourPart, slot.start, slot.end);
          return clipped ? [clipped] : [];
        });
      });
      const completedIntervals: MinuteInterval[] = [];
      let completed = 0;
      let noShow = 0;
      let cancelled = 0;
      let pending = 0;
      let revenue = 0;
      let revenueKnown = false;
      for (const appointment of dayAppointments) {
        const timed = appointmentInterval(appointment);
        if (!timed) continue;
        const startsHere =
          timed.interval.start >= start && timed.interval.start < end;
        const status = statusOf(appointment);
        if (startsHere) {
          if (status === 'arrived') completed += 1;
          else if (status === 'no_show') noShow += 1;
          else if (status === 'cancelled') cancelled += 1;
          else pending += 1;
        }
        const clipped = withinSchedule(appointment);
        if (clipped.length === 0 || status === 'cancelled') continue;
        bookedIntervals.push(...clipped);
        if (status === 'arrived') {
          completedIntervals.push(...clipped);
          const price = appointmentPrice(appointment);
          const duration = timed.interval.end - timed.interval.start;
          if (price !== null && duration > 0) {
            revenue +=
              price *
              (clipped.reduce(
                (sum, piece) => sum + piece.end - piece.start,
                0
              ) /
                duration);
            revenueKnown = true;
          }
        }
      }
      const key = capacityKey(args.granularity, schedule.date, hour);
      const current = sums.get(key) ?? {
        scheduled_hours: 0,
        booked_hours: 0,
        completed_utilized_hours: 0,
        completed_appointments_count: 0,
        no_show_appointments_count: 0,
        cancelled_appointments_count: 0,
        pending_appointments_count: 0,
        revenue: null,
      };
      current.scheduled_hours += scheduled / 60;
      current.booked_hours += unionMinutes(bookedIntervals) / 60;
      current.completed_utilized_hours += unionMinutes(completedIntervals) / 60;
      current.completed_appointments_count += completed;
      current.no_show_appointments_count += noShow;
      current.cancelled_appointments_count += cancelled;
      current.pending_appointments_count += pending;
      if (revenueKnown) current.revenue = (current.revenue ?? 0) + revenue;
      sums.set(key, current);
    }
  }

  for (const key of appointmentsByMemberDate.keys()) {
    if (!scheduledMemberDates.has(key)) {
      unscheduledAppointmentCount += (
        appointmentsByMemberDate.get(key) ?? []
      ).filter((row) => statusOf(row) !== 'cancelled').length;
    }
  }

  const weekdayOrder = new Map<string, number>(
    WEEKDAYS.map((day, index) => [day, index])
  );
  const buckets = [...sums.entries()]
    .map(([key, value]) => {
      const scheduled = value.scheduled_hours;
      const booked = Math.min(value.booked_hours, scheduled);
      return {
        key,
        scheduled_hours: round(scheduled),
        booked_hours: round(booked),
        completed_utilized_hours: round(value.completed_utilized_hours),
        idle_hours: round(Math.max(0, scheduled - booked)),
        occupancy_percent:
          scheduled > 0 ? round((booked / scheduled) * 100, 1) : null,
        completed_appointments_count: value.completed_appointments_count,
        no_show_appointments_count: value.no_show_appointments_count,
        cancelled_appointments_count: value.cancelled_appointments_count,
        pending_appointments_count: value.pending_appointments_count,
        revenue: value.revenue === null ? null : round(value.revenue),
        revenue_per_scheduled_hour:
          value.revenue === null || scheduled <= 0
            ? null
            : round(value.revenue / scheduled),
      };
    })
    .sort((a, b) => {
      if (args.granularity === 'weekday')
        return (weekdayOrder.get(a.key) ?? 9) - (weekdayOrder.get(b.key) ?? 9);
      return a.key.localeCompare(b.key);
    });
  return {
    buckets,
    unscheduled_appointment_count: unscheduledAppointmentCount,
  };
}

export interface CapacityHeatmapInput extends PeriodInput {
  location_id: number;
  team_member_ids?: number[];
  position_ids?: number[];
  granularity: 'hour_of_day' | 'weekday' | 'date_hour';
}

export async function getCapacityHeatmap(
  client: AltegioClient,
  input: CapacityHeatmapInput
): Promise<DecisionAnalyticsResult> {
  const timezone = await resolveLocationTimezone(client, input.location_id);
  const period = resolvePeriod(input, timezone);
  if (input.granularity === 'date_hour' && period.days > 31) {
    throw new AnalyticsInputError(
      'date_hour granularity is limited to 31 days. Use weekday or hour_of_day for a longer period.'
    );
  }
  const selection = await selectTeamMembers(client, input);
  const ids = selection.rows.map((row) => row.id);
  const [schedules, appointments] = await Promise.all([
    ids.length === 0
      ? Promise.resolve([])
      : client.getTeamMemberSchedules(input.location_id, {
          start_date: period.date_from,
          end_date: period.date_to,
          team_member_ids: ids,
          include_busy_intervals: true,
        }),
    fetchAppointments(client, {
      location_id: input.location_id,
      date_from: period.date_from,
      date_to: period.date_to,
    }),
  ]);
  const calculated = calculateCapacity({
    schedules,
    appointments: appointments.rows,
    selectedIds: new Set(ids),
    granularity: input.granularity,
  });
  const ranked = calculated.buckets.filter(
    (row) => row.scheduled_hours > 0 && row.occupancy_percent !== null
  );
  const peaks = [...ranked]
    .sort((a, b) => b.occupancy_percent! - a.occupancy_percent!)
    .slice(0, 3);
  const underutilized = [...ranked]
    .sort((a, b) => a.occupancy_percent! - b.occupancy_percent!)
    .slice(0, 3);
  return {
    text: `Capacity heatmap for ${period.date_from}–${period.date_to}: ${calculated.buckets.length} bucket(s), ${ids.length} team member(s). Peak occupancy ${peaks[0]?.occupancy_percent ?? 'n/a'}%.`,
    structuredContent: {
      location_id: input.location_id,
      period: { ...period, timezone },
      granularity: input.granularity,
      team_member_ids: ids,
      buckets: calculated.buckets,
      peak_buckets: peaks,
      underutilized_buckets: underutilized,
      coverage: {
        complete: !selection.truncated && !appointments.truncated,
        selected_team_members: ids.length,
        available_team_members: selection.requested_count,
        appointment_pages_read: appointments.pages,
        appointment_page_cap: MAX_APPOINTMENT_PAGES,
        unscheduled_appointment_count: calculated.unscheduled_appointment_count,
        notes: [
          'Scheduled hours are the denominator; time without a work schedule is never labelled idle.',
          'Booked hours are the union of reported busy intervals and non-cancelled appointment intervals inside scheduled time, so appointments, group events and overlaps are counted once.',
          'Completed utilization includes arrived appointments only; booked utilization also includes pending, confirmed and no-show appointments.',
        ],
      },
      provenance: [
        {
          source: 'GET /company/{location_id}/staff/schedule',
          metrics: ['scheduled_hours'],
        },
        {
          source: 'GET /records/{location_id}',
          metrics: [
            'booked_hours_from_appointments',
            'completed_utilized_hours',
            'appointment_counts',
            'revenue',
          ],
        },
        {
          source:
            'GET /company/{location_id}/staff/schedule include=busy_intervals',
          metrics: ['booked_hours_from_busy_intervals'],
        },
      ],
    },
  };
}

function compared(current: number | null, previous?: number | null) {
  if (previous === undefined) return { current };
  return {
    current,
    previous,
    change_percent:
      current === null || previous === null || previous === 0
        ? null
        : round(((current - previous) / Math.abs(previous)) * 100, 1),
  };
}

export interface ProfitAndLossInput extends PeriodInput {
  location_id: number;
  include_comparison?: boolean;
  comparison_date_from?: string;
  comparison_date_to?: string;
}

export async function getProfitAndLossStatement(
  client: AltegioClient,
  input: ProfitAndLossInput
): Promise<DecisionAnalyticsResult> {
  const timezone = await resolveLocationTimezone(client, input.location_id);
  const period = resolvePeriod(input, timezone);
  const legacy = new V1LegacyAnalyticsAdapter(client);
  const api = new V1AnalyticsAdapter(httpFromClient(client), { timezone });
  const serviceInput = {
    location_id: input.location_id,
    date_from: period.date_from,
    date_to: period.date_to,
    page: 1,
    page_size: 1,
    group_by: 'service' as const,
  };
  const [ledger, sales, serviceContribution] = await Promise.all([
    legacy.getProfitAndLoss({
      location_id: input.location_id,
      date_from: period.date_from,
      date_to: period.date_to,
    }),
    api.getDayEndReport({
      location_id: input.location_id,
      date_from: period.date_from,
      date_to: period.date_to,
    }),
    legacy.getServiceProfitability(serviceInput),
  ]);

  let comparison:
    | {
        period: { date_from: string; date_to: string };
        ledger: typeof ledger;
        sales: typeof sales;
        contribution: typeof serviceContribution;
      }
    | undefined;
  if (
    input.include_comparison ||
    input.comparison_date_from ||
    input.comparison_date_to
  ) {
    const explicit = input.comparison_date_from || input.comparison_date_to;
    if (explicit && !(input.comparison_date_from && input.comparison_date_to)) {
      throw new AnalyticsInputError(
        'comparison_date_from and comparison_date_to must be supplied together.'
      );
    }
    const comparisonPeriod = explicit
      ? resolvePeriod(
          {
            date_from: input.comparison_date_from,
            date_to: input.comparison_date_to,
          },
          timezone
        )
      : previousPeriod(period);
    const [previousLedger, previousSales, previousContribution] =
      await Promise.all([
        legacy.getProfitAndLoss({
          location_id: input.location_id,
          date_from: comparisonPeriod.date_from,
          date_to: comparisonPeriod.date_to,
        }),
        api.getDayEndReport({
          location_id: input.location_id,
          date_from: comparisonPeriod.date_from,
          date_to: comparisonPeriod.date_to,
        }),
        legacy.getServiceProfitability({
          ...serviceInput,
          date_from: comparisonPeriod.date_from,
          date_to: comparisonPeriod.date_to,
        }),
      ]);
    comparison = {
      period: comparisonPeriod,
      ledger: previousLedger,
      sales: previousSales,
      contribution: previousContribution,
    };
  }

  const stream = (
    key:
      | 'services_revenue'
      | 'products_revenue'
      | 'memberships_revenue'
      | 'gift_cards_revenue'
  ) => compared(sales.totals[key], comparison?.sales.totals[key]);
  const categoryKey = (row: (typeof ledger.categories)[number]): string =>
    `${row.direction}:${row.category_id ?? row.title ?? ''}`;
  const currentCategories = new Map(
    ledger.categories.map((row) => [categoryKey(row), row])
  );
  const comparisonCategories = new Map(
    (comparison?.ledger.categories ?? []).map((row) => [categoryKey(row), row])
  );
  const categoryKeys = [
    ...new Set([...currentCategories.keys(), ...comparisonCategories.keys()]),
  ];
  const categoryCount = categoryKeys.length;
  const categories = categoryKeys
    .slice(0, PROFIT_AND_LOSS_CATEGORY_LIMIT)
    .map((key) => {
      const current = currentCategories.get(key);
      const prior = comparisonCategories.get(key);
      const identity = current ?? prior!;
      return {
        category_id: identity.category_id,
        title: safe(current?.title ?? prior?.title),
        direction: identity.direction,
        amount: compared(
          current?.amount ?? null,
          comparison ? (prior?.amount ?? null) : undefined
        ),
      };
    });
  const contributionMargin = (
    report: typeof serviceContribution
  ): number | null => {
    const revenue =
      (report.totals.cash_or_card_revenue ?? 0) +
      (report.totals.payments.client_accounts ?? 0);
    return report.totals.profit === null || revenue === 0
      ? null
      : round((report.totals.profit / revenue) * 100, 1);
  };
  return {
    text: `Tracked operating result for ${period.date_from}–${period.date_to}: ${ledger.tracked_operating_result ?? 'unavailable'} ${ledger.currency ?? ''}. This is not labelled net profit because external cost coverage cannot be proven.`,
    structuredContent: {
      location_id: input.location_id,
      period: { ...period, timezone },
      ...(comparison ? { comparison_period: comparison.period } : {}),
      currency:
        ledger.currency ?? sales.currency ?? serviceContribution.currency,
      sales_revenue_by_stream: {
        services: stream('services_revenue'),
        products: stream('products_revenue'),
        memberships: stream('memberships_revenue'),
        gift_cards: stream('gift_cards_revenue'),
        other: {
          current: null,
          reason:
            'The stable sales source does not expose a non-overlapping other stream.',
        },
        formula:
          'Each stream is read from the day-end report. These memo figures are not added to ledger income, which already contains posted sales transactions.',
      },
      operating_ledger: {
        income_total: compared(
          ledger.income_total,
          comparison?.ledger.income_total
        ),
        expense_total: compared(
          ledger.expense_total,
          comparison?.ledger.expense_total
        ),
        tracked_operating_result: compared(
          ledger.tracked_operating_result,
          comparison?.ledger.tracked_operating_result
        ),
        categories,
        category_coverage: {
          total_count: categoryCount,
          returned: categories.length,
          limit: PROFIT_AND_LOSS_CATEGORY_LIMIT,
          complete: categories.length === categoryCount,
        },
        formula:
          'Tracked operating result is the signed total of posted income and expense transactions in the location finance report.',
      },
      service_contribution: {
        cash_or_card_revenue: compared(
          serviceContribution.totals.cash_or_card_revenue,
          comparison?.contribution.totals.cash_or_card_revenue
        ),
        client_account_payments: compared(
          serviceContribution.totals.payments.client_accounts,
          comparison?.contribution.totals.payments.client_accounts
        ),
        consumables_cost: compared(
          serviceContribution.totals.consumables_cost,
          comparison?.contribution.totals.consumables_cost
        ),
        team_member_compensation: compared(
          serviceContribution.totals.team_member_compensation,
          comparison?.contribution.totals.team_member_compensation
        ),
        contribution_result: compared(
          serviceContribution.totals.profit,
          comparison?.contribution.totals.profit
        ),
        contribution_margin_percent: compared(
          contributionMargin(serviceContribution),
          comparison ? contributionMargin(comparison.contribution) : undefined
        ),
        formula:
          'Service contribution result = cash-or-card service revenue + client-account payments - service consumables cost - attributed team-member compensation.',
      },
      cost_classification: {
        direct_service_costs: {
          consumables: serviceContribution.totals.consumables_cost,
          team_member_compensation:
            serviceContribution.totals.team_member_compensation,
          total:
            serviceContribution.totals.consumables_cost === null ||
            serviceContribution.totals.team_member_compensation === null
              ? null
              : round(
                  serviceContribution.totals.consumables_cost +
                    serviceContribution.totals.team_member_compensation
                ),
          scope: 'Services represented in the service-contribution source.',
        },
        indirect_costs: null,
        indirect_costs_unavailable_reason:
          'Posted expense categories do not carry a reliable direct-versus-indirect classification, so the tool preserves the categories instead of guessing.',
      },
      gross_result: null,
      net_profit: null,
      completeness: {
        result_label: 'tracked_operating_result',
        included_cost_classes: [
          'posted_finance_expense_categories',
          'service_consumables_cost',
          'attributed_team_member_compensation',
        ],
        missing_or_unproven_cost_classes: [
          'retail_product_cost',
          'taxes_completeness',
          'rent_completeness',
          'external_payroll_completeness',
          'unposted_expenses',
        ],
        limitations: [
          'Finance categories reflect only posted transactions visible to the current user.',
          'Sales stream figures are memo breakdowns and are not added to finance income, preventing double counting.',
          'Service contribution covers service economics only and is not a location-wide gross result.',
        ],
      },
      provenance: [
        {
          source: 'GET /finances_reports/annual_report/{location_id}/',
          format: 'HTML',
          metrics: ['operating_ledger'],
        },
        {
          source: 'GET /reports/z_report/{location_id}',
          format: 'JSON',
          metrics: ['sales_revenue_by_stream'],
        },
        {
          source: 'GET /analytics_services/services_search/{location_id}/',
          format: 'JSON envelope with HTML table',
          metrics: ['service_contribution'],
        },
      ],
      untrusted_data_note: UNTRUSTED_NOTE,
    },
  };
}

export interface RevenueLeakageInput extends PeriodInput {
  location_id: number;
  team_member_ids?: number[];
  service_ids?: number[];
  service_category_ids?: number[];
  visit_statuses?: Array<ReturnType<typeof statusOf>>;
  include_capacity_opportunity?: boolean;
}

export async function getRevenueLeakage(
  client: AltegioClient,
  input: RevenueLeakageInput
): Promise<DecisionAnalyticsResult> {
  const timezone = await resolveLocationTimezone(client, input.location_id);
  const period = resolvePeriod(input, timezone);
  const appointments = await fetchAppointments(client, {
    location_id: input.location_id,
    date_from: period.date_from,
    date_to: period.date_to,
  });
  let serviceCategories = new Map<number, number>();
  if ((input.service_category_ids?.length ?? 0) > 0) {
    const services = await client.getServices(input.location_id);
    serviceCategories = new Map(
      services.flatMap((service) =>
        typeof service.category_id === 'number'
          ? [[service.id, service.category_id] as const]
          : []
      )
    );
  }
  const members = new Set(input.team_member_ids ?? []);
  const services = new Set(input.service_ids ?? []);
  const categories = new Set(input.service_category_ids ?? []);
  const statuses = new Set(input.visit_statuses ?? []);
  const serviceMatches = (service: AppointmentService): boolean =>
    (services.size === 0 || services.has(service.id)) &&
    (categories.size === 0 ||
      categories.has(serviceCategories.get(service.id) ?? -1));
  const rows = appointments.rows.filter((appointment) => {
    const memberId = appointment.staff_id ?? appointment.staff?.id;
    if (members.size > 0 && (!memberId || !members.has(memberId))) return false;
    if (statuses.size > 0 && !statuses.has(statusOf(appointment))) return false;
    if (
      (services.size > 0 || categories.size > 0) &&
      !(appointment.services ?? []).some(serviceMatches)
    )
      return false;
    return true;
  });
  const filteredPrice = (appointment: AltegioBooking): number | null =>
    appointmentPrice(appointment, serviceMatches);
  const filteredDiscount = (appointment: AltegioBooking): number | null =>
    appointmentDiscount(appointment, serviceMatches);

  const category = (
    key: string,
    selected: AltegioBooking[],
    amount: (row: AltegioBooking) => number | null,
    quality: 'high' | 'medium' | 'low',
    formula: string
  ) => {
    const amounts = selected.map(amount).filter((v): v is number => v !== null);
    return {
      key,
      observed_count: selected.length,
      observed_amount:
        key === 'discounts' ? round(amounts.reduce((a, b) => a + b, 0)) : null,
      estimated_opportunity_amount:
        key === 'discounts' || amounts.length === 0
          ? null
          : round(amounts.reduce((a, b) => a + b, 0)),
      formula,
      denominator: `${selected.length} matching appointment(s)`,
      coverage: {
        amount_available_count: amounts.length,
        amount_missing_count: selected.length - amounts.length,
      },
      quality,
    };
  };
  const noShows = rows.filter((row) => statusOf(row) === 'no_show');
  const cancelled = rows.filter((row) => statusOf(row) === 'cancelled');
  const completedUnpaid = rows.filter(
    (row) => statusOf(row) === 'arrived' && row.paid_full === 0
  );
  const discounted = rows.filter((row) => (filteredDiscount(row) ?? 0) > 0);
  const currency = rows
    .flatMap((row) => (row.services ?? []).filter(serviceMatches))
    .map((service) => service.currency)
    .find((value): value is string => Boolean(value));
  const outputCategories: unknown[] = [
    category(
      'no_show_appointments',
      noShows,
      filteredPrice,
      'high',
      'Estimated opportunity = sum of the final booked service prices on no-show appointments; it is not recognized revenue.'
    ),
    category(
      'cancelled_appointments',
      cancelled,
      filteredPrice,
      'medium',
      'Estimated opportunity = sum of retained final booked service prices on cancelled appointments; deleted rows without prices remain count-only.'
    ),
    category(
      'completed_but_not_marked_paid',
      completedUnpaid,
      filteredPrice,
      'low',
      'The observed count uses arrived appointments whose paid-in-full flag is false. The estimated amount uses booked prices because the list source does not expose a reliable outstanding balance.'
    ),
    category(
      'discounts',
      discounted,
      filteredDiscount,
      'high',
      'Observed reduction = sum of max(0, pre-reduction service price - final service price) × quantity. It is an observed reduction, not necessarily avoidable loss.'
    ),
    {
      key: 'loyalty_write_offs',
      observed_count: null,
      observed_amount: null,
      estimated_opportunity_amount: null,
      formula: null,
      denominator: null,
      coverage: {
        available: false,
        reason:
          'The appointment source does not separate loyalty write-offs from other reductions.',
      },
      quality: 'unavailable',
    },
  ];

  if (input.include_capacity_opportunity !== false) {
    const selection = await selectTeamMembers(client, {
      location_id: input.location_id,
      team_member_ids: input.team_member_ids,
    });
    const ids = selection.rows.map((row) => row.id);
    const schedules =
      ids.length === 0
        ? []
        : await client.getTeamMemberSchedules(input.location_id, {
            start_date: period.date_from,
            end_date: period.date_to,
            team_member_ids: ids,
            include_busy_intervals: true,
          });
    const capacity = calculateCapacity({
      schedules,
      appointments: rows,
      selectedIds: new Set(ids),
      granularity: 'date_hour',
    });
    const idleHours = capacity.buckets.reduce(
      (sum, row) => sum + row.idle_hours,
      0
    );
    const completedHours = capacity.buckets.reduce(
      (sum, row) => sum + row.completed_utilized_hours,
      0
    );
    const revenue = capacity.buckets.reduce(
      (sum, row) => sum + (row.revenue ?? 0),
      0
    );
    const rate = completedHours > 0 ? revenue / completedHours : null;
    outputCategories.push({
      key: 'scheduled_but_unbooked_capacity',
      observed_count: null,
      observed_amount: null,
      opportunity_capacity_hours: round(idleHours),
      estimated_opportunity_amount:
        rate === null ? null : round(idleHours * rate),
      formula:
        'Opportunity capacity = scheduled hours - union of non-cancelled booked intervals. Optional estimate = opportunity capacity hours × completed-service revenue per completed utilized hour.',
      denominator:
        rate === null
          ? 'No completed utilized hours with attributable prices.'
          : `${round(completedHours)} completed utilized hour(s)`,
      coverage: {
        selected_team_members: ids.length,
        available_team_members: selection.requested_count,
      },
      quality: rate === null ? 'insufficient_data' : 'low',
    });
  }

  return {
    text: `Revenue leakage signals for ${period.date_from}–${period.date_to}: ${noShows.length} no-show, ${cancelled.length} cancelled and ${completedUnpaid.length} completed appointment(s) not marked paid. Observed reductions and estimated opportunity are kept separate.`,
    structuredContent: {
      location_id: input.location_id,
      period: { ...period, timezone },
      currency: currency ?? null,
      categories: outputCategories,
      totals: null,
      totals_not_combined_reason:
        'Observed reductions, unpaid-risk estimates and capacity opportunity are different concepts and can overlap, so the tool does not add them into one leakage number.',
      coverage: {
        complete: !appointments.truncated,
        appointment_pages_read: appointments.pages,
        appointment_page_cap: MAX_APPOINTMENT_PAGES,
        limitations: [
          'The appointment source does not expose a reliable outstanding balance per completed visit.',
          'Loyalty-specific write-offs are not separated from other reductions at appointment level and are therefore not guessed.',
        ],
      },
      provenance: [
        {
          source: 'GET /records/{location_id}',
          metrics: [
            'appointment outcomes',
            'booked prices',
            'discount reductions',
          ],
        },
        {
          source: 'GET /company/{location_id}/staff/schedule',
          metrics: ['scheduled capacity'],
        },
      ],
    },
  };
}

async function mapWithConcurrency<T, R>(
  rows: readonly T[],
  limit: number,
  mapper: (row: T) => Promise<R>
): Promise<R[]> {
  const output = new Array<R>(rows.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, rows.length) },
    async () => {
      while (true) {
        const index = cursor++;
        if (index >= rows.length) return;
        output[index] = await mapper(rows[index]!);
      }
    }
  );
  await Promise.all(workers);
  return output;
}

export interface TeamMemberServiceMatrixInput extends PeriodInput {
  location_id: number;
  team_member_ids?: number[];
  position_ids?: number[];
  service_ids?: number[];
  service_category_id?: number;
  sort_by?: 'contribution_result' | 'revenue' | 'services_delivered';
  sort_order?: 'asc' | 'desc';
  minimum_sample_size?: number;
  page?: number;
  page_size?: number;
}

export async function getTeamMemberServiceMatrix(
  client: AltegioClient,
  input: TeamMemberServiceMatrixInput
): Promise<DecisionAnalyticsResult> {
  const timezone = await resolveLocationTimezone(client, input.location_id);
  const period = resolvePeriod(input, timezone);
  const selection = await selectTeamMembers(client, {
    ...input,
    limit: MATRIX_MEMBER_LIMIT,
  });
  const legacy = new V1LegacyAnalyticsAdapter(client);
  const pages = await mapWithConcurrency(selection.rows, 3, async (member) => {
    const reports = [];
    for (let page = 1; page <= MATRIX_SOURCE_MAX_PAGES; page += 1) {
      const report = await legacy.getServiceProfitability({
        location_id: input.location_id,
        date_from: period.date_from,
        date_to: period.date_to,
        page,
        page_size: MATRIX_SOURCE_PAGE_SIZE,
        group_by: 'service',
        team_member_id: member.id,
        ...(input.service_category_id
          ? { service_category_id: input.service_category_id }
          : {}),
      });
      reports.push(report);
      if (!report.page.has_more) break;
    }
    return { member, reports };
  });
  const serviceFilter = new Set(input.service_ids ?? []);
  const rows = pages.flatMap(({ member, reports }) =>
    reports.flatMap((report) =>
      report.rows
        .filter(
          (row) =>
            row.service_id !== null &&
            (serviceFilter.size === 0 || serviceFilter.has(row.service_id))
        )
        .map((row) => {
          const revenue = row.cash_or_card_revenue;
          return {
            team_member_id: member.id,
            team_member_name: safe(member.name),
            position_id: member.position?.id ?? null,
            position_title: safe(
              member.position?.title ?? member.specialization
            ),
            service_id: row.service_id,
            service_title: safe(row.title),
            service_category_id: input.service_category_id ?? null,
            service_category_title: safe(row.service_category_title),
            completed_appointments_count: null,
            services_delivered_count: row.services_count,
            clients_count: null,
            revenue,
            average_check:
              revenue === null || row.services_count === 0
                ? null
                : round(revenue / row.services_count),
            booked_duration_hours: null,
            delivered_duration_hours: null,
            occupancy_contribution_percent: null,
            team_member_compensation: row.team_member_compensation,
            consumables_cost: row.consumables_cost,
            contribution_result: row.profit,
            repeat_or_rebooking_rate_percent: null,
            sample_size: row.services_count,
          };
        })
    )
  );
  const teamTotals = new Map<number, number>();
  const serviceTotals = new Map<number, number>();
  for (const row of rows) {
    if (row.revenue === null || row.service_id === null) continue;
    teamTotals.set(
      row.team_member_id,
      (teamTotals.get(row.team_member_id) ?? 0) + row.revenue
    );
    serviceTotals.set(
      row.service_id,
      (serviceTotals.get(row.service_id) ?? 0) + row.revenue
    );
  }
  const withShares = rows.map((row) => ({
    ...row,
    revenue_share_within_team_member_percent:
      row.revenue === null || (teamTotals.get(row.team_member_id) ?? 0) === 0
        ? null
        : round((row.revenue / teamTotals.get(row.team_member_id)!) * 100, 1),
    revenue_share_within_service_percent:
      row.revenue === null ||
      row.service_id === null ||
      (serviceTotals.get(row.service_id) ?? 0) === 0
        ? null
        : round((row.revenue / serviceTotals.get(row.service_id)!) * 100, 1),
  }));
  const sortBy = input.sort_by ?? 'contribution_result';
  const direction = input.sort_order === 'asc' ? 1 : -1;
  withShares.sort((a, b) => {
    const left =
      sortBy === 'services_delivered'
        ? a.services_delivered_count
        : (a[sortBy] ?? Number.NEGATIVE_INFINITY);
    const right =
      sortBy === 'services_delivered'
        ? b.services_delivered_count
        : (b[sortBy] ?? Number.NEGATIVE_INFINITY);
    return (left - right) * direction;
  });
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? 50;
  const start = (page - 1) * pageSize;
  const minimum = input.minimum_sample_size ?? 3;
  const rankable = withShares.filter((row) => row.sample_size >= minimum);
  return {
    text: `Team-member × service matrix for ${period.date_from}–${period.date_to}: ${withShares.length} cell(s); showing page ${page}. Rankings exclude cells below ${minimum} delivered services.`,
    structuredContent: {
      location_id: input.location_id,
      period: { ...period, timezone },
      currency: pages[0]?.reports[0]?.currency ?? null,
      rows: withShares.slice(start, start + pageSize),
      page: {
        page,
        page_size: pageSize,
        total_count: withShares.length,
        returned: withShares.slice(start, start + pageSize).length,
        has_more: start + pageSize < withShares.length,
      },
      top_cells: rankable.slice(0, 5),
      bottom_cells: rankable.slice(-5).reverse(),
      ranking: {
        sort_by: sortBy,
        sort_order: input.sort_order ?? 'desc',
        minimum_sample_size: minimum,
        excluded_small_sample_cells: withShares.length - rankable.length,
      },
      coverage: {
        complete:
          !selection.truncated &&
          pages.every(({ reports }) => !reports.at(-1)?.page.has_more),
        selected_team_members: selection.rows.length,
        available_team_members: selection.requested_count,
        source_pages_per_team_member_cap: MATRIX_SOURCE_MAX_PAGES,
        unavailable_metrics: {
          completed_appointments_count:
            'The pair source counts delivered service lines, not distinct appointments.',
          clients_count:
            'The pair source does not expose distinct client ids or counts.',
          booked_duration_hours:
            'The pair source does not expose booked duration.',
          delivered_duration_hours:
            'The pair source does not expose delivered duration.',
          occupancy_contribution_percent:
            'The pair source does not expose schedule hours for the exact pair.',
          repeat_or_rebooking_rate_percent:
            'The pair source does not attribute return behavior to an exact team-member × service cell.',
        },
      },
      formulae: {
        average_check: 'cash-or-card service revenue / delivered service lines',
        contribution_result:
          'Source-defined service contribution after consumables and attributed compensation, including source-defined client-account treatment.',
        shares:
          'Cell cash-or-card revenue / the corresponding selected team-member or selected-service total.',
      },
      provenance: [
        {
          source: 'GET /analytics_services/services_search/{location_id}/',
          format: 'JSON envelope with HTML table',
          grouping:
            'One source report call per selected team member, genuinely grouped by service.',
        },
      ],
      untrusted_data_note: UNTRUSTED_NOTE,
    },
  };
}

export const INVENTORY_RISKS = [
  'stockout',
  'reorder_soon',
  'healthy',
  'slow_moving',
  'overstock',
  'insufficient_data',
] as const;
export type InventoryRisk = (typeof INVENTORY_RISKS)[number];

export function inventoryRisk(args: {
  current_stock: number | null;
  units_sold: number | null;
  period_days: number;
  lead_time_days: number;
  safety_stock_days: number;
}): {
  average_daily_sales: number | null;
  days_of_cover: number | null;
  risk: InventoryRisk;
  recommended_reorder_quantity: number | null;
} {
  const { current_stock: stock, units_sold: sold } = args;
  if (stock === null || sold === null || args.period_days <= 0 || sold < 0) {
    return {
      average_daily_sales: null,
      days_of_cover: null,
      risk: 'insufficient_data',
      recommended_reorder_quantity: null,
    };
  }
  const velocity = sold / args.period_days;
  if (stock < 0) {
    return {
      average_daily_sales: round(velocity, 4),
      days_of_cover: 0,
      risk: 'stockout',
      recommended_reorder_quantity:
        velocity > 0
          ? round(
              velocity * (args.lead_time_days + args.safety_stock_days) - stock,
              3
            )
          : null,
    };
  }
  if (velocity === 0) {
    return {
      average_daily_sales: 0,
      days_of_cover: null,
      risk: stock === 0 ? 'insufficient_data' : 'slow_moving',
      recommended_reorder_quantity: null,
    };
  }
  const cover = stock / velocity;
  const targetDays = args.lead_time_days + args.safety_stock_days;
  const risk: InventoryRisk =
    stock === 0
      ? 'stockout'
      : cover <= targetDays
        ? 'reorder_soon'
        : cover >= Math.max(90, targetDays * 3)
          ? 'overstock'
          : 'healthy';
  return {
    average_daily_sales: round(velocity, 4),
    days_of_cover: round(cover, 1),
    risk,
    recommended_reorder_quantity:
      risk === 'stockout' || risk === 'reorder_soon'
        ? round(Math.max(0, velocity * targetDays - stock), 3)
        : 0,
  };
}

export interface InventoryReorderRiskInput extends PeriodInput {
  location_id: number;
  inventory_id?: number;
  product_category_id?: number;
  supplier_id?: number;
  lead_time_days?: number;
  safety_stock_days?: number;
  risks?: InventoryRisk[];
  page?: number;
  page_size?: number;
}

export async function getInventoryReorderRisks(
  client: AltegioClient,
  input: InventoryReorderRiskInput
): Promise<DecisionAnalyticsResult> {
  const timezone = await resolveLocationTimezone(client, input.location_id);
  const period = resolvePeriod(input, timezone);
  const page = input.page ?? 1;
  const pageSize = input.page_size ?? 50;
  const lead = input.lead_time_days ?? 14;
  const safety = input.safety_stock_days ?? 7;
  const report = await new V1LegacyAnalyticsAdapter(
    client
  ).getInventoryTurnover({
    location_id: input.location_id,
    date_from: period.date_from,
    date_to: period.date_to,
    page,
    page_size: pageSize,
    ...(input.inventory_id ? { inventory_id: input.inventory_id } : {}),
    ...(input.product_category_id
      ? { product_category_id: input.product_category_id }
      : {}),
    ...(input.supplier_id ? { supplier_id: input.supplier_id } : {}),
  });
  const riskFilter = new Set(input.risks ?? []);
  const rows = report.rows
    .map((row) => {
      const calculated = inventoryRisk({
        current_stock: row.current_stock,
        units_sold: row.units_sold,
        period_days: period.days,
        lead_time_days: lead,
        safety_stock_days: safety,
      });
      return {
        product_id: row.product_id,
        sku: null,
        title: safe(row.product_title),
        unit: safe(row.unit, 40),
        supplier_title: safe(row.supplier_title),
        inventory_id: input.inventory_id ?? null,
        product_category_id: input.product_category_id ?? null,
        current_stock: row.current_stock,
        reserved_stock: null,
        available_stock: null,
        units_sold: row.units_sold,
        average_daily_sales: calculated.average_daily_sales,
        days_of_cover: calculated.days_of_cover,
        last_sale_date: null,
        stock_value: null,
        cost_per_unit: null,
        risk: calculated.risk,
        recommended_reorder_quantity: calculated.recommended_reorder_quantity,
        negative_stock: row.current_stock !== null && row.current_stock < 0,
        source_metrics: {
          units_received: row.units_received,
          opening_stock: row.opening_stock,
          average_stock: row.average_stock,
          turnover_days: row.source_turnover_days,
          turnover_count: row.source_turnover_count,
          stock_level_days: row.source_stock_level_days,
        },
      };
    })
    .filter((row) => riskFilter.size === 0 || riskFilter.has(row.risk));
  return {
    text: `Inventory reorder risks for ${period.date_from}–${period.date_to}: ${rows.length} product(s) on page ${page}; ${rows.filter((row) => row.risk === 'stockout' || row.risk === 'reorder_soon').length} need attention.`,
    structuredContent: {
      location_id: input.location_id,
      period: { ...period, timezone },
      assumptions: {
        lead_time_days: lead,
        safety_stock_days: safety,
      },
      rows,
      page: { ...report.page, returned_after_risk_filter: rows.length },
      formulae: {
        average_daily_sales: 'units_sold / inclusive period days',
        days_of_cover:
          'current_stock / average_daily_sales; null when sales velocity is zero',
        recommended_reorder_quantity:
          'max(0, average_daily_sales × (lead_time_days + safety_stock_days) - current_stock)',
        risk: 'stockout when stock is zero or negative with demand; reorder_soon when cover is at or below lead plus safety days; overstock at 90 days or three times the target, whichever is larger; positive stock with zero sales is slow_moving.',
      },
      coverage: {
        complete: !report.page.has_more,
        filters_supported_by_source: [
          'inventory_id',
          'product_category_id',
          'supplier_id',
        ],
        unavailable_fields: {
          sku: 'The turnover table does not expose a product code.',
          reserved_stock:
            'The turnover table does not distinguish reserved stock.',
          available_stock:
            'The turnover table does not distinguish available stock.',
          last_sale_date:
            'The turnover table exposes period sales volume, not the last sale date.',
          stock_value:
            'The turnover table does not expose an authorized cost value.',
          cost_per_unit:
            'The turnover table does not expose an authorized unit cost.',
        },
        multiple_inventories:
          input.inventory_id === undefined
            ? 'The source aggregates the selected period across all inventories visible to the report.'
            : 'The source is restricted to the requested inventory.',
      },
      provenance: [
        {
          source: 'GET /storages/turnover/search/{location_id}/',
          format: 'JSON envelope with HTML table',
          permission: 'inventory turnover report access',
        },
      ],
      untrusted_data_note: UNTRUSTED_NOTE,
    },
  };
}
