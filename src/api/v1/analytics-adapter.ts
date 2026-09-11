/**
 * v1 implementation of the `AnalyticsApi` port (ADR-001 D5).
 *
 * This is the only file in the analytics pack that knows the legacy v1 field
 * names. Every legacy word (`master`, `goods`, `abonement`, `fullness`,
 * `income`, `record`, `attendance`, …) dies here: the port's DTOs, and
 * therefore everything the agent sees, use canonical product vocabulary.
 *
 * Money arrives as decimal **major units** — sometimes as a JSON string, so it
 * is parsed and rounded to two decimals — together with a `currency` object
 * whose ISO code is carried through. Percentages are plain numbers. `null`
 * means "the API did not report this number", which is not the same as `0`.
 */
import type { AltegioHttp } from '../altegio-http.js';
import { queryString, v2Path } from '../altegio-http.js';
import { callEnveloped, callRawArray } from './analytics-http.js';
import type {
  AnalyticsApi,
  AnalyticsFilterQuery,
  AnalyticsOverview,
  AppointmentSourceSlice,
  ClientVisitStats,
  ComparedValue,
  DailyPoint,
  DailySeries,
  DayEndReport,
  DayEndReportDetailRow,
  DayEndReportQuery,
  Forecast,
  ForecastQuery,
  LoyaltyProgramResults,
  LoyaltyQuery,
  NamedAmount,
  PeriodQuery,
  ReceptionistPerformance,
  ReceptionistQuery,
  ReportDataFilterOverride,
  ReportDefinition,
  ReportField,
  ReportTable,
  ReportTemplate,
  SavedReport,
  TeamMemberOccupancy,
  VisitStatusSlice,
} from '../analytics-api.js';
import {
  APPOINTMENT_SERIES_KEYS,
  CLIENTS_SERIES_KEYS,
  OCCUPANCY_SERIES_KEYS,
  REVENUE_SERIES_KEYS,
  REPORT_TEMPLATES,
  appointmentSourceFromLabel,
  canonicalizeLabel,
  datasetFromTable,
  datasetFromTemplateSlug,
  toFieldKey,
  visitStatusFromLabel,
  visitStatusToLegacyCode,
} from '../../capabilities/analytics/vocabulary.js';
import {
  chartPointToDay,
  toDottedDate,
} from '../../capabilities/analytics/periods.js';
import { AnalyticsInputError } from '../../capabilities/analytics/errors.js';

// ========== value parsing ==========

