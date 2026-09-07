/**
 * Analytics use cases — everything the `analytics_*` tools actually do.
 *
 * A use case takes the tool's parsed input plus an `AltegioClient`, resolves the
 * period in the location's timezone, calls the `AnalyticsApi` port, projects the
 * answer down to the size budget and returns the text summary next to the
 * structured content. Tools stay declarative; this layer is where the product
 * decisions live and where the tests aim.
 */
import type { AltegioClient } from '../../providers/altegio-client.js';
import { httpFromClient } from '../../api/altegio-http.js';
import { V1AnalyticsAdapter } from '../../api/v1/analytics-adapter.js';
import type {
  AnalyticsApi,
  ReportDataFilterOverride,
  ReportDefinition,
  ReportField,
  SavedReport,
} from '../../api/analytics-api.js';
import { AnalyticsInputError, AnalyticsUnavailableError } from './errors.js';
import {
  previousPeriod,
  resolvePeriod,
  type Period,
  type PeriodInput,
} from './periods.js';
import { resolveLocationTimezone } from './location-timezone.js';
import {
  dropEmptyDays,
  formatMoney,
  overviewSummary,
  projectReportTable,
  seriesSummary,
  tableSummary,
  toCsv,
  withShares,
  type RenamedTable,
} from './projections.js';
import {
  REPORT_ROW_CAP,
  putReportCsv,
  type StoredReport,
} from './report-store.js';
import { DATASET_TABLE, REPORT_TEMPLATES, type Dataset } from './vocabulary.js';

