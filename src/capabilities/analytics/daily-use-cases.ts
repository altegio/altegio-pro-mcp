import type { AltegioClient } from '../../providers/altegio-client.js';
import { httpFromClient } from '../../api/altegio-http.js';
import { V1DailyAnalyticsAdapter } from '../../api/v1/daily-analytics-adapter.js';
import { AnalyticsInputError } from './errors.js';
import { resolveLocationTimezone } from './location-timezone.js';
import { resolvePeriod, type PeriodInput } from './periods.js';
import type { AnalyticsResult } from './use-cases.js';

async function context(
  client: AltegioClient,
  input: PeriodInput & { location_id: number }
) {
  const timezone = await resolveLocationTimezone(client, input.location_id);
  return {
    timezone,
    period: resolvePeriod(input, timezone),
    api: new V1DailyAnalyticsAdapter(httpFromClient(client)),
  };
}

export async function getTeamWorkload(
  client: AltegioClient,
  input: PeriodInput & {
    location_id: number;
    team_member_ids?: number[];
  }
): Promise<AnalyticsResult> {
  const ctx = await context(client, input);
  if (ctx.period.days > 93)
    throw new AnalyticsInputError(
      'Ask for at most 93 days of team workload at a time.'
    );
  const query = {
    location_id: input.location_id,
    date_from: ctx.period.date_from,
    date_to: ctx.period.date_to,
    team_member_ids: input.team_member_ids,
  };
  const [workload, workingDays] = await Promise.all([
    ctx.api.getTeamWorkload(query),
    ctx.api.getWorkingDays(query),
  ]);
  const measured = new Set(
    workload.points.filter((p) => p.booked_share !== null).map((p) => p.date)
  );
  const missing = workingDays.filter((date) => !measured.has(date));
  return {
    text: `Daily booked share for the selected visible active team, ${ctx.period.date_from}…${ctx.period.date_to}: ${workingDays.length} working day(s), ${missing.length} working day(s) without a measured share. Shares are fractions from 0 to 1. This aggregate is not a per-person ranking or idle hours.`,
    structuredContent: {
      location_id: input.location_id,
      period: { ...ctx.period, timezone: ctx.timezone },
      team_member_ids: input.team_member_ids ?? [],
      selection: input.team_member_ids
        ? 'selected_visible_active_team'
        : 'all_visible_active_team',
      points: workload.points,
      working_days: workingDays,
      coverage: {
        missing_working_days: missing,
        excluded_outside_period_count: workload.excluded_outside_period_count,
      },
    },
  };
}

export async function getDailySummary(
  client: AltegioClient,
  input: PeriodInput & { location_id: number }
): Promise<AnalyticsResult> {
  const ctx = await context(client, input);
  if (ctx.period.days !== 1)
    throw new AnalyticsInputError(
      'Daily summary needs exactly one day. Use period=today or yesterday, or equal date_from and date_to.'
    );
  const summary = await ctx.api.getDailySummary({
    location_id: input.location_id,
    date: ctx.period.date_from,
  });
  return {
    text: `Daily summary for ${summary.date}: booked service value ${summary.booked_services_value ?? 'unknown'}, completed sales value ${summary.completed_sales_value ?? 'unknown'}, cash received ${summary.cash_received ?? 'unknown'}. Completed sales already includes products; never add product sales again. Currency and the unit of average workload are not supplied by this source.`,
    structuredContent: {
      location_id: input.location_id,
      period: { ...ctx.period, timezone: ctx.timezone },
      ...summary,
      currency: null,
      money_unit: 'major',
      average_workload_unit: 'unspecified',
      definitions: {
        clients: 'Distinct clients with appointments, not attended clients.',
        completed_sales: 'Arrived service value plus product sales.',
        cash: 'Money received, separate from booked and completed value.',
      },
    },
  };
}