/** Parse a number that may arrive as a JSON string; `null` when absent. */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number | null, decimals: number): number | null {
  if (value === null) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Money in major units, rounded to two decimals. */
export function toMoney(value: unknown): number | null {
  return round(toNumber(value), 2);
}

/** A percentage, rounded to one decimal. */
export function toPercent(value: unknown): number | null {
  return round(toNumber(value), 1);
}

/** ISO code of a v1 `currency` include, or of the day-end report's bare string. */
export function toCurrencyCode(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() || null;
  if (!value || typeof value !== 'object') return null;
  const currency = value as { iso?: unknown; symbol?: unknown };
  if (typeof currency.iso === 'string' && currency.iso.trim())
    return currency.iso.trim();
  if (typeof currency.symbol === 'string' && currency.symbol.trim())
    return currency.symbol.trim();
  return null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `{current_sum, previous_sum, change_percent}` → canonical compared value. */
function comparedMoney(block: unknown): ComparedValue {
  const b = record(block);
  return {
    current: toMoney(b.current_sum),
    previous: toMoney(b.previous_sum),
    change_percent: toPercent(b.change_percent),
  };
}

function comparedCount(
  block: unknown,
  currentKey: string,
  previousKey: string
): ComparedValue {
  const b = record(block);
  return {
    current: toNumber(b[currentKey]),
    previous: toNumber(b[previousKey]),
    change_percent: toPercent(b.change_percent),
  };
}

// ========== query building ==========

function filterQuery(query: AnalyticsFilterQuery): string {
  return queryString({
    date_from: query.date_from,
    date_to: query.date_to,
    // v1 accepts the canonical alias on the wire, so no legacy name is sent.
    team_member_id: query.team_member_id,
    position_id: query.position_id,
    user_id: query.created_by_user_id,
  });
}

/** Turn a chart row into a canonical daily series. */
function toSeries(row: unknown, key: string, timezone: string): DailySeries {
  const r = record(row);
  const points: DailyPoint[] = [];
  for (const point of list(r.data)) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const day = chartPointToDay(point[0] as number | string, timezone);
    const value = toNumber(point[1]);
    points.push([day, value ?? 0] as const);
  }
  return {
    key,
    label: canonicalizeLabel(typeof r.label === 'string' ? r.label : key),
    points,
  };
}

// ========== the adapter ==========

export interface AdapterOptions {
  /** IANA timezone of the location, used to bucket chart timestamps. */
  timezone: string;
}

export class V1AnalyticsAdapter implements AnalyticsApi {
  constructor(
    private readonly http: AltegioHttp,
    private readonly options: AdapterOptions = { timezone: 'UTC' }
  ) {}

  private get tz(): string {
    return this.options.timezone;
  }

  // ---------- key metrics ----------

  async getOverview(query: AnalyticsFilterQuery): Promise<AnalyticsOverview> {
    const data = await callEnveloped<Record<string, unknown>>(
      this.http,
      `/company/${query.location_id}/analytics/overall${filterQuery(query)}`,
      { kind: 'metrics', context: 'read the key metrics of this location' }
    );

    const total = record(data.income_total_stats);
    const appointments = record(data.record_stats);
    const clients = record(data.client_stats);

    return {
      currency: toCurrencyCode(total.currency),
      revenue: {
        total: comparedMoney(data.income_total_stats),
        services: comparedMoney(data.income_services_stats),
        products: comparedMoney(data.income_goods_stats),
      },
      average_check: comparedMoney(data.income_average_stats),
      average_services_check: comparedMoney(data.income_average_services_stats),
      occupancy_percent: comparedCount(
        data.fullness_stats,
        'current_percent',
        'previous_percent'
      ),
      appointments: {
        total_count: toNumber(appointments.current_total_count),
        previous_total_count: toNumber(appointments.previous_total_count),
        change_percent: toPercent(appointments.change_percent),
        completed_count: toNumber(appointments.current_completed_count),
        completed_percent: toPercent(appointments.current_completed_percent),
        pending_count: toNumber(appointments.current_pending_count),
        pending_percent: toPercent(appointments.current_pending_percent),
        cancelled_count: toNumber(appointments.current_canceled_count),
        cancelled_percent: toPercent(appointments.current_canceled_percent),
      },
      clients: {
        total_in_base: toNumber(clients.total_count),
        new_count: toNumber(clients.new_count),
        new_percent: toPercent(clients.new_percent),
        returning_count: toNumber(clients.return_count),
        returning_percent: toPercent(clients.return_percent),
        active_count: toNumber(clients.active_count),
        lost_count: toNumber(clients.lost_count),
        lost_percent: toPercent(clients.lost_percent),
      },
    };
  }

  // ---------- daily series ----------

  private async chart(
    query: AnalyticsFilterQuery,
    chart: string,
    context: string
  ): Promise<unknown[]> {
    return callRawArray(
      this.http,
      `/company/${query.location_id}/analytics/overall/charts/${chart}${filterQuery(query)}`,
      { kind: 'charts', context }
    );
  }

  /** Series keyed by the API's own slug; unknown slugs keep a canonical fallback. */
  private bySlug(
    rows: unknown[],
    slugs: Readonly<Record<string, string>>
  ): DailySeries[] {
    const series: DailySeries[] = [];
    rows.forEach((row, index) => {
      const slug = record(row).slug;
      const key =
        typeof slug === 'string' && slugs[slug]
          ? slugs[slug]
          : (Object.values(slugs)[index] ?? `series_${index + 1}`);
      series.push(toSeries(row, key, this.tz));
    });
    return series;
  }

  async getRevenueDaily(query: AnalyticsFilterQuery): Promise<DailySeries[]> {
    const rows = await this.chart(
      query,
      'income_daily',
      'read the daily revenue series'
    );
    return this.bySlug(rows, REVENUE_SERIES_KEYS);
  }

  async getAppointmentsDaily(
    query: AnalyticsFilterQuery
  ): Promise<DailySeries[]> {
    const rows = await this.chart(
      query,
      'records_daily',
      'read the daily appointment series'
    );
    // This chart carries no slugs — only localized labels — so the positional
    // order of the three series is the only stable contract.
    return rows.map((row, index) =>
      toSeries(
        row,
        APPOINTMENT_SERIES_KEYS[index] ?? `appointments_series_${index + 1}`,
        this.tz
      )
    );
  }

  async getOccupancyDaily(query: AnalyticsFilterQuery): Promise<DailySeries[]> {
    const rows = await this.chart(
      query,
      'fullness_daily',
      'read the daily occupancy series'
    );
    return this.bySlug(rows, OCCUPANCY_SERIES_KEYS);
  }

  async getClientsDaily(query: AnalyticsFilterQuery): Promise<DailySeries[]> {
    const rows = await this.chart(
      query,
      'clients_daily',
      'read the daily client series'
    );
    return this.bySlug(rows, CLIENTS_SERIES_KEYS);
  }

  // ---------- breakdowns ----------

  async getAppointmentSourceBreakdown(
    query: AnalyticsFilterQuery
  ): Promise<AppointmentSourceSlice[]> {
    const rows = await this.chart(
      query,
      'record_source',
      'read where appointments come from'
    );
    return rows.map((row) => {
      const r = record(row);
      const label = typeof r.label === 'string' ? r.label : '';
      return {
        key: appointmentSourceFromLabel(label),
        label: canonicalizeLabel(label),
        count: toNumber(r.data) ?? 0,
      };
    });
  }

  async getVisitStatusBreakdown(
    query: AnalyticsFilterQuery
  ): Promise<VisitStatusSlice[]> {
    const rows = await this.chart(
      query,
      'record_status',
      'read appointments by visit status'
    );
    return rows.map((row) => {
      const r = record(row);
      const label = typeof r.label === 'string' ? r.label : '';
      return {
        key: visitStatusFromLabel(label) ?? 'other',
        label: canonicalizeLabel(label),
        count: toNumber(r.data) ?? 0,
      };
    });
  }

  // ---------- receptionist performance ----------

  private async receptionistMetric(
    query: ReceptionistQuery,
    endpoint: string,
    include: string | undefined,
    context: string
  ): Promise<Record<string, unknown>> {
    const search = queryString({
      date_from: query.date_from,
      date_to: query.date_to,
      user_id: query.created_by_user_id,
    });
    const includeParam =
      query.include_daily && include
        ? `${search ? '&' : '?'}include[]=${encodeURIComponent(include)}`
        : '';
    return callEnveloped<Record<string, unknown>>(
      this.http,
      `/company/${query.location_id}/analytics/administrator/${endpoint}${search}${includeParam}`,
      { kind: 'receptionist', context }
    );
  }

  private dailyFrom(
    data: Record<string, unknown>,
    listKey: string,
    valueKey: string
  ): DailyPoint[] | undefined {
    const rows = list(data[listKey]);
    if (rows.length === 0) return undefined;
    return rows.map((row) => {
      const r = record(row);
      return [String(r.date ?? ''), toNumber(r[valueKey]) ?? 0] as const;
    });
  }

  async getReceptionistPerformance(
    query: ReceptionistQuery
  ): Promise<ReceptionistPerformance> {
    const [booked, closed, revenue, afterVisit, afterNoShow] =
      await Promise.all([
        this.receptionistMetric(
          query,
          'clients_scheduled',
          'clients_count_daily',
          'read how many clients receptionists booked'
        ),
        this.receptionistMetric(
          query,
          'records_closed',
          'records_count_daily',
          'read how many appointments receptionists closed'
        ),
        this.receptionistMetric(
          query,
          'income',
          'income_sum_daily',
          'read the revenue attributed to receptionists'
        ),
        this.receptionistMetric(
          query,
          'visited_clients_rescheduled',
          'clients_count_daily',
          'read the rebooking rate after a visit'
        ),
        this.receptionistMetric(
          query,
          'canceled_clients_rescheduled',
          'clients_count_daily',
          'read the rebooking rate after a no-show'
        ),
      ]);

    const rate = (data: Record<string, unknown>) => {
      const base = toNumber(data.clients_count);
      const rebooked = toNumber(data.clients_rescheduled_count);
      return {
        clients_count: base,
        rebooked_count: rebooked,
        rate_percent:
          base && base > 0 && rebooked !== null
            ? round((rebooked / base) * 100, 1)
            : null,
      };
    };

    let daily: ReceptionistPerformance['daily'];
    if (query.include_daily) {
      const bookedDaily = this.dailyFrom(
        booked,
        'clients_count_daily',
        'clients_count'
      );
      const closedDaily = this.dailyFrom(
        closed,
        'records_count_daily',
        'records_count'
      );
      const revenueDaily = this.dailyFrom(
        revenue,
        'income_sum_daily',
        'income_sum'
      );
      daily = {
        ...(bookedDaily ? { clients_booked: bookedDaily } : {}),
        ...(closedDaily ? { appointments_closed: closedDaily } : {}),
        ...(revenueDaily ? { revenue: revenueDaily } : {}),
      };
    }

    return {
      currency: toCurrencyCode(revenue.currency),
      clients_booked: {
        current: toNumber(booked.clients_count),
        previous: toNumber(booked.previous_clients_count),
        change_percent: changePercent(
          toNumber(booked.clients_count),
          toNumber(booked.previous_clients_count)
        ),
      },
      appointments_closed: {
        current: toNumber(closed.records_count),
        previous: toNumber(closed.previous_records_count),
        change_percent: changePercent(
          toNumber(closed.records_count),
          toNumber(closed.previous_records_count)
        ),
      },
      revenue: {
        current: toMoney(revenue.income_sum),
        previous: toMoney(revenue.previous_income_sum),
        change_percent: changePercent(
          toMoney(revenue.income_sum),
          toMoney(revenue.previous_income_sum)
        ),
      },
      rebooked_after_visit: rate(afterVisit),
      rebooked_after_no_show: rate(afterNoShow),
      ...(daily && Object.keys(daily).length > 0 ? { daily } : {}),
    };
  }

  // ---------- loyalty programs ----------

  async getLoyaltyProgramResults(
    query: LoyaltyQuery
  ): Promise<LoyaltyProgramResults> {
    const search = queryString({
      loyalty_program_id: query.loyalty_program_id,
      date_from: query.date_from,
      date_to: query.date_to,
    });
    const base = `/company/${query.location_id}/analytics/loyalty_programs`;

    const [visits, revenue, perMember] = await Promise.all([
      callEnveloped<Record<string, unknown>>(
        this.http,
        `${base}/visits${search}&include[]=visits_stats_by_day`,
        { kind: 'loyalty', context: 'read loyalty program client results' }
      ),
      callEnveloped<Record<string, unknown>>(
        this.http,
        `${base}/income${search}&include[]=income_stats_by_day`,
        { kind: 'loyalty', context: 'read loyalty program revenue' }
      ),
      callEnveloped<unknown[]>(this.http, `${base}/staff${search}`, {
        kind: 'loyalty',
        context: 'read loyalty program results per team member',
      }),
    ]);

    const segment = (value: unknown) => {
      const s = record(value);
      return {
        all_count: toNumber(s.all_count),
        lost_count: toNumber(s.lost_count),
        returned_count: toNumber(s.returned_count),
        returned_percent: toPercent(s.returned_percent),
      };
    };
    const revenueSegment = (value: unknown) => {
      const s = record(value);
      return {
        all_total: toMoney(s.all_sum),
        returned_total: toMoney(s.returned_sum),
      };
    };

    const clientStats = record(visits.client_stats);
    const revenueStats = record(revenue.income_stats);

    return {
      currency: toCurrencyCode(revenue.currency),
      clients: {
        new: segment(clientStats.new),
        returning: segment(clientStats.old),
        total: segment(clientStats.total),
      },
      revenue: {
        new: revenueSegment(revenueStats.new),
        returning: revenueSegment(revenueStats.old),
        total: revenueSegment(revenueStats.total),
      },
      visits_by_day: list(visits.visits_stats_by_day).map((row) => {
        const r = record(row);
        return {
          date: String(r.date ?? ''),
          new_count: toNumber(r.new_count),
          returning_count: toNumber(r.old_count),
        };
      }),
      revenue_by_day: list(revenue.income_stats_by_day).map((row) => {
        const r = record(row);
        return {
          date: String(r.date ?? ''),
          new_total: toMoney(r.new_sum),
          returning_total: toMoney(r.old_sum),
        };
      }),
      by_team_member: list(perMember).map((row) => {
        const r = record(row);
        const member = record(r.staff);
        const stats = segment(r.client_stats);
        return {
          team_member_id: toNumber(member.id),
          team_member_name:
            typeof member.name === 'string' ? member.name : null,
          clients: { new: stats, returning: stats, total: stats },
        };
      }),
    };
  }

  // ---------- forecast ----------

  async getForecast(query: ForecastQuery): Promise<Forecast> {
    const data = await callEnveloped<Record<string, unknown>>(
      this.http,
      `/company/${query.location_id}/analytics/rfm/overall${queryString({
        start_date: query.date_from,
        end_date: query.date_to,
      })}`,
      {
        kind: 'forecast',
        context: 'read the revenue and visits forecast',
      }
    );

    const revenue = record(data.income);
    const visits = record(data.visits_count);
    const revenueSeries = record(data.income_by_period);
    const visitsSeries = record(data.visits_count_by_period);

    const forecastPoints = list(revenueSeries.prediction);
    const revenueActual = list(revenueSeries.actual);
    const visitsForecast = list(visitsSeries.prediction);
    const visitsActual = list(visitsSeries.actual);

    const dates = new Set<string>();
    for (const bag of [
      forecastPoints,
      revenueActual,
      visitsForecast,
      visitsActual,
    ]) {
      for (const point of bag) {
        const date = record(point).date;
        if (typeof date === 'string') dates.add(date);
      }
    }
    const at = (bag: unknown[], date: string) => {
      const hit = bag.find((point) => record(point).date === date);
      return hit === undefined ? null : toNumber(record(hit).value);
    };

    const by_period = [...dates].sort().map((date) => ({
      date,
      revenue_forecast: round(at(forecastPoints, date), 2),
      revenue_actual: round(at(revenueActual, date), 2),
      visits_forecast: at(visitsForecast, date),
      visits_actual: at(visitsActual, date),
    }));

    const predictionDate =
      typeof data.prediction_date === 'string' ? data.prediction_date : null;

    return {
      prediction_date: predictionDate,
      currency: toCurrencyCode(revenue.currency ?? revenueSeries.currency),
      revenue: {
        forecast: toMoney(record(revenue.prediction).value),
        actual: toMoney(record(revenue.actual).value),
      },
      visits: {
        forecast: toNumber(record(visits.prediction).value),
        actual: toNumber(record(visits.actual).value),
      },
      granularity:
        typeof revenueSeries.period === 'string'
          ? revenueSeries.period
          : typeof visitsSeries.period === 'string'
            ? visitsSeries.period
            : null,
      by_period,
      is_empty: predictionDate === null && by_period.length === 0,
    };
  }

  // ---------- day-end report ----------

  async getDayEndReport(query: DayEndReportQuery): Promise<DayEndReport> {
    const statusCode = query.visit_status
      ? visitStatusToLegacyCode(query.visit_status)
      : null;
    const data = await callEnveloped<Record<string, unknown>>(
      this.http,
      `/reports/z_report/${query.location_id}${queryString({
        // The day-end report is the one endpoint on d.m.Y dates.
        start_date: toDottedDate(query.date_from),
        end_date: toDottedDate(query.date_to),
        master_id: query.team_member_id,
        status: statusCode,
      })}`,
      { kind: 'day_end_report', context: 'read the day-end report' }
    );

    const stats = record(data.stats);
    const paid = record(data.paids);
    const totals = record(paid.total);

    const named = (rows: unknown): NamedAmount[] =>
      list(rows).map((row) => {
        const r = record(row);
        return {
          title: canonicalizeLabel(String(r.title ?? '')),
          amount: toMoney(r.amount),
        };
      });

    const report: DayEndReport = {
      date_from: query.date_from,
      date_to: query.date_to,
      currency: toCurrencyCode(data.currency),
      totals: {
        clients_count: toNumber(stats.clients),
        average_per_client: toMoney(stats.clients_average),
        appointments_count: toNumber(stats.records),
        average_per_appointment: toMoney(stats.records_average),
        appointments_with_client_count: toNumber(stats.visit_records),
        average_per_appointment_with_client: toMoney(
          stats.visit_records_average
        ),
        appointments_without_client_count: toNumber(stats.non_visit_records),
        average_per_appointment_without_client: toMoney(
          stats.non_visit_records_average
        ),
        services_count: toNumber(stats.targets),
        services_revenue: toMoney(stats.targets_paid),
        products_count: toNumber(stats.goods),
        products_revenue: toMoney(stats.goods_paid),
        gift_cards_count: toNumber(stats.certificates),
        gift_cards_revenue: toMoney(stats.certificates_paid),
        memberships_count: toNumber(stats.abonement),
        memberships_revenue: toMoney(stats.abonement_paid),
      },
      takings_by_account: named(paid.accounts),
      write_offs: named(paid.discount),
      takings_total: toMoney(totals.accounts),
      write_offs_total: toMoney(totals.discount),
    };

    if (query.include_details) {
      report.details = this.dayEndDetails(data.z_data);
    }
    return report;
  }

  /**
   * Flatten `z_data` (unix-day → clients → team members → items).
   * Client names, phones and e-mails are dropped on purpose: the tool result
   * carries ids and money only, so no personal data leaves the location.
   */
  private dayEndDetails(zData: unknown): DayEndReportDetailRow[] {
    const rows: DayEndReportDetailRow[] = [];
    for (const [stamp, clients] of Object.entries(record(zData))) {
      const seconds = Number(stamp);
      const date = Number.isFinite(seconds)
        ? chartPointToDay(seconds * 1000, this.tz)
        : stamp;
      for (const client of list(clients)) {
        const c = record(client);
        for (const member of list(c.masters)) {
          const m = record(member);
          const items = (value: unknown) =>
            list(value).map((item) => {
              const i = record(item);
              return {
                title: canonicalizeLabel(String(i.item_title ?? '')),
                first_cost: toMoney(i.first_cost),
                discount: toMoney(i.discount),
                result_cost: toMoney(i.result_cost),
              };
            });
          const other = m.others;
          rows.push({
            date,
            client_id: toNumber(c.client_id),
            team_member_id: toNumber(m.master_id),
            services: items(m.service),
            products: items(m.good),
            other: Array.isArray(other)
              ? items(other)
              : other
                ? items([other])
                : [],
          });
        }
      }
    }
    return rows;
  }

  // ---------- occupancy and client visits ----------

  async getTeamMemberOccupancy(
    query: PeriodQuery & { team_member_id: number }
  ): Promise<TeamMemberOccupancy> {
    const rows = await callEnveloped<unknown[]>(
      this.http,
      `/company/${query.location_id}/staff/workload${queryString({
        start_date: query.date_from,
        end_date: query.date_to,
        team_member_id: query.team_member_id,
      })}`,
      {
        kind: 'occupancy',
        context: 'read the daily occupancy of this team member',
      }
    );
    return {
      team_member_id: query.team_member_id,
      points: list(rows).map((row) => {
        const r = record(row);
        return [String(r.date ?? ''), toPercent(r.workload) ?? 0] as const;
      }),
    };
  }

  async getClientVisitStats(query: {
    location_id: number;
    client_id: number;
  }): Promise<ClientVisitStats> {
    const payload = await callEnveloped<Record<string, unknown>>(
      this.http,
      v2Path(
        `/locations/${query.location_id}/clients/${query.client_id}/attendances_statistic`
      ),
      {
        kind: 'client_visits',
        context: 'read the visit history of this client',
      }
    );
    // JSON:API: `data.attributes`, with a flat fallback for the compact serializer.
    const attributes = record(
      record(payload).attributes ?? record(payload.data).attributes ?? payload
    );
    return {
      client_id: query.client_id,
      successful_visits_count: toNumber(
        attributes.successful_attendances_count
      ),
      failed_visits_count: toNumber(attributes.failed_attendances_count),
      spent_total: toMoney(attributes.spent_amount),
      paid_total: toMoney(attributes.paid_amount),
      client_account_balance: toMoney(attributes.balance_amount),
      last_visit_at:
        typeof attributes.last_successful_attendance_datetime === 'string'
          ? attributes.last_successful_attendance_datetime
          : null,
    };
  }

  // ---------- report builder ----------

  private builderPath(locationId: number, suffix: string): string {
    return `/company/${locationId}/analytics_constructor${suffix}`;
  }

  async listReportTemplates(query: {
    location_id: number;
    with_definition?: boolean;
  }): Promise<ReportTemplate[]> {
    const includes = query.with_definition
      ? '?include[]=report_template_columns&include[]=report_template_filters&include[]=report_template_groupings'
      : '';
    const rows = await callEnveloped<unknown[]>(
      this.http,
      this.builderPath(query.location_id, `/report_templates${includes}`),
      { kind: 'report_builder', context: 'list the report templates' }
    );

    return list(rows).map((row) => {
      const r = record(row);
      const slug = String(r.slug ?? '');
      const curated = REPORT_TEMPLATES[slug];
      const kind = r.type === 'dynamic' ? 'dynamic' : 'static';
      const template: ReportTemplate = {
        template_id: String(r.id ?? ''),
        slug,
        name: curated?.name ?? canonicalizeLabel(String(r.name ?? slug)),
        description: canonicalizeLabel(String(r.description ?? '')),
        kind,
        dataset: curated?.dataset ?? datasetFromTemplateSlug(slug),
        ...(curated?.answers ? { answers: curated.answers } : {}),
      };
      if (query.with_definition) {
        template.columns = list(r.report_template_columns).map((column) => {
          const c = record(column);
          return {
            column_id: String(c.column_id ?? ''),
            title: typeof c.title === 'string' ? c.title : null,
          };
        });
        template.filters = list(r.report_template_filters).map((filter) => {
          const f = record(filter);
          return {
            column_id: String(f.column_id ?? ''),
            operator: String(f.operator ?? '='),
            value: String(f.value ?? ''),
          };
        });
        template.groupings = list(r.report_template_groupings).map((grouping) =>
          String(record(grouping).column_id ?? '')
        );
      }
      return template;
    });
  }

  async listReportFields(query: {
    location_id: number;
  }): Promise<ReportField[]> {
    const rows = await callEnveloped<unknown[]>(
      this.http,
      this.builderPath(query.location_id, '/columns'),
      { kind: 'report_builder', context: 'list the report fields' }
    );

    const fields: ReportField[] = [];
    for (const row of list(rows)) {
      const r = record(row);
      const dataset = datasetFromTable(String(r.table_name ?? ''));
      if (!dataset) continue;
      const alias = String(r.column_name_alias ?? r.column_name ?? '');
      if (!alias) continue;
      const granularity = r.is_granularity === true || r.is_granularity === 1;
      const groupable = r.is_groupable === true || r.is_groupable === 1;
      fields.push({
        field_key: toFieldKey(alias),
        title: canonicalizeLabel(String(r.title ?? alias)),
        kind: granularity ? 'granularity' : groupable ? 'dimension' : 'metric',
        dataset,
        data_type: mapDataType(String(r.data_type_slug ?? '')),
        aggregation:
          typeof r.metric_type_slug === 'string' && r.metric_type_slug
            ? r.metric_type_slug
            : null,
        filterable: r.is_filterable === true || r.is_filterable === 1,
        is_curated: r.is_default === true || r.is_default === 1,
        column_id: String(r.id ?? ''),
      });
    }
    return fields;
  }

  async listSavedReports(query: {
    location_id: number;
  }): Promise<SavedReport[]> {
    const rows = await callEnveloped<unknown[]>(
      this.http,
      this.builderPath(query.location_id, '/reports'),
      { kind: 'report_builder', context: 'list the saved reports' }
    );
    return list(rows).map((row) => toSavedReport(row));
  }

  async getSavedReport(query: {
    location_id: number;
    report_id: string;
  }): Promise<SavedReport> {
    const data = await callEnveloped<unknown>(
      this.http,
      this.builderPath(
        query.location_id,
        `/reports/${encodeURIComponent(query.report_id)}?include[]=report_columns&include[]=report_filters&include[]=report_groupings&include[]=report_status`
      ),
      { kind: 'report_builder', context: 'read the saved report' }
    );
    return toSavedReport(data);
  }

  async createReport(query: {
    location_id: number;
    definition: ReportDefinition;
  }): Promise<SavedReport> {
    const data = await callEnveloped<unknown>(
      this.http,
      this.builderPath(query.location_id, '/reports'),
      {
        kind: 'report_builder',
        context: 'create the report',
        method: 'POST',
        body: toCreateBody(query.definition),
      }
    );
    return toSavedReport(data);
  }

  async updateReport(query: {
    location_id: number;
    report_id: string;
    definition: ReportDefinition;
  }): Promise<SavedReport> {
    const data = await callEnveloped<unknown>(
      this.http,
      this.builderPath(
        query.location_id,
        `/reports/${encodeURIComponent(query.report_id)}`
      ),
      {
        kind: 'report_builder',
        context: 'update the report',
        method: 'POST',
        body: toCreateBody(query.definition),
      }
    );
    return toSavedReport(data);
  }

  async runReport(query: {
    location_id: number;
    report_id: string;
    filters: ReportDataFilterOverride[];
    allow_stored_period_fallback?: boolean;
  }): Promise<ReportTable> {
    try {
      const data = await callEnveloped<Record<string, unknown>>(
        this.http,
        this.builderPath(
          query.location_id,
          `/reports/${encodeURIComponent(query.report_id)}/data`
        ),
        {
          kind: 'report_builder',
          context: 'run the report',
          method: 'POST',
          body: {
            filters: query.filters.map((filter) => ({
              id: filter.filter_id,
              operator: filter.operator,
              value: filter.value,
            })),
          },
        }
      );
      return toReportTable(data);
    } catch (error) {
      if (!query.allow_stored_period_fallback) throw error;

      // Some locations do not have the new report-data feature flag. Their
      // legacy rows endpoint can safely be used only for the period already
      // stored in the report; the capability layer verifies that condition.
      const rows = await callEnveloped<unknown[][]>(
        this.http,
        `/company/${query.location_id}/ac/${encodeURIComponent(query.report_id)}/data`,
        {
          kind: 'report_builder',
          context: 'run the saved report for its stored period',
          method: 'POST',
          body: { report_columns: [] },
        }
      );
      return toLegacyReportTable(rows);
    }
  }
}

// ========== free functions used by the adapter ==========

function changePercent(
  current: number | null,
  previous: number | null
): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return round(((current - previous) / previous) * 100, 1);
}