/** A `resource_link` content block, for output that does not fit inline. */
export interface ResourceLinkBlock {
  type: 'resource_link';
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface AnalyticsResult {
  text: string;
  structuredContent: unknown;
  /** Extra content blocks to append after the text summary. */
  extraContent?: ResourceLinkBlock[];
}

/** Name prefix of every report this server owns in a user's report builder. */
export const OWNED_REPORT_PREFIX = '[Altegio Assistant]';

interface Context {
  api: AnalyticsApi;
  timezone: string;
  period: Period;
  previous: { date_from: string; date_to: string };
}

async function context(
  client: AltegioClient,
  locationId: number,
  input: PeriodInput
): Promise<Context> {
  const timezone = await resolveLocationTimezone(client, locationId);
  const period = resolvePeriod(input, timezone);
  return {
    api: new V1AnalyticsAdapter(httpFromClient(client), { timezone }),
    timezone,
    period,
    previous: previousPeriod(period),
  };
}

/** Adapter without a period, for the endpoints that take none. */
function plainApi(client: AltegioClient, timezone: string): AnalyticsApi {
  return new V1AnalyticsAdapter(httpFromClient(client), { timezone });
}

function periodBlock(ctx: Context) {
  return {
    period: {
      date_from: ctx.period.date_from,
      date_to: ctx.period.date_to,
      days: ctx.period.days,
      timezone: ctx.timezone,
      ...(ctx.period.preset ? { preset: ctx.period.preset } : {}),
    },
    previous_period: ctx.previous,
  };
}

// ========== key metrics ==========

export interface OverviewInput extends PeriodInput {
  location_id: number;
  team_member_id?: number;
  position_id?: number;
  created_by_user_id?: number;
}

export async function getOverview(
  client: AltegioClient,
  input: OverviewInput
): Promise<AnalyticsResult> {
  const ctx = await context(client, input.location_id, input);
  const overview = await ctx.api.getOverview({
    location_id: input.location_id,
    date_from: ctx.period.date_from,
    date_to: ctx.period.date_to,
    ...(input.team_member_id ? { team_member_id: input.team_member_id } : {}),
    ...(input.position_id ? { position_id: input.position_id } : {}),
    ...(input.created_by_user_id
      ? { created_by_user_id: input.created_by_user_id }
      : {}),
  });

  return {
    text: overviewSummary(overview, ctx.period, ctx.previous),
    structuredContent: { ...periodBlock(ctx), ...overview },
  };
}

// ========== daily series ==========

export const DAILY_METRICS = [
  'revenue',
  'appointments',
  'occupancy',
  'clients',
] as const;
export type DailyMetric = (typeof DAILY_METRICS)[number];

export interface DailySeriesInput extends OverviewInput {
  metric: DailyMetric;
  /** Drop days whose value is 0, for a tighter result on long periods. */
  skip_empty_days?: boolean;
}

export async function getDailySeries(
  client: AltegioClient,
  input: DailySeriesInput
): Promise<AnalyticsResult> {
  const ctx = await context(client, input.location_id, input);
  const query = {
    location_id: input.location_id,
    date_from: ctx.period.date_from,
    date_to: ctx.period.date_to,
    ...(input.team_member_id ? { team_member_id: input.team_member_id } : {}),
    ...(input.position_id ? { position_id: input.position_id } : {}),
    ...(input.created_by_user_id
      ? { created_by_user_id: input.created_by_user_id }
      : {}),
  };

  const unit =
    input.metric === 'revenue'
      ? 'money'
      : input.metric === 'occupancy'
        ? 'percent'
        : 'count';

  let series = await (input.metric === 'revenue'
    ? ctx.api.getRevenueDaily(query)
    : input.metric === 'appointments'
      ? ctx.api.getAppointmentsDaily(query)
      : input.metric === 'occupancy'
        ? ctx.api.getOccupancyDaily(query)
        : ctx.api.getClientsDaily(query));

  if (input.skip_empty_days) series = dropEmptyDays(series);

  // Revenue is the only money series; take the currency from the key metrics
  // only when the agent asked for revenue, so no extra call is made otherwise.
  let currency: string | null = null;
  if (input.metric === 'revenue') {
    const overview = await ctx.api.getOverview(query);
    currency = overview.currency;
  }

  return {
    text: seriesSummary(input.metric, series, ctx.period, unit, currency),
    structuredContent: {
      ...periodBlock(ctx),
      metric: input.metric,
      unit:
        unit === 'money' ? 'money' : unit === 'percent' ? 'percent' : 'count',
      ...(currency ? { currency } : {}),
      series,
    },
  };
}

// ========== breakdowns ==========

export interface BreakdownInput extends OverviewInput {
  group_by: 'source' | 'visit_status';
}

export async function getAppointmentsBreakdown(
  client: AltegioClient,
  input: BreakdownInput
): Promise<AnalyticsResult> {
  const ctx = await context(client, input.location_id, input);
  const query = {
    location_id: input.location_id,
    date_from: ctx.period.date_from,
    date_to: ctx.period.date_to,
    ...(input.team_member_id ? { team_member_id: input.team_member_id } : {}),
    ...(input.position_id ? { position_id: input.position_id } : {}),
    ...(input.created_by_user_id
      ? { created_by_user_id: input.created_by_user_id }
      : {}),
  };

  const slices =
    input.group_by === 'source'
      ? withShares(await ctx.api.getAppointmentSourceBreakdown(query))
      : withShares(await ctx.api.getVisitStatusBreakdown(query));

  const total = slices.reduce((sum, slice) => sum + slice.count, 0);
  const text = [
    `Appointments by ${input.group_by === 'source' ? 'source' : 'visit status'} for ${ctx.period.date_from}…${ctx.period.date_to} (${total} in total):`,
    ...slices.map(
      (slice) =>
        `${slice.key}${slice.key === 'other' ? ` (${slice.label})` : ''}: ${slice.count} (${slice.share_percent}%)`
    ),
  ].join('\n');

  return {
    text:
      slices.length === 0
        ? `No appointments in ${ctx.period.date_from}…${ctx.period.date_to}.`
        : text,
    structuredContent: {
      ...periodBlock(ctx),
      group_by: input.group_by,
      total_count: total,
      breakdown: slices,
    },
  };
}

// ========== receptionist performance ==========

export interface ReceptionistInput extends PeriodInput {
  location_id: number;
  created_by_user_id?: number;
  include_daily?: boolean;
}

export async function getReceptionistPerformance(
  client: AltegioClient,
  input: ReceptionistInput
): Promise<AnalyticsResult> {
  const ctx = await context(client, input.location_id, input);
  const performance = await ctx.api.getReceptionistPerformance({
    location_id: input.location_id,
    date_from: ctx.period.date_from,
    date_to: ctx.period.date_to,
    ...(input.created_by_user_id
      ? { created_by_user_id: input.created_by_user_id }
      : {}),
    ...(input.include_daily ? { include_daily: true } : {}),
  });

  const scope = input.created_by_user_id
    ? `location user ${input.created_by_user_id}`
    : 'all receptionists';
  const text = [
    `Receptionist performance for ${scope}, ${ctx.period.date_from}…${ctx.period.date_to}:`,
    `Clients booked: ${performance.clients_booked.current ?? 'n/a'} (previous period ${performance.clients_booked.previous ?? 'n/a'})`,
    `Appointments closed: ${performance.appointments_closed.current ?? 'n/a'} (previous period ${performance.appointments_closed.previous ?? 'n/a'})`,
    `Revenue attributed: ${formatMoney(performance.revenue.current, performance.currency)} (previous period ${formatMoney(performance.revenue.previous, performance.currency)})`,
    `Rebooked after a visit: ${performance.rebooked_after_visit.rebooked_count ?? 'n/a'} of ${performance.rebooked_after_visit.clients_count ?? 'n/a'} clients (${performance.rebooked_after_visit.rate_percent ?? 'n/a'}%)`,
    `Rebooked after a no-show: ${performance.rebooked_after_no_show.rebooked_count ?? 'n/a'} of ${performance.rebooked_after_no_show.clients_count ?? 'n/a'} clients (${performance.rebooked_after_no_show.rate_percent ?? 'n/a'}%)`,
  ].join('\n');

  return {
    text,
    structuredContent: {
      ...periodBlock(ctx),
      ...(input.created_by_user_id
        ? { created_by_user_id: input.created_by_user_id }
        : {}),
      ...performance,
    },
  };
}

// ========== loyalty ==========

export interface LoyaltyInput extends PeriodInput {
  location_id: number;
  loyalty_program_id: number;
}

export async function getLoyaltyProgramResults(
  client: AltegioClient,
  input: LoyaltyInput
): Promise<AnalyticsResult> {
  const ctx = await context(client, input.location_id, input);
  const results = await ctx.api.getLoyaltyProgramResults({
    location_id: input.location_id,
    loyalty_program_id: input.loyalty_program_id,
    date_from: ctx.period.date_from,
    date_to: ctx.period.date_to,
  });

  const text = [
    `Loyalty program ${input.loyalty_program_id} for ${ctx.period.date_from}…${ctx.period.date_to}:`,
    `Clients: ${results.clients.total.all_count ?? 'n/a'} in total — ${results.clients.new.all_count ?? 'n/a'} new, ${results.clients.returning.all_count ?? 'n/a'} already known`,
    `Came back: ${results.clients.total.returned_count ?? 'n/a'} (${results.clients.total.returned_percent ?? 'n/a'}%), lost ${results.clients.total.lost_count ?? 'n/a'}`,
    `Revenue: ${formatMoney(results.revenue.total.all_total, results.currency)} in total, ${formatMoney(results.revenue.total.returned_total, results.currency)} from returning clients`,
    `Team members involved: ${results.by_team_member.length}`,
  ].join('\n');

  return {
    text,
    structuredContent: {
      ...periodBlock(ctx),
      loyalty_program_id: input.loyalty_program_id,
      ...results,
    },
  };
}

// ========== forecast ==========

export interface ForecastInput extends PeriodInput {
  location_id: number;
}

export async function getForecast(
  client: AltegioClient,
  input: ForecastInput
): Promise<AnalyticsResult> {
  const hasPeriod = Boolean(input.period ?? input.date_from ?? input.date_to);
  const timezone = await resolveLocationTimezone(client, input.location_id);
  const period = hasPeriod ? resolvePeriod(input, timezone) : undefined;
  const api = plainApi(client, timezone);

  const forecast = await api.getForecast({
    location_id: input.location_id,
    ...(period ? { date_from: period.date_from, date_to: period.date_to } : {}),
  });

  if (forecast.is_empty) {
    return {
      text:
        'The model has no revenue or visits forecast for this location and period yet. ' +
        'It needs a few months of visit history before it produces one; use analytics_get_overview for the actuals in the meantime.',
      structuredContent: { location_id: input.location_id, ...forecast },
    };
  }

  const text = [
    `Revenue and visits forecast versus actuals${period ? ` for ${period.date_from}…${period.date_to}` : ''}${forecast.prediction_date ? `, predicted on ${forecast.prediction_date}` : ''}:`,
    `Revenue: forecast ${formatMoney(forecast.revenue.forecast, forecast.currency)}, actual ${formatMoney(forecast.revenue.actual, forecast.currency)}`,
    `Visits: forecast ${forecast.visits.forecast ?? 'n/a'}, actual ${forecast.visits.actual ?? 'n/a'}`,
    `${forecast.by_period.length} period buckets in the structured result.`,
  ].join('\n');

  return {
    text,
    structuredContent: {
      location_id: input.location_id,
      ...(period
        ? {
            period: {
              date_from: period.date_from,
              date_to: period.date_to,
              days: period.days,
              timezone,
            },
          }
        : {}),
      ...forecast,
    },
  };
}

// ========== day-end report ==========

export interface DayEndInput extends PeriodInput {
  location_id: number;
  team_member_id?: number;
  include_details?: boolean;
}

export async function getDayEndReport(
  client: AltegioClient,
  input: DayEndInput
): Promise<AnalyticsResult> {
  const ctx = await context(client, input.location_id, input);
  const report = await ctx.api.getDayEndReport({
    location_id: input.location_id,
    date_from: ctx.period.date_from,
    date_to: ctx.period.date_to,
    ...(input.team_member_id ? { team_member_id: input.team_member_id } : {}),
    ...(input.include_details ? { include_details: true } : {}),
  });

  const clamped =
    report.date_from !== ctx.period.date_from ||
    report.date_to !== ctx.period.date_to;

  const lines = [
    `Day-end report for ${report.date_from}${report.date_to !== report.date_from ? `…${report.date_to}` : ''}:`,
    `Clients: ${report.totals.clients_count ?? 'n/a'}, appointments: ${report.totals.appointments_count ?? 'n/a'}`,
    `Services: ${report.totals.services_count ?? 'n/a'} for ${formatMoney(report.totals.services_revenue, report.currency)}`,
    `Products: ${report.totals.products_count ?? 'n/a'} for ${formatMoney(report.totals.products_revenue, report.currency)}`,
    `Memberships: ${report.totals.memberships_count ?? 'n/a'} for ${formatMoney(report.totals.memberships_revenue, report.currency)}; gift cards: ${report.totals.gift_cards_count ?? 'n/a'} for ${formatMoney(report.totals.gift_cards_revenue, report.currency)}`,
    `Taken in: ${formatMoney(report.takings_total, report.currency)} across ${report.takings_by_account.length} account(s) — ${report.takings_by_account.map((a) => `${a.title} ${formatMoney(a.amount, null)}`).join(', ') || 'none'}`,
    `Written off (discounts, bonuses, memberships, gift cards): ${formatMoney(report.write_offs_total, report.currency)}`,
  ];
  if (clamped) {
    lines.push(
      'Note: the location returned a different date range than requested. ' +
        'Without the right to look past today, the day-end report is clamped to today.'
    );
  }
  if (!input.include_details) {
    lines.push(
      'Per-client detail is off by default; pass include_details=true to add it (larger result, ids only, no names or phone numbers).'
    );
  }

  return {
    text: lines.join('\n'),
    structuredContent: {
      ...periodBlock(ctx),
      requested_date_from: ctx.period.date_from,
      requested_date_to: ctx.period.date_to,
      clamped_by_access_right: clamped,
      ...report,
    },
  };
}

// ========== occupancy per team member ==========

export interface OccupancyInput extends PeriodInput {
  location_id: number;
  team_member_ids: number[];
}

export async function getTeamMemberOccupancy(
  client: AltegioClient,
  input: OccupancyInput
): Promise<AnalyticsResult> {
  if (input.team_member_ids.length === 0) {
    throw new AnalyticsInputError(
      'Give at least one team_member_id. Call get_staff to list the team members of this location.'
    );
  }
  if (input.team_member_ids.length > 10) {
    throw new AnalyticsInputError(
      `This tool calls the API once per team member; ${input.team_member_ids.length} is too many for one result. Ask for at most 10 at a time.`
    );
  }
  const ctx = await context(client, input.location_id, input);

  // One call per team member: the endpoint's payload carries no team member id,
  // so rows from a batched call could not be attributed.
  const series = [];
  for (const teamMemberId of input.team_member_ids) {
    series.push(
      await ctx.api.getTeamMemberOccupancy({
        location_id: input.location_id,
        date_from: ctx.period.date_from,
        date_to: ctx.period.date_to,
        team_member_id: teamMemberId,
      })
    );
  }

  const text = [
    `Daily occupancy for ${series.length} team member(s), ${ctx.period.date_from}…${ctx.period.date_to}:`,
    ...series.map((one) => {
      const values = one.points.map(([, value]) => value);
      const average =
        values.length > 0
          ? Math.round(
              (values.reduce((sum, value) => sum + value, 0) / values.length) *
                10
            ) / 10
          : 0;
      return `team_member_id ${one.team_member_id}: average ${average}% over ${one.points.length} day(s)`;
    }),
  ].join('\n');

  return {
    text,
    structuredContent: { ...periodBlock(ctx), team_members: series },
  };
}

// ========== per-client visit statistics ==========

export async function getClientVisitStats(
  client: AltegioClient,
  input: { location_id: number; client_id: number }
): Promise<AnalyticsResult> {
  const timezone = await resolveLocationTimezone(client, input.location_id);
  const stats = await plainApi(client, timezone).getClientVisitStats(input);

  const text = [
    `Visit statistics for client ${input.client_id}:`,
    `Attended: ${stats.successful_visits_count ?? 'n/a'}, missed: ${stats.failed_visits_count ?? 'n/a'}`,
    `Spent in total: ${formatMoney(stats.spent_total, null)}, paid: ${formatMoney(stats.paid_total, null)}`,
    `Client account balance: ${formatMoney(stats.client_account_balance, null)}`,
    `Last attended visit: ${stats.last_visit_at ?? 'none recorded'}`,
  ].join('\n');

  return { text, structuredContent: stats };
}

// ========== report builder: catalogues ==========

export async function listReportTemplates(
  client: AltegioClient,
  input: { location_id: number; dataset?: Dataset }
): Promise<AnalyticsResult> {
  const timezone = await resolveLocationTimezone(client, input.location_id);
  const all = await plainApi(client, timezone).listReportTemplates({
    location_id: input.location_id,
  });
  const templates = input.dataset
    ? all.filter((template) => template.dataset === input.dataset)
    : all;

  const text = [
    `${templates.length} report template(s) available in this location:`,
    ...templates.map(
      (template) =>
        `${template.name} [${template.kind}, ${template.dataset ?? 'unknown dataset'}] — ${template.answers ?? (template.description || 'no description')} (template_id ${template.template_id})`
    ),
    'Run one with analytics_run_report by passing its template_id and a period.',
  ].join('\n');

  return {
    text,
    structuredContent: { items: templates, count: templates.length },
  };
}

export async function listReportFields(
  client: AltegioClient,
  input: {
    location_id: number;
    dataset: Dataset;
    include_derived?: boolean;
    search?: string;
  }
): Promise<AnalyticsResult> {
  const timezone = await resolveLocationTimezone(client, input.location_id);
  const all = await plainApi(client, timezone).listReportFields({
    location_id: input.location_id,
  });

  let fields = all.filter((field) => field.dataset === input.dataset);
  if (!input.include_derived) {
    fields = fields.filter((field) => field.is_curated);
  }
  if (input.search) {
    const needle = input.search.toLowerCase();
    fields = fields.filter(
      (field) =>
        field.field_key.includes(needle) ||
        field.title.toLowerCase().includes(needle)
    );
  }

  const projected = fields.map((field) => ({
    field_key: field.field_key,
    title: field.title,
    kind: field.kind,
    data_type: field.data_type,
    aggregation: field.aggregation,
    filterable: field.filterable,
  }));

  const text = [
    `${projected.length} field(s) in the "${input.dataset}" dataset${input.include_derived ? '' : ' (curated set; pass include_derived=true for every mechanical aggregate as well)'}:`,
    ...projected
      .slice(0, 80)
      .map(
        (field) =>
          `${field.field_key} — ${field.title} [${field.kind}${field.aggregation ? `, ${field.aggregation}` : ''}]`
      ),
    projected.length > 80
      ? `… ${projected.length - 80} more in the structured result.`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    text,
    structuredContent: {
      dataset: input.dataset,
      items: projected,
      count: projected.length,
      total_in_dataset: all.filter((f) => f.dataset === input.dataset).length,
    },
  };
}

export async function listSavedReports(
  client: AltegioClient,
  input: { location_id: number }
): Promise<AnalyticsResult> {
  const timezone = await resolveLocationTimezone(client, input.location_id);
  const reports = await plainApi(client, timezone).listSavedReports({
    location_id: input.location_id,
  });

  const items = reports.map((report) => ({
    report_id: report.report_id,
    name: report.name,
    description: report.description,
    kind: report.kind,
    template_id: report.template_id,
    created_at: report.created_at,
    created_by_this_assistant: report.name.startsWith(OWNED_REPORT_PREFIX),
  }));

  const text = [
    `${items.length} saved report(s) in this location's report builder:`,
    ...items.map(
      (item) =>
        `${item.name} [${item.kind}] — report_id ${item.report_id}${item.created_by_this_assistant ? ' (created by this assistant)' : ''}`
    ),
    'Run one with analytics_run_saved_report and a period.',
  ].join('\n');

  return { text, structuredContent: { items, count: items.length } };
}

// ========== report builder: running reports ==========

/** Date column of each dataset — the filter a period override is applied to. */
const DATASET_DATE_FIELD: Readonly<Record<Dataset, string>> = {
  sales: 'date',
  financial_transactions: 'date',
  loyalty: 'created_at',
  team_member_schedules: 'date',
};

/** Granularity field key per dataset and bucket, for dynamic reports. */
function granularityFieldKey(dataset: Dataset, bucket: string): string {
  return dataset === 'loyalty' ? `created_${bucket}` : `date_${bucket}`;
}

function fieldsByKey(fields: readonly ReportField[], dataset: Dataset) {
  const map = new Map<string, ReportField>();
  for (const field of fields) {
    if (field.dataset !== dataset) continue;
    if (!map.has(field.field_key)) map.set(field.field_key, field);
  }
  return map;
}

function requireField(
  map: Map<string, ReportField>,
  key: string,
  dataset: Dataset
): ReportField {
  const field = map.get(key);
  if (!field) {
    throw new AnalyticsInputError(
      `"${key}" is not a field of the "${dataset}" dataset. Call analytics_list_report_fields with dataset="${dataset}" to see the available field keys.`
    );
  }
  return field;
}

/** Period override for a saved report's date filter, when it has one. */
function periodOverride(
  report: SavedReport,
  fields: readonly ReportField[],
  period: Period
): ReportDataFilterOverride[] {
  const dateColumnIds = new Set(
    fields
      .filter((field) => field.data_type === 'date')
      .map((field) => field.column_id)
  );
  const dateFilter = (report.filters ?? []).find((filter) =>
    dateColumnIds.has(filter.column_id)
  );
  if (!dateFilter) return [];
  return [
    {
      filter_id: dateFilter.filter_id,
      operator: 'BETWEEN',
      value: { from: period.date_from, to: period.date_to },
    },
  ];
}

async function renderTable(
  api: AnalyticsApi,
  locationId: number,
  report: SavedReport,
  fields: readonly ReportField[],
  period: Period,
  rowCap: number
): Promise<{ table: RenamedTable; stored?: StoredReport }> {
  const raw = await api.runReport({
    location_id: locationId,
    report_id: report.report_id,
    filters: periodOverride(report, fields, period),
  });
  const table = projectReportTable(raw, fields, rowCap);
  if (!table.truncated) return { table };

  const full = projectReportTable(raw, fields, Number.MAX_SAFE_INTEGER);
  const stored = putReportCsv({
    location_id: locationId,
    name: report.name,
    csv: toCsv(full),
    row_count: full.row_count,
  });
  return { table, stored };
}

function tableResult(
  name: string,
  table: RenamedTable,
  stored: StoredReport | undefined,
  extra: Record<string, unknown>
): AnalyticsResult {
  const result: AnalyticsResult = {
    text: tableSummary(name, table),
    structuredContent: {
      ...extra,
      columns: table.columns,
      rows: table.rows,
      totals: table.totals,
      row_count: table.row_count,
      truncated: table.truncated,
      ...(stored
        ? { full_report_uri: stored.uri, full_report_rows: stored.row_count }
        : {}),
    },
  };
  if (stored) {
    result.extraContent = [
      {
        type: 'resource_link',
        uri: stored.uri,
        name: `${name}.csv`,
        description: `Full report output, ${stored.row_count} rows. Available for 30 minutes.`,
        mimeType: 'text/csv',
      },
    ];
  }
  return result;
}

export interface RunReportInput extends PeriodInput {
  location_id: number;
  template_id?: string;
  dataset?: Dataset;
  fields?: string[];
  group_by?: string[];
  granularity?: 'day' | 'week' | 'month' | 'year';
  row_limit?: number;
}

/**
 * Run a template or an ad-hoc report.
 *
 * Ownership rule: the report builder has no delete, so every report this server
 * creates would stay in the owner's builder forever. Exactly one report per
 * (location, template or ad-hoc signature) is therefore kept, named
 * `[Altegio Assistant] …`, created on first use and reused afterwards; the
 * period travels as a runtime filter override, never as a new report.
 */
export async function runReport(
  client: AltegioClient,
  input: RunReportInput
): Promise<AnalyticsResult> {
  if (!input.template_id && !input.dataset) {
    throw new AnalyticsInputError(
      'Pass either template_id (from analytics_list_report_templates) or dataset plus fields and group_by (from analytics_list_report_fields).'
    );
  }
  if (input.template_id && input.dataset) {
    throw new AnalyticsInputError(
      'Pass template_id or an ad-hoc dataset definition, not both.'
    );
  }

  const ctx = await context(client, input.location_id, input);
  const rowCap = Math.min(input.row_limit ?? REPORT_ROW_CAP, REPORT_ROW_CAP);
  const fields = await ctx.api.listReportFields({
    location_id: input.location_id,
  });
  const saved = await ctx.api.listSavedReports({
    location_id: input.location_id,
  });

  const definition = input.template_id
    ? await templateDefinition(ctx.api, input, fields)
    : adHocDefinition(input, fields);

  const owned = saved.find((report) => report.name === definition.name);
  let report: SavedReport;
  if (!owned) {
    report = await ctx.api.createReport({
      location_id: input.location_id,
      definition,
    });
  } else {
    report = await ctx.api.getSavedReport({
      location_id: input.location_id,
      report_id: owned.report_id,
    });
    // The template or the requested shape may have changed since the report was
    // created; update the one we own in place rather than leaving a second,
    // undeletable report behind.
    if (!definitionMatches(report, definition)) {
      await ctx.api.updateReport({
        location_id: input.location_id,
        report_id: report.report_id,
        definition,
      });
      report = await ctx.api.getSavedReport({
        location_id: input.location_id,
        report_id: report.report_id,
      });
    }
  }

  const { table, stored } = await renderTable(
    ctx.api,
    input.location_id,
    report,
    fields,
    ctx.period,
    rowCap
  );

  return tableResult(report.name, table, stored, {
    ...periodBlock(ctx),
    report_id: report.report_id,
    report_name: report.name,
    reused_existing_report: Boolean(owned),
    ...(input.template_id ? { template_id: input.template_id } : {}),
    ...(input.dataset ? { dataset: input.dataset } : {}),
  });
}

async function templateDefinition(
  api: AnalyticsApi,
  input: RunReportInput,
  fields: readonly ReportField[]
) {
  const templates = await api.listReportTemplates({
    location_id: input.location_id,
    with_definition: true,
  });
  const template = templates.find(
    (candidate) => candidate.template_id === input.template_id
  );
  if (!template) {
    throw new AnalyticsUnavailableError(
      `Template ${input.template_id} is not available in this location. Call analytics_list_report_templates to see the templates it does offer.`
    );
  }
  if (!template.columns?.length || !template.groupings?.length) {
    throw new AnalyticsUnavailableError(
      `Template "${template.name}" has no field definition in this location, so it cannot be run through the API. Pick another template or build the report from dataset and fields.`
    );
  }

  // Ensure the report can be re-run for any period: it needs a filter on a date
  // column that the run-time override can target.
  const filters = [...(template.filters ?? [])];
  const dateColumnIds = new Set(
    fields
      .filter((field) => field.data_type === 'date')
      .map((field) => field.column_id)
  );
  if (!filters.some((filter) => dateColumnIds.has(filter.column_id))) {
    const dataset = template.dataset ?? 'sales';
    const dateField = fieldsByKey(fields, dataset).get(
      DATASET_DATE_FIELD[dataset]
    );
    if (dateField) {
      filters.push({
        column_id: dateField.column_id,
        operator: 'BETWEEN',
        value: `${input.date_from ?? ''},${input.date_to ?? ''}`,
      });
    }
  }

  return {
    name: `${OWNED_REPORT_PREFIX} ${template.name}`,
    description: `Created by the Altegio assistant from the "${template.name}" template. The period is set per run.`,
    template_id: template.template_id,
    kind: template.kind,
    columns: template.columns.map((column) => ({
      column_id: column.column_id,
      ...(column.title ? { title: column.title } : {}),
    })),
    filters,
    groupings: template.groupings,
  };
}

function adHocDefinition(
  input: RunReportInput,
  fields: readonly ReportField[]
) {
  const dataset = input.dataset!;
  const map = fieldsByKey(fields, dataset);
  if (!input.fields?.length) {
    throw new AnalyticsInputError(
      `Pass at least one field for the "${dataset}" dataset. Call analytics_list_report_fields with dataset="${dataset}".`
    );
  }
  if (!input.group_by?.length && !input.granularity) {
    throw new AnalyticsInputError(
      `Pass group_by (a dimension such as team_member_name) or a granularity (day, week, month, year) so the "${dataset}" numbers are grouped by something.`
    );
  }

  const columns = input.fields.map((key) => {
    const field = requireField(map, key, dataset);
    return { column_id: field.column_id, title: field.title };
  });
  const groupings = (input.group_by ?? []).map(
    (key) => requireField(map, key, dataset).column_id
  );
  if (input.granularity) {
    groupings.push(
      requireField(
        map,
        granularityFieldKey(dataset, input.granularity),
        dataset
      ).column_id
    );
  }

  const dateField = map.get(DATASET_DATE_FIELD[dataset]);
  const filters = dateField
    ? [
        {
          column_id: dateField.column_id,
          operator: 'BETWEEN',
          value: `${input.date_from ?? ''},${input.date_to ?? ''}`,
        },
      ]
    : [];

  const signature = [
    dataset,
    ...[...input.fields].sort(),
    'by',
    ...[...(input.group_by ?? [])].sort(),
    ...(input.granularity ? [input.granularity] : []),
  ].join('|');

  return {
    name: `${OWNED_REPORT_PREFIX} ${dataset} ${shortHash(signature)}`,
    description: `Created by the Altegio assistant: ${input.fields.join(', ')} grouped by ${[...(input.group_by ?? []), input.granularity].filter(Boolean).join(', ')}.`,
    kind: (input.granularity ? 'dynamic' : 'static') as 'dynamic' | 'static',
    columns,
    filters,
    groupings,
  };
}

/** Whether a stored report still matches the definition we would create. */
export function definitionMatches(
  report: SavedReport,
  definition: ReportDefinition
): boolean {
  const sorted = (values: readonly string[]) => [...values].sort().join(',');
  const storedColumns = sorted(
    (report.columns ?? []).map((column) => column.column_id)
  );
  const wantedColumns = sorted(
    definition.columns.map((column) => column.column_id)
  );
  const storedGroupings = sorted(
    (report.groupings ?? []).map((grouping) => grouping.column_id)
  );
  const wantedGroupings = sorted(definition.groupings);
  return (
    report.kind === definition.kind &&
    storedColumns === wantedColumns &&
    storedGroupings === wantedGroupings &&
    (report.filters ?? []).length >= definition.filters.length
  );
}

/** Stable short hash, so one ad-hoc shape maps to one owned report. */
export function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0').slice(0, 7);
}

export interface RunSavedReportInput extends PeriodInput {
  location_id: number;
  report_id: string;
  row_limit?: number;
}

export async function runSavedReport(
  client: AltegioClient,
  input: RunSavedReportInput
): Promise<AnalyticsResult> {
  const ctx = await context(client, input.location_id, input);
  const rowCap = Math.min(input.row_limit ?? REPORT_ROW_CAP, REPORT_ROW_CAP);
  const [fields, report] = await Promise.all([
    ctx.api.listReportFields({ location_id: input.location_id }),
    ctx.api.getSavedReport({
      location_id: input.location_id,
      report_id: input.report_id,
    }),
  ]);

  const { table, stored } = await renderTable(
    ctx.api,
    input.location_id,
    report,
    fields,
    ctx.period,
    rowCap
  );

  return tableResult(report.name, table, stored, {
    ...periodBlock(ctx),
    report_id: report.report_id,
    report_name: report.name,
  });
}

/** Datasets and their legacy table names — used by the coverage resource. */
export const DATASET_SOURCES = DATASET_TABLE;
/** Curated template catalogue — used by the prompts and the glossary. */
export const TEMPLATE_CATALOGUE = REPORT_TEMPLATES;
