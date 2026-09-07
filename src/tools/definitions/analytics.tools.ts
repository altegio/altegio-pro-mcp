/**
 * `[Analytics]` tool pack — the reporting surface of one location.
 *
 * Every tool here reads: key metrics with period comparison, daily series,
 * breakdowns, receptionist performance, loyalty results, the day-end report,
 * occupancy, per-client visit counts, and the report builder with its templates
 * and datasets. The one exception is `analytics_run_report`, which may create a
 * single assistant-owned report in the location's report builder so a template
 * can be executed at all — its annotations say so.
 *
 * All names, parameters, result fields and texts use canonical product
 * vocabulary; the legacy API dialect stops in `src/capabilities/analytics/
 * vocabulary.ts` and the v1 adapter.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { PERIOD_PRESETS } from '../../capabilities/analytics/periods.js';
import { DATASETS } from '../../capabilities/analytics/vocabulary.js';
import { REPORT_ROW_CAP } from '../../capabilities/analytics/report-store.js';
import * as analytics from '../../capabilities/analytics/use-cases.js';

// ========== shared input pieces ==========

const locationId = z
  .number()
  .int()
  .positive()
  .describe(
    'Location to report on. Call list_locations when the id is unknown.'
  );

const periodFields = {
  period: z
    .enum(PERIOD_PRESETS)
    .optional()
    .describe(
      'Period preset, resolved in the location’s own timezone. Use this for "yesterday", "last month", "this quarter" style questions instead of computing dates.'
    ),
  date_from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      'First day of the period, YYYY-MM-DD, inclusive. Give together with date_to; leave both out when using period.'
    ),
  date_to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe(
      'Last day of the period, YYYY-MM-DD, inclusive. At most 365 days after date_from.'
    ),
};

const segmentFields = {
  team_member_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Report on one team member only. Use the team-member listing tool of this location to find the id.'
    ),
  position_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Report on every team member holding one position (for example every stylist). Call get_positions for the ids.'
    ),
  created_by_user_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Report only on appointments created by one location user, usually a receptionist.'
    ),
};

// ========== shared output schema pieces ==========

const num = { type: ['number', 'null'] as const };
const str = { type: ['string', 'null'] as const };
const int = { type: ['integer', 'null'] as const };

const compared = {
  type: 'object' as const,
  properties: {
    current: num,
    previous: num,
    change_percent: num,
  },
};

const periodSchema = {
  type: 'object' as const,
  properties: {
    date_from: { type: 'string' as const },
    date_to: { type: 'string' as const },
    days: { type: 'integer' as const },
    timezone: { type: 'string' as const },
    preset: { type: 'string' as const },
  },
};

const previousPeriodSchema = {
  type: 'object' as const,
  properties: {
    date_from: { type: 'string' as const },
    date_to: { type: 'string' as const },
  },
};

const dailyPoints = {
  type: 'array' as const,
  description: 'One [date, value] pair per day, ascending.',
  items: {
    type: 'array' as const,
    items: [{ type: 'string' as const }, { type: 'number' as const }],
  },
};

function objectSchema(properties: Record<string, object>, required?: string[]) {
  return {
    type: 'object' as const,
    properties,
    ...(required ? { required } : {}),
  };
}

const READ_ONLY = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;

// ========== key metrics ==========

export const analyticsGetOverviewTool = defineTool({
  name: 'analytics_get_overview',
  category: 'Analytics',
  description:
    '[Analytics] Key metrics of one location for a period, each next to the same metric in the previous period of equal length: total revenue and its services and products split, average check (average ticket), occupancy, appointments by outcome, and new, returning, active and lost clients. Start here for "how did we do last month", "is revenue up", "how many new clients", "what is our average check", "how busy were we". Optional filters narrow it to one team member, one position or one receptionist. For day-by-day numbers use analytics_get_daily_series; for a table by team member, service or client use analytics_run_report; for today’s till totals use analytics_get_day_end_report. Needs the Analytics access right in this location.',
  annotations: { title: 'Analytics: key metrics', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    ...segmentFields,
  }),
  outputSchema: objectSchema({
    period: periodSchema,
    previous_period: previousPeriodSchema,
    currency: str,
    revenue: objectSchema({
      total: compared,
      services: compared,
      products: compared,
    }),
    average_check: compared,
    average_services_check: compared,
    occupancy_percent: compared,
    appointments: objectSchema({
      total_count: int,
      previous_total_count: int,
      change_percent: num,
      completed_count: int,
      completed_percent: num,
      pending_count: int,
      pending_percent: num,
      cancelled_count: int,
      cancelled_percent: num,
    }),
    clients: objectSchema({
      total_in_base: int,
      new_count: int,
      new_percent: num,
      returning_count: int,
      returning_percent: num,
      active_count: int,
      lost_count: int,
      lost_percent: num,
    }),
  }),
  handler: async ({ input, client }) => analytics.getOverview(client, input),
});

// ========== daily series ==========

export const analyticsGetDailySeriesTool = defineTool({
  name: 'analytics_get_daily_series',
  category: 'Analytics',
  description:
    '[Analytics] One metric family as a day-by-day series: revenue (total, services, products), appointments (total, online bookings, from new clients), occupancy (booked share and the no-show share of working time), or clients (total, new, returning). Use it for trends, charts, "which day was busiest", "how did sales move through the month", "how much of our time do no-shows burn". Values come back as compact [date, value] pairs in the location’s timezone. For period totals use analytics_get_overview instead.',
  annotations: { title: 'Analytics: daily series', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    metric: z
      .enum(analytics.DAILY_METRICS)
      .describe(
        'Which family to return: revenue (money per day), appointments (counts including online bookings), occupancy (percent of scheduled time booked, plus the no-show share), clients (total, new, returning).'
      ),
    ...periodFields,
    ...segmentFields,
    skip_empty_days: z
      .boolean()
      .optional()
      .describe(
        'Drop days whose value is zero. Useful on long periods to keep the answer small.'
      ),
  }),
  outputSchema: objectSchema({
    period: periodSchema,
    previous_period: previousPeriodSchema,
    metric: { type: 'string' as const },
    unit: { type: 'string' as const, enum: ['money', 'count', 'percent'] },
    currency: str,
    series: {
      type: 'array' as const,
      items: objectSchema({
        key: { type: 'string' as const },
        label: { type: 'string' as const },
        points: dailyPoints,
      }),
    },
  }),
  handler: async ({ input, client }) => analytics.getDailySeries(client, input),
});

// ========== breakdowns ==========

export const analyticsGetAppointmentsBreakdownTool = defineTool({
  name: 'analytics_get_appointments_breakdown',
  category: 'Analytics',
  description:
    '[Analytics] Appointments of a period split either by source — online booking, the client app, a receptionist, the API — or by visit status: waiting, confirmed, arrived, no_show, cancelled. Answers "how many bookings came from the website", "what is our no-show rate", "how many appointments were cancelled", "is online booking growing". Each slice carries a count and its share of the total. There is no online-booking funnel anywhere in the product; this split by source is the closest thing to one.',
  annotations: { title: 'Analytics: appointment breakdown', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    group_by: z
      .enum(['source', 'visit_status'])
      .describe(
        'source — where the appointment came from (online booking, client app, receptionist, API); visit_status — waiting, confirmed, arrived, no_show or cancelled.'
      ),
    ...periodFields,
    ...segmentFields,
  }),
  outputSchema: objectSchema({
    period: periodSchema,
    previous_period: previousPeriodSchema,
    group_by: { type: 'string' as const },
    total_count: { type: 'integer' as const },
    breakdown: {
      type: 'array' as const,
      items: objectSchema({
        key: { type: 'string' as const },
        label: { type: 'string' as const },
        count: { type: 'integer' as const },
        share_percent: { type: 'number' as const },
      }),
    },
  }),
  handler: async ({ input, client }) =>
    analytics.getAppointmentsBreakdown(client, input),
});

// ========== receptionist performance ==========

export const analyticsGetReceptionistPerformanceTool = defineTool({
  name: 'analytics_get_receptionist_performance',
  category: 'Analytics',
  description:
    '[Analytics] How the front desk performed in a period: how many clients the receptionists booked, how many appointments they closed and settled, how much revenue is attributed to them, and their rebooking rate — the share of clients who left with a new appointment after a visit, and the share won back after a no-show. Answers "who at the front desk books the most", "do we rebook clients before they leave", "how good is our follow-up on no-shows". Pass created_by_user_id to see one location user only; a receptionist without the Analytics access right can still read their own numbers that way.',
  annotations: { title: 'Analytics: front-desk performance', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    created_by_user_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'One location user (usually a receptionist). Leave out for every receptionist of the location combined. A user who may only see their own numbers must pass their own id here.'
      ),
    include_daily: z
      .boolean()
      .optional()
      .describe(
        'Add a day-by-day series for clients booked, appointments closed and revenue.'
      ),
  }),
  outputSchema: objectSchema({
    period: periodSchema,
    previous_period: previousPeriodSchema,
    created_by_user_id: int,
    currency: str,
    clients_booked: compared,
    appointments_closed: compared,
    revenue: compared,
    rebooked_after_visit: objectSchema({
      clients_count: int,
      rebooked_count: int,
      rate_percent: num,
    }),
    rebooked_after_no_show: objectSchema({
      clients_count: int,
      rebooked_count: int,
      rate_percent: num,
    }),
    daily: objectSchema({
      clients_booked: dailyPoints,
      appointments_closed: dailyPoints,
      revenue: dailyPoints,
    }),
  }),
  handler: async ({ input, client }) =>
    analytics.getReceptionistPerformance(client, input),
});

// ========== loyalty ==========

export const analyticsGetLoyaltyProgramResultsTool = defineTool({
  name: 'analytics_get_loyalty_program_results',
  category: 'Analytics',
  description:
    '[Analytics] Results of one loyalty program in a period: how many clients it touched split into new and already-known, how many came back, how many were lost, the revenue it produced in total and from returning clients, day-by-day client and revenue series, and the same client counts per team member. Answers "is the loyalty program bringing people back", "how much revenue does the bonus program generate", "which team members sell the program". Requires loyalty_program_id — the location’s programs are listed by the loyalty tools of the product, not by this pack.',
  annotations: { title: 'Analytics: loyalty program results', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    loyalty_program_id: z
      .number()
      .int()
      .positive()
      .describe(
        'Loyalty program to report on. Ask the owner which program they mean if more than one exists.'
      ),
    ...periodFields,
  }),
  outputSchema: objectSchema({
    period: periodSchema,
    previous_period: previousPeriodSchema,
    loyalty_program_id: { type: 'integer' as const },
    currency: str,
    clients: { type: 'object' as const },
    revenue: { type: 'object' as const },
    visits_by_day: {
      type: 'array' as const,
      items: { type: 'object' as const },
    },
    revenue_by_day: {
      type: 'array' as const,
      items: { type: 'object' as const },
    },
    by_team_member: {
      type: 'array' as const,
      items: { type: 'object' as const },
    },
  }),
  handler: async ({ input, client }) =>
    analytics.getLoyaltyProgramResults(client, input),
});

// ========== forecast ==========

export const analyticsGetForecastTool = defineTool({
  name: 'analytics_get_forecast',
  category: 'Analytics',
  description:
    '[Analytics] Model forecast of revenue and visit count next to what actually happened, so the owner can see whether the location is running ahead of or behind expectation. Answers "are we on track this month", "what revenue should we expect". This is a forecast comparison, not client segmentation. The forecast is an optional module: when it is switched off for the location, or when there is not enough visit history yet, the tool says so instead of failing — use analytics_get_overview for the actuals in that case.',
  annotations: {
    title: 'Analytics: revenue and visits forecast',
    ...READ_ONLY,
  },
  input: z.object({
    location_id: locationId,
    ...periodFields,
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    period: periodSchema,
    prediction_date: str,
    currency: str,
    revenue: objectSchema({ forecast: num, actual: num }),
    visits: objectSchema({ forecast: num, actual: num }),
    granularity: str,
    by_period: { type: 'array' as const, items: { type: 'object' as const } },
    is_empty: { type: 'boolean' as const },
  }),
  handler: async ({ input, client }) => analytics.getForecast(client, input),
});

// ========== day-end report ==========

export const analyticsGetDayEndReportTool = defineTool({
  name: 'analytics_get_day_end_report',
  category: 'Analytics',
  description:
    '[Analytics] Day-end report for one day or a short range: clients served, appointments, services and products sold with their revenue, memberships and gift cards sold, money actually taken per account (the cash-versus-card split), and everything written off as discounts, loyalty bonuses, memberships or gift cards. This is the report a receptionist closes the day with. Answers "what did we take today", "how much cash is in the till", "how much did we discount". Per-client detail is off by default because it is large; include_details=true adds it with ids and amounts only, never names or phone numbers. Needs the finance reporting right; without the right to look past today the location silently returns today, and the result says when that happened.',
  annotations: { title: 'Analytics: day-end report', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    team_member_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Restrict the report to one team member.'),
    include_details: z
      .boolean()
      .optional()
      .describe(
        'Add the per-client, per-team-member item detail. Large result; ids and amounts only.'
      ),
  }),
  outputSchema: objectSchema({
    period: periodSchema,
    previous_period: previousPeriodSchema,
    requested_date_from: { type: 'string' as const },
    requested_date_to: { type: 'string' as const },
    clamped_by_access_right: { type: 'boolean' as const },
    date_from: { type: 'string' as const },
    date_to: { type: 'string' as const },
    currency: str,
    totals: { type: 'object' as const },
    takings_by_account: {
      type: 'array' as const,
      items: objectSchema({ title: { type: 'string' as const }, amount: num }),
    },
    write_offs: {
      type: 'array' as const,
      items: objectSchema({ title: { type: 'string' as const }, amount: num }),
    },
    takings_total: num,
    write_offs_total: num,
    details: { type: 'array' as const, items: { type: 'object' as const } },
  }),
  handler: async ({ input, client }) =>
    analytics.getDayEndReport(client, input),
});

// ========== occupancy ==========

export const analyticsGetTeamMemberOccupancyTool = defineTool({
  name: 'analytics_get_team_member_occupancy',
  category: 'Analytics',
  description:
    '[Analytics] Day-by-day occupancy for up to ten named team members: the share of each one’s scheduled working time that is booked. Answers "who has free capacity this week", "is anyone overloaded", "how full is a given stylist". A team member with no work schedule shows no occupancy at all, because occupancy is measured against scheduled time. For the whole location at once use analytics_get_daily_series with metric=occupancy; for hours and idle time per team member use the "Occupancy" report template. Needs access to the work schedule of the location.',
  annotations: { title: 'Analytics: team member occupancy', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    team_member_ids: z
      .array(z.number().int().positive())
      .min(1)
      .max(10)
      .describe(
        'Team members to report on, at most ten (the API is called once per team member). Use the team-member listing tool of this location for the ids.'
      ),
    ...periodFields,
  }),
  outputSchema: objectSchema({
    period: periodSchema,
    previous_period: previousPeriodSchema,
    team_members: {
      type: 'array' as const,
      items: objectSchema({
        team_member_id: { type: 'integer' as const },
        points: dailyPoints,
      }),
    },
  }),
  handler: async ({ input, client }) =>
    analytics.getTeamMemberOccupancy(client, input),
});

// ========== per-client visits ==========

export const analyticsGetClientVisitStatsTool = defineTool({
  name: 'analytics_get_client_visit_stats',
  category: 'Analytics',
  description:
    '[Analytics] Visit history figures for one client in this location: visits attended, visits missed, total spent, total paid, the balance on their client account, and the date of their last attended visit. Answers "is this client reliable", "how much has this client spent with us", "does this client have money on account" while looking at a client card. For a table of many clients at once run the "Revenue and visits by client" report template instead. Needs access to client cards in this location.',
  annotations: { title: 'Analytics: client visit history', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    client_id: z
      .number()
      .int()
      .positive()
      .describe('Client to report on, as returned by the client tools.'),
  }),
  outputSchema: objectSchema({
    client_id: { type: 'integer' as const },
    successful_visits_count: int,
    failed_visits_count: int,
    spent_total: num,
    paid_total: num,
    client_account_balance: num,
    last_visit_at: str,
  }),
  handler: async ({ input, client }) =>
    analytics.getClientVisitStats(client, input),
});

// ========== report builder ==========

export const analyticsListReportTemplatesTool = defineTool({
  name: 'analytics_list_report_templates',
  category: 'Analytics',
  description:
    '[Analytics] Built-in report templates the location can run, each with the business question it answers, its dataset and whether it is a flat table or a time series. Includes revenue by team member, by service and by client, client retention, occupancy, appointment sources, group event attendance, memberships and gift cards, income and expenses, P&L, and the dynamics templates. Call this first when the owner asks for something analytics_get_overview does not cover, then run the chosen template with analytics_run_report. Needs the Analytics access right and an active subscription.',
  annotations: { title: 'Analytics: report templates', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    dataset: z
      .enum(DATASETS)
      .optional()
      .describe(
        'Show only templates over one dataset: sales, financial_transactions, loyalty or team_member_schedules.'
      ),
  }),
  outputSchema: objectSchema({
    items: {
      type: 'array' as const,
      items: objectSchema({
        template_id: { type: 'string' as const },
        name: { type: 'string' as const },
        kind: { type: 'string' as const, enum: ['static', 'dynamic'] },
        dataset: str,
        answers: { type: 'string' as const },
        description: { type: 'string' as const },
      }),
    },
    count: { type: 'integer' as const },
  }),
  handler: async ({ input, client }) =>
    analytics.listReportTemplates(client, input),
});

export const analyticsListReportFieldsTool = defineTool({
  name: 'analytics_list_report_fields',
  category: 'Analytics',
  description:
    '[Analytics] Fields available in one report-builder dataset, as canonical field keys you can pass to analytics_run_report: metrics such as revenue_total, average_check_per_visit, occupancy_percent, new_clients_count, products_margin; dimensions such as team_member_name, service_or_product, client_name, account; and the day, week, month and year granularities. The four datasets are sales (services and products sold, visits, clients, occupancy), financial_transactions (income and expenses, cash versus non-cash), loyalty (memberships and gift cards) and team_member_schedules (scheduled, booked and idle hours). Returns the curated set by default; include_derived=true adds every mechanical sum, average, minimum, maximum and count variant.',
  annotations: { title: 'Analytics: report fields', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    dataset: z
      .enum(DATASETS)
      .describe(
        'sales — services and products sold, visits, clients, occupancy, group events, product margin. financial_transactions — income and expense items, cash versus non-cash, accounts. loyalty — memberships and gift cards. team_member_schedules — scheduled, booked and idle hours.'
      ),
    include_derived: z
      .boolean()
      .optional()
      .describe(
        'Include the mechanically derived aggregates (…_sum, …_avg, …_count, …). Hundreds of extra fields; leave out unless the curated set is missing something.'
      ),
    search: z
      .string()
      .min(2)
      .optional()
      .describe(
        'Keep only fields whose key or title contains this text, for example "margin" or "occupancy".'
      ),
  }),
  outputSchema: objectSchema({
    dataset: { type: 'string' as const },
    items: {
      type: 'array' as const,
      items: objectSchema({
        field_key: { type: 'string' as const },
        title: { type: 'string' as const },
        kind: {
          type: 'string' as const,
          enum: ['metric', 'dimension', 'granularity'],
        },
        data_type: { type: 'string' as const },
        aggregation: str,
        filterable: { type: 'boolean' as const },
      }),
    },
    count: { type: 'integer' as const },
    total_in_dataset: { type: 'integer' as const },
  }),
  handler: async ({ input, client }) =>
    analytics.listReportFields(client, input),
});

const reportTableOutput = objectSchema({
  period: periodSchema,
  previous_period: previousPeriodSchema,
  report_id: { type: 'string' as const },
  report_name: { type: 'string' as const },
  reused_existing_report: { type: 'boolean' as const },
  template_id: { type: 'string' as const },
  dataset: { type: 'string' as const },
  columns: {
    type: 'array' as const,
    items: objectSchema({
      key: { type: 'string' as const },
      title: { type: 'string' as const },
    }),
  },
  rows: { type: 'array' as const, items: { type: 'object' as const } },
  totals: { type: 'object' as const },
  row_count: { type: 'integer' as const },
  truncated: { type: 'boolean' as const },
  full_report_uri: { type: 'string' as const },
  full_report_rows: { type: 'integer' as const },
});

export const analyticsRunReportTool = defineTool({
  name: 'analytics_run_report',
  category: 'Analytics',
  description: `[Analytics] Run a report and get a table back: either a built-in template by template_id, or an ad-hoc report built from a dataset, the fields you want and what to group them by. This is how you answer "revenue by team member last month", "top services by revenue", "sales per client", "income and expenses by month", "P&L for the quarter", "occupancy hours per stylist". Get template_id from analytics_list_report_templates and field keys from analytics_list_report_fields. At most ${REPORT_ROW_CAP} rows come back inline; a longer table is attached as a CSV resource link that stays readable for 30 minutes. Note: the report builder has no delete, so this tool keeps exactly one report per template or ad-hoc shape, named "[Altegio Assistant] …", creating it on first use and reusing it afterwards — the period travels per run and never creates a second report. Needs the Analytics access right and an active subscription.`,
  annotations: {
    title: 'Analytics: run a report',
    // Not marked read-only on purpose: running a template requires a stored
    // report in the location's report builder, so the first run of each shape
    // creates one (idempotently reused afterwards, never deleted, never
    // overwriting anything the user made).
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    template_id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Built-in template to run, from analytics_list_report_templates. Use this or an ad-hoc dataset definition, not both.'
      ),
    dataset: z
      .enum(DATASETS)
      .optional()
      .describe(
        'Dataset for an ad-hoc report: sales, financial_transactions, loyalty or team_member_schedules.'
      ),
    fields: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Canonical field keys to show as columns, from analytics_list_report_fields — for example ["revenue_total","visits_count","average_check_per_visit"].'
      ),
    group_by: z
      .array(z.string().min(1))
      .optional()
      .describe(
        'Dimension field keys to group the rows by — for example ["team_member_name"] or ["service_or_product"].'
      ),
    granularity: z
      .enum(['day', 'week', 'month', 'year'])
      .optional()
      .describe(
        'Add a time bucket so the report becomes a series: one column set per day, week, month or year.'
      ),
    ...periodFields,
    row_limit: z
      .number()
      .int()
      .positive()
      .max(REPORT_ROW_CAP)
      .optional()
      .describe(
        `Rows to return inline, at most ${REPORT_ROW_CAP}. Anything beyond is attached as a CSV resource link.`
      ),
  }),
  outputSchema: reportTableOutput,
  handler: async ({ input, client }) => analytics.runReport(client, input),
});

export const analyticsListSavedReportsTool = defineTool({
  name: 'analytics_list_saved_reports',
  category: 'Analytics',
  description:
    '[Analytics] Reports already saved in this location’s report builder, whether the owner built them or this assistant did. Use it to re-run something the owner recognises by name — "run my weekly sales report" — instead of rebuilding it, then pass its report_id to analytics_run_saved_report with the period you want. Reports whose name starts with "[Altegio Assistant]" were created by this assistant.',
  annotations: { title: 'Analytics: saved reports', ...READ_ONLY },
  input: z.object({ location_id: locationId }),
  outputSchema: objectSchema({
    items: {
      type: 'array' as const,
      items: objectSchema({
        report_id: { type: 'string' as const },
        name: { type: 'string' as const },
        description: { type: 'string' as const },
        kind: { type: 'string' as const },
        template_id: str,
        created_at: str,
        created_by_this_assistant: { type: 'boolean' as const },
      }),
    },
    count: { type: 'integer' as const },
  }),
  handler: async ({ input, client }) =>
    analytics.listSavedReports(client, input),
});

export const analyticsRunSavedReportTool = defineTool({
  name: 'analytics_run_saved_report',
  category: 'Analytics',
  description: `[Analytics] Run a report that already exists in the location’s report builder for a period you choose, and get the table back. Get report_id from analytics_list_saved_reports. The report’s own period filter is overridden per run, so nothing stored is changed. At most ${REPORT_ROW_CAP} rows come back inline; a longer table is attached as a CSV resource link readable for 30 minutes. Needs the Analytics access right and an active subscription.`,
  annotations: { title: 'Analytics: run a saved report', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    report_id: z
      .string()
      .min(1)
      .describe('Saved report to run, from analytics_list_saved_reports.'),
    ...periodFields,
    row_limit: z
      .number()
      .int()
      .positive()
      .max(REPORT_ROW_CAP)
      .optional()
      .describe(
        `Rows to return inline, at most ${REPORT_ROW_CAP}. Anything beyond is attached as a CSV resource link.`
      ),
  }),
  outputSchema: reportTableOutput,
  handler: async ({ input, client }) => analytics.runSavedReport(client, input),
});