function mapDataType(slug: string): ReportField['data_type'] {
  switch (slug.toUpperCase()) {
    case 'NUMERICS':
      return 'number';
    case 'DATE':
      return 'date';
    case 'BOOLEAN':
      return 'boolean';
    default:
      return 'text';
  }
}

function reportStatus(value: unknown): SavedReport['status'] {
  if (!value || typeof value !== 'object') return null;
  const slug = (value as Record<string, unknown>).status_slug;
  return slug === 'pending' ||
    slug === 'success' ||
    slug === 'error' ||
    slug === 'deleted'
    ? slug
    : null;
}

function toSavedReport(value: unknown): SavedReport {
  const r = record(value);
  return {
    report_id: String(r.id ?? ''),
    name: canonicalizeLabel(String(r.name ?? '')),
    description: canonicalizeLabel(String(r.description ?? '')),
    kind: r.type === 'dynamic' ? 'dynamic' : 'static',
    template_id:
      typeof r.report_template_id === 'string' ? r.report_template_id : null,
    created_at: typeof r.created_at === 'string' ? r.created_at : null,
    status: reportStatus(r.report_status),
    filters: list(r.report_filters).map((filter) => {
      const f = record(filter);
      return {
        filter_id: String(f.id ?? ''),
        column_id: String(f.column_id ?? ''),
        operator: String(f.operator ?? '='),
        value: typeof f.value === 'string' ? f.value : null,
      };
    }),
    columns: list(r.report_columns).map((column) => {
      const c = record(column);
      return {
        report_column_id: String(c.id ?? ''),
        column_id: String(c.column_id ?? ''),
        title: typeof c.title === 'string' ? c.title : null,
      };
    }),
    groupings: list(r.report_groupings).map((grouping) => {
      const g = record(grouping);
      return {
        report_grouping_id: String(g.id ?? ''),
        column_id: String(g.column_id ?? ''),
      };
    }),
  };
}

