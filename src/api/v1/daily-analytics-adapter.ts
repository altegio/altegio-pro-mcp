import { type AltegioHttp, queryString } from '../altegio-http.js';
import type {
  DailyAnalyticsApi,
  DailySummary,
  TeamWorkload,
  TeamWorkloadQuery,
} from '../daily-analytics-api.js';
import { AnalyticsUnavailableError } from '../../capabilities/analytics/errors.js';
import { callEnveloped } from './analytics-http.js';

function unavailable(message: string): never {
  throw new AnalyticsUnavailableError(message, 502);
}

function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The documented workload is a fraction; never guess percent from magnitude. */
export function bookedShare(value: unknown): number | null {
  const parsed = numeric(value);
  if (parsed === null) {
    if (value === null || value === undefined) return null;
    return unavailable('The workload source returned an invalid booked share.');
  }
  if (parsed < 0 || parsed > 1) {
    return unavailable(
      'The workload source returned a booked share outside 0…1.'
    );
  }
  return parsed;
}

function day(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return unavailable(
      'The daily source did not return a valid calendar date.'
    );
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    return unavailable(
      'The daily source returned an impossible calendar date.'
    );
  }
  return value;
}

function teamQuery(query: TeamWorkloadQuery): string {
  const ids = query.team_member_ids;
  const suffix = queryString({
    start_date: query.date_from,
    end_date: query.date_to,
    team_member_id: ids?.length === 1 ? ids[0] : undefined,
  });
  return (
    suffix +
    (ids && ids.length > 1
      ? ids.map((id) => `&team_member_ids%5B%5D=${id}`).join('')
      : '')
  );
}

export class V1DailyAnalyticsAdapter implements DailyAnalyticsApi {
  constructor(private readonly http: AltegioHttp) {}

  async getTeamWorkload(query: TeamWorkloadQuery): Promise<TeamWorkload> {
    const rows = await callEnveloped<unknown>(
      this.http,
      `/locations/${query.location_id}/team_members/workload${teamQuery(query)}`,
      {
        kind: 'team_workload',
        context: 'read the selected team’s daily booked share',
      }
    );
    if (!Array.isArray(rows))
      return unavailable('The workload source did not return daily rows.');
    const points: TeamWorkload['points'] = [];
    const seen = new Set<string>();
    let excluded = 0;
    for (const row of rows) {
      if (!row || typeof row !== 'object')
        return unavailable(
          'The workload source returned an invalid daily row.'
        );
      const r = row as Record<string, unknown>;
      const date = day(r.date);
      if (date < query.date_from || date > query.date_to) {
        excluded++;
        continue;
      }
      if (seen.has(date))
        return unavailable('The workload source returned duplicate dates.');
      seen.add(date);
      points.push({ date, booked_share: bookedShare(r.workload) });
    }
    points.sort((a, b) => a.date.localeCompare(b.date));
    return { points, excluded_outside_period_count: excluded };
  }

  async getWorkingDays(query: TeamWorkloadQuery): Promise<string[]> {
    const rows = await callEnveloped<unknown>(
      this.http,
      `/locations/${query.location_id}/team_members/working_days${teamQuery(query)}`,
      {
        kind: 'team_workload',
        context: 'read the selected team’s working days',
      }
    );
    if (!Array.isArray(rows))
      return unavailable('The working-days source did not return dates.');
    return [
      ...new Set(
        rows
          .map(day)
          .filter((date) => date >= query.date_from && date <= query.date_to)
      ),
    ].sort();
  }

  async getDailySummary(query: {
    location_id: number;
    date: string;
  }): Promise<DailySummary> {
    const raw = await callEnveloped<unknown>(
      this.http,
      `/reports/day_report/${query.location_id}/${query.date}`,
      { kind: 'daily_summary', context: 'read the daily summary' }
    );
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      return unavailable('The daily summary source did not return metrics.');
    const r = raw as Record<string, unknown>;
    const date = day(
      typeof r.date_iso === 'string' ? r.date_iso.slice(0, 10) : r.date_iso
    );
    if (date !== query.date)
      return unavailable(
        'The daily summary returned a different day than requested. Narrow to an accessible day; do not label these figures as the requested day.'
      );
    return {
      date,
      clients_with_appointments_count: numeric(r.clients_count),
      booked_services_value: numeric(r.record_sum),
      completed_sales_value: numeric(r.visit_sum),
      product_sales_value: numeric(r.sale_sum),
      cash_received: numeric(r.transaction_sum),
      discounts_value: numeric(r.discount),
      average_check: numeric(r.average_income),
      average_workload_source_value: numeric(r.average_workload),
    };
  }
}