function toCreateBody(definition: ReportDefinition): Record<string, unknown> {
  if (definition.columns.length === 0) {
    throw new AnalyticsInputError(
      'A report needs at least one field. Call analytics_list_report_fields to see what the dataset offers.'
    );
  }
  if (definition.groupings.length === 0) {
    throw new AnalyticsInputError(
      'A report needs at least one group_by field. Call analytics_list_report_fields and pick a field whose kind is "dimension" or "granularity".'
    );
  }
  return {
    name: definition.name.slice(0, 50),
    ...(definition.description
      ? { description: definition.description.slice(0, 200) }
      : {}),
    ...(definition.template_id
      ? { report_template_id: definition.template_id }
      : {}),
    type: definition.kind,
    report_columns: definition.columns.map((column) => ({
      column_id: column.column_id,
      ...(column.title ? { title: column.title.slice(0, 255) } : {}),
    })),
    report_filters: definition.filters.map((filter) => ({
      column_id: filter.column_id,
      operator: filter.operator,
      value: filter.value,
    })),
    report_groupings: definition.groupings.map((column_id) => ({ column_id })),
  };
}

/**
 * Flatten the builder's pivot response into a table.
 *
 * The response nests `header` (groupings + columns), `rows` and `summary`.
 * Column keys are the API's own `key` values, titled from the header; the
 * caller renames them to canonical field keys once it has the field catalogue.
 */
function toReportTable(data: Record<string, unknown>): ReportTable {
  const header = record(data.header);
  const columns: ReportTable['columns'] = [];
  const columnIdByKey = new Map<string, string>();

  for (const grouping of list(header.groupings)) {
    const g = record(grouping);
    const key = String(g.key ?? '');
    columns.push({ key, title: key });
    columnIdByKey.set(key, String(g.column_id ?? ''));
  }
  for (const column of list(header.columns)) {
    const c = record(column);
    const key = String(c.key ?? '');
    const bucket = record(c.detalization);
    const title =
      typeof bucket.from === 'string' ? `${key} ${bucket.from}` : key;
    columns.push({ key, title });
    columnIdByKey.set(key, String(c.column_id ?? ''));
  }

  const cellsOf = (row: unknown): Record<string, string | number | null> => {
    const r = record(row);
    const cells: Record<string, string | number | null> = {};
    for (const cell of [...list(r.groupings), ...list(r.columns)]) {
      const c = record(cell);
      const key = String(c.key ?? '');
      const value = c.value;
      cells[key] =
        value === null || value === undefined
          ? null
          : typeof value === 'number'
            ? value
            : String(value);
    }
    return cells;
  };

  const rows = list(data.rows).map(cellsOf);
  const totals = cellsOf(record(data.summary));

  return {
    columns,
    rows,
    totals,
    row_count: rows.length,
    column_ids: Object.fromEntries(columnIdByKey),
  };
}

/** Flatten the row/cell response returned by the legacy report-data API. */
function toLegacyReportTable(data: unknown[][]): ReportTable {
  const columns: ReportTable['columns'] = [];
  const columnIds: Record<string, string> = {};
  const seen = new Set<string>();
  const rows = list(data).map((rawRow) => {
    const row: Record<string, string | number | null> = {};
    for (const rawCell of list(rawRow)) {
      const cell = record(rawCell);
      const baseKey = String(
        cell.used_column_name ?? cell.column_id ?? cell.report_column_id ?? ''
      );
      if (!baseKey) continue;
      let key = baseKey;
      let suffix = 2;
      while (key in row) key = `${baseKey}_${suffix++}`;
      const value = cell.value;
      row[key] =
        value === null || value === undefined
          ? null
          : typeof value === 'number'
            ? value
            : String(value);
      if (!seen.has(key)) {
        seen.add(key);
        columns.push({ key, title: key });
        columnIds[key] = String(cell.column_id ?? '');
      }
    }
    return row;
  });

  return {
    columns,
    rows,
    totals: {},
    row_count: rows.length,
    column_ids: columnIds,
  };
}
