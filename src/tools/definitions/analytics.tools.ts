/**
 * `[Analytics]` tool pack — the reporting surface of one location.
 *
 * Every tool here reads: key metrics with period comparison, daily series,
 * breakdowns, receptionist performance, loyalty results, the day-end report,
 * occupancy and per-client visit counts.
 *
 * The report-builder definitions below (`analytics_list_report_templates`,
 * `analytics_list_report_fields`, `analytics_run_report`,
 * `analytics_list_saved_reports`, `analytics_run_saved_report`,
 * `analytics_delete_assistant_report`) are kept but **not served**: the backend
 * report-data API fails for every report in production. The reasons and the
 * re-enable step are in `src/tools/disabled-tools.ts`.
 *
 * All names, parameters, result fields and texts use canonical product
 * vocabulary; the legacy API dialect stops in `src/capabilities/analytics/
 * vocabulary.ts` and the v1 adapter.
 */
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { PERIOD_PRESETS } from '../../capabilities/analytics/periods.js';
import {
  DATASETS,
  VISIT_STATUSES,
} from '../../capabilities/analytics/vocabulary.js';
import { REPORT_ROW_CAP } from '../../capabilities/analytics/report-store.js';
import * as analytics from '../../capabilities/analytics/use-cases.js';
import * as legacyAnalytics from '../../capabilities/analytics/legacy-use-cases.js';
import * as decisionAnalytics from '../../capabilities/analytics/decision-use-cases.js';
import * as reactivationAnalytics from '../../capabilities/analytics/reactivation.js';
import * as serviceMix from '../../capabilities/analytics/service-mix.js';
import { includeContactsArg } from '../contacts.js';
import { clientFiltersSchema } from './client-filters.schema.js';

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
const date = { type: ['string', 'null'] as const, format: 'date' as const };

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
    // Keep this valid under both JSON Schema 2020-12 and the draft-7 validator
    // currently used by FastMCP/Pydantic AI. `prefixItems` + `items:false` is
    // correct 2020-12, but draft-7 ignores prefixItems and interprets the false
    // schema as "no array items", rejecting every real point. Length remains
    // strict; the application adapter guarantees [date, value] order.
    type: 'array' as const,
    items: {
      anyOf: [{ type: 'string' as const }, { type: 'number' as const }],
    },
    minItems: 2,
    maxItems: 2,
  },
};

function objectSchema(properties: Record<string, object>, required?: string[]) {
  return {
    type: 'object' as const,
    properties,
    ...(required ? { required } : {}),
  };
}

function closedObjectSchema(
  properties: Record<string, object>,
  required: string[] = Object.keys(properties)
) {
  return {
    type: 'object' as const,
    properties,
    required,
    additionalProperties: false,
  };
}

const bool = { type: 'boolean' as const };
const requiredString = { type: 'string' as const };
const requiredInteger = { type: 'integer' as const };
const requiredNumber = { type: 'number' as const };
const nullValue = { type: 'null' as const };
const strictPeriodSchema = closedObjectSchema(
  {
    date_from: requiredString,
    date_to: requiredString,
    days: requiredInteger,
    timezone: requiredString,
    preset: requiredString,
  },
  ['date_from', 'date_to', 'days', 'timezone']
);
const strictDateRangeSchema = closedObjectSchema({
  date_from: requiredString,
  date_to: requiredString,
});
const nullableDateRangeSchema = {
  anyOf: [strictDateRangeSchema, nullValue],
};
const comparedValueSchema = closedObjectSchema(
  {
    current: num,
    previous: num,
    change_percent: num,
  },
  ['current']
);

const READ_ONLY = {
  readOnlyHint: true,
  openWorldHint: true,
} as const;

// ========== key metrics ==========

export const analyticsGetOverviewTool = defineTool({
  name: 'analytics_get_overview',
  category: 'Analytics',
  description:
    '[Analytics] Key metrics of one location for a period, each next to the same metric in the previous period of equal length: total revenue and its services and products split, average check (average ticket), occupancy, appointments by outcome, and new, returning, active and lost clients. Start here for "how did we do last month", "is revenue up", "how many new clients", "what is our average check", "how busy were we". Optional filters narrow it to one team member, one position or one receptionist. For day-by-day numbers use analytics_get_daily_series; to split the same headline across the team call it again with position_id or team_member_id; for today’s till totals use analytics_get_day_end_report. Needs the Analytics access right in this location.',
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
    '[Analytics] Day-end report for one day or a short range: clients served, appointments, services and products sold with their revenue, memberships and gift cards sold, money actually taken per account (the cash-versus-card split), and everything written off as discounts, loyalty bonuses, memberships or gift cards. This is the report a receptionist closes the day with. Answers "what did we take today", "how much cash is in the till", "how much did we discount". Per-client detail is off by default because it is large; include_details=true adds it with ids and amounts only, never names or phone numbers. Needs the finance reporting right. Historical values are withheld when the source cannot prove its effective period, so silently clamped data is never labelled as the requested range.',
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
    data_available: { type: 'boolean' as const },
    period_status: {
      type: 'string' as const,
      enum: ['verified', 'clamped', 'unverified'],
    },
    effective_period: nullableDateRangeSchema,
    period_status_reason: str,
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

// ========== temporary stable legacy reports ===============================

const legacyPageOutput = objectSchema({
  page: { type: 'integer' as const },
  page_size: { type: 'integer' as const },
  total_count: { type: 'integer' as const },
  returned: { type: 'integer' as const },
  has_more: { type: 'boolean' as const },
});

const paymentBreakdownOutput = objectSchema({
  discount: num,
  loyalty_points: num,
  memberships: num,
  gift_cards: num,
  client_accounts: num,
});

const retentionMetricsOutput = {
  clients_count: { type: 'integer' as const },
  new_clients_count: { type: 'integer' as const },
  new_clients_percent: num,
  returning_clients_count: { type: 'integer' as const },
  returning_clients_percent: num,
  clients_eligible_for_return_count: { type: 'integer' as const },
  clients_returned_count: { type: 'integer' as const },
  retention_percent: num,
};

const legacyIdList = (description: string) =>
  z
    .array(z.number().int().positive())
    .max(100)
    .optional()
    .describe(description);

export const analyticsGetClientSalesTool = defineTool({
  name: 'analytics_get_client_sales',
  category: 'Analytics',
  description:
    '[Analytics] Revenue and visit totals by client from the stable sales-by-client report: client id, revenue, share of location revenue, average check and visit count. Use it for “top clients this month” and per-client sales analysis; use clients_search for lifetime segmentation instead. Results are source-paginated. Client phone and email are withheld unless include_contacts=true. Temporary legacy-report adapter pending V3; it never creates a saved report. Needs the Sales by clients report permission.',
  annotations: { title: 'Analytics: sales by client', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Page, starting at 1.'),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(250)
      .optional()
      .describe('Rows per page, at most 250. Default 50.'),
    include_contacts: includeContactsArg,
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    period: periodSchema,
    currency: str,
    rows: {
      type: 'array' as const,
      items: objectSchema({
        client_id: { type: 'integer' as const },
        client_name: str,
        revenue: num,
        revenue_share_percent: num,
        average_check: num,
        visits_count: int,
        phone: str,
        email: str,
      }),
    },
    totals: objectSchema({ revenue: num }),
    page: legacyPageOutput,
    contacts_included: { type: 'boolean' as const },
    untrusted_data_note: { type: 'string' as const },
  }),
  handler: async ({ input, client }) =>
    legacyAnalytics.getClientSales(client, input),
});

export const analyticsGetClientRetentionTool = defineTool({
  name: 'analytics_get_client_retention',
  category: 'Analytics',
  description:
    '[Analytics] Client retention by team member for a period: unique, new and returning clients, the clients considered lost before the period, how many returned, and the retention percentage. Optionally restrict to one service. Legacy rows are matched to a current team-member id only when name and position identify exactly one member; stale or ambiguous identities return a null id and explicit status. Use it for “which team members bring clients back”; use analytics_get_client_sales for revenue by client. Temporary stable legacy-report adapter pending V3; it never creates a saved report. Needs the Client retention report permission.',
  annotations: { title: 'Analytics: client retention', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    service_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Restrict retention to one service.'),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    period: periodSchema,
    service_id: int,
    rows: {
      type: 'array' as const,
      items: objectSchema({
        team_member_id: int,
        team_member_identity_status: {
          type: 'string' as const,
          enum: ['matched', 'unavailable', 'ambiguous'],
        },
        team_member_name: str,
        position_title: str,
        ...retentionMetricsOutput,
      }),
    },
    totals: objectSchema(retentionMetricsOutput),
    lost_threshold_days: int,
    untrusted_data_note: { type: 'string' as const },
  }),
  handler: async ({ input, client }) =>
    legacyAnalytics.getClientRetention(client, input),
});

export const analyticsGetClientForecastTool = defineTool({
  name: 'analytics_get_client_forecast',
  category: 'Analytics',
  description:
    '[Analytics] Per-client RFM forecast from the location’s stable forecast export: average check, predicted visits and revenue, expected return window, prior return visits and last visit date. Use analytics_get_forecast for aggregate location forecast versus actuals. The legacy workbook does not expose client ids, so client_id is explicitly null and never guessed. Results are paginated after a size-bounded workbook read; contacts are withheld unless include_contacts=true. Temporary adapter pending V3; it never creates a saved report. Needs Analytics, client-export and forecast-module access.',
  annotations: { title: 'Analytics: client forecast', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    prediction_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Forecast snapshot date, YYYY-MM-DD. Leave out for the latest.'
      ),
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Page, starting at 1.'),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Rows per page, at most 100. Default 50.'),
    include_contacts: includeContactsArg,
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    prediction_date: str,
    currency: str,
    rows: {
      type: 'array' as const,
      items: objectSchema({
        client_id: { type: 'null' as const },
        client_name: str,
        average_check: num,
        predicted_visits_count: int,
        predicted_visit_window: { type: 'string' as const },
        predicted_revenue: num,
        return_visits_count: int,
        last_visit_date: str,
        phone: str,
        email: str,
      }),
    },
    page: legacyPageOutput,
    contacts_included: { type: 'boolean' as const },
    client_identity_status: { type: 'string' as const },
    untrusted_data_note: { type: 'string' as const },
  }),
  handler: async ({ input, client }) =>
    legacyAnalytics.getClientForecast(client, input),
});

export const analyticsGetServiceProfitabilityTool = defineTool({
  name: 'analytics_get_service_profitability',
  category: 'Analytics',
  description:
    '[Analytics] Service contribution by service or service category: rendered-service count, discounts and loyalty write-offs, client-account and cash/card revenue, consumables cost, team-member compensation, contribution result and share of revenue. Filter by one team member or service category and paginate at source. Temporary stable legacy-report adapter pending V3; it never creates a saved report. Needs the Sales by services report permission.',
  annotations: { title: 'Analytics: service profitability', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    group_by: z.enum(['service', 'service_category']).optional(),
    team_member_id: z.number().int().positive().optional(),
    service_category_id: z.number().int().positive().optional(),
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Page, starting at 1.'),
    page_size: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Rows per page, at most 500. Default 100.'),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    period: periodSchema,
    currency: str,
    group_by: { type: 'string' as const },
    rows: {
      type: 'array' as const,
      items: objectSchema({
        service_id: int,
        service_category_id: int,
        title: str,
        service_category_title: str,
        services_rendered_count: { type: 'integer' as const },
        payments: paymentBreakdownOutput,
        cash_or_card_revenue: num,
        consumables_cost: num,
        team_member_compensation: num,
        contribution_result: num,
        revenue_share_percent: num,
      }),
    },
    totals: objectSchema({
      services_rendered_count: { type: 'integer' as const },
      payments: paymentBreakdownOutput,
      cash_or_card_revenue: num,
      consumables_cost: num,
      team_member_compensation: num,
      contribution_result: num,
    }),
    page: legacyPageOutput,
    untrusted_data_note: { type: 'string' as const },
  }),
  handler: async ({ input, client }) =>
    legacyAnalytics.getServiceProfitability(client, input),
});

export const analyticsGetServiceMixTrendTool = defineTool({
  name: 'analytics_get_service_mix_trend',
  category: 'Analytics',
  description:
    '[Analytics] Monthly delivered service value from attended appointment service lines, grouped by service, current category, team member, assigned resource, or assigned device versus current category with service drilldown. Scans every source page or refuses the call. manual_cost is a line total before loyalty deductions, not cash receipts or accounting revenue. All lines on a visit with one known resource type are attributed to it. When several resource types are assigned, their IDs are reported but line value remains unattributed; it is never duplicated across devices. Product sales and account top-ups are excluded.',
  annotations: { title: 'Analytics: service mix trend', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    group_by: z
      .enum([
        'service',
        'current_category',
        'team_member',
        'assigned_resource',
        'assigned_device_or_current_category',
      ])
      .optional(),
    team_member_id: z.number().int().positive().optional(),
    page: z.number().int().positive().optional(),
    page_size: z.number().int().min(1).max(50).optional(),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' },
    period: periodSchema,
    currency: str,
    group_by: { type: 'string' },
    team_member_id: int,
    rows: {
      type: 'array',
      items: objectSchema({
        month: { type: 'string' },
        group_id: int,
        group_title: str,
        group_type: str,
        service_id: int,
        service_title: str,
        associated_resource_ids: { type: 'array', items: { type: 'integer' } },
        unmapped_resource_instance_ids: {
          type: 'array',
          items: { type: 'integer' },
        },
        line_count: { type: 'integer' },
        appointment_count: { type: 'integer' },
        client_count: { type: 'integer' },
        delivered_service_value: { type: 'number' },
        charge_after_loyalty: num,
        attribution: { type: 'string' },
      }),
    },
    page: { type: 'object' },
    totals: { type: 'object' },
    provenance: { type: 'object' },
    untrusted_data_note: { type: 'string' },
  }),
  handler: async ({ input, client }) =>
    serviceMix.getServiceMixTrend(client, input),
});

export const analyticsGetClientServicePenetrationTool = defineTool({
  name: 'analytics_get_client_service_penetration',
  category: 'Analytics',
  description:
    '[Analytics] Distinct attended clients who used target services, current categories or resources assigned to appointments over up to 365 days. Every recorded resource type on an attended service visit counts for resource adoption, including visits with multiple resources; delivered value is not duplicated across them. Returns top SKU/group adoption, confirmed mono-group clients, co-occurrence, delivered-value cohort gaps and paged non-adopter IDs. Every percentage uses the identified active attended-client denominator. Resource assignment is an operational usage proxy, not an immutable usage audit; cohorts rank delivered manual_cost, not cash spending.',
  annotations: { title: 'Analytics: client service penetration', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    source_service_ids: z.array(z.number().int().positive()).max(30).optional(),
    source_category_ids: z
      .array(z.number().int().positive())
      .max(30)
      .optional(),
    source_resource_ids: z
      .array(z.number().int().positive())
      .max(30)
      .optional(),
    target_service_ids: z.array(z.number().int().positive()).max(30).optional(),
    target_category_ids: z
      .array(z.number().int().positive())
      .max(30)
      .optional(),
    target_resource_ids: z
      .array(z.number().int().positive())
      .max(30)
      .optional(),
    page: z.number().int().positive().optional(),
    page_size: z.number().int().min(1).max(100).optional(),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' },
    period: periodSchema,
    source_service_ids: { type: 'array', items: { type: 'integer' } },
    source_category_ids: { type: 'array', items: { type: 'integer' } },
    source_resource_ids: { type: 'array', items: { type: 'integer' } },
    target_service_ids: { type: 'array', items: { type: 'integer' } },
    target_category_ids: { type: 'array', items: { type: 'integer' } },
    target_resource_ids: { type: 'array', items: { type: 'integer' } },
    denominator: { type: 'object' },
    target_adopters: { type: 'integer' },
    penetration_percent: { type: 'number' },
    source_clients: { type: 'integer' },
    source_target_overlap: { type: 'integer' },
    source_without_target: { type: 'integer' },
    delivered_value_cohorts: { type: 'array', items: { type: 'object' } },
    cohort_penetration_gap_percentage_points: num,
    group_insights: objectSchema({
      group_basis: { type: 'string' },
      ranking_limit: { type: 'integer' },
      total_attributed_groups: { type: 'integer' },
      top_groups: {
        type: 'array',
        items: objectSchema({
          group_type: { type: 'string' },
          group_id: { type: 'integer' },
          group_title: str,
          active_clients: { type: 'integer' },
          penetration_percent: { type: 'number' },
          confirmed_mono_group_clients: { type: 'integer' },
          cohort_penetration: {
            type: 'array',
            items: objectSchema({
              cohort: { type: 'string' },
              denominator: { type: 'integer' },
              adopters: { type: 'integer' },
              percent: num,
            }),
          },
          top_vs_remaining_gap_percentage_points: num,
        }),
      },
      total_service_skus: { type: 'integer' },
      top_service_skus: {
        type: 'array',
        items: objectSchema({
          service_id: { type: 'integer' },
          service_title: str,
          active_clients: { type: 'integer' },
          penetration_percent: { type: 'number' },
          service_lines: { type: 'integer' },
          delivered_service_value: { type: 'number' },
        }),
      },
      total_group_pairs: { type: 'integer' },
      top_group_cooccurrence: {
        type: 'array',
        items: objectSchema({
          first_group: objectSchema({
            type: { type: 'string' },
            id: { type: 'integer' },
          }),
          second_group: objectSchema({
            type: { type: 'string' },
            id: { type: 'integer' },
          }),
          active_clients: { type: 'integer' },
          penetration_percent: { type: 'number' },
        }),
      },
      clients_with_unattributed_lines: { type: 'integer' },
      confirmed_mono_group_clients: { type: 'integer' },
    }),
    candidate_client_ids: { type: 'array', items: { type: 'integer' } },
    page: { type: 'object' },
    provenance: { type: 'object' },
  }),
  handler: async ({ input, client }) =>
    serviceMix.getClientServicePenetration(client, input),
});

export const analyticsGetTeamMemberSalesTool = defineTool({
  name: 'analytics_get_team_member_sales',
  category: 'Analytics',
  description:
    '[Analytics] Sales by team member: total revenue, service and product revenue and quantities, discounts and loyalty write-offs, client-account payments, upcoming-appointment revenue, worked hours, revenue per worked hour and share of location revenue. Legacy rows are matched to a current team-member id only when name and position identify exactly one member; stale or ambiguous identities return a null id and explicit status. Supports the source report’s filters for positions, services, service categories, products and product categories. Temporary stable legacy-report adapter pending V3; it never creates a saved report. Needs the Sales by team members report permission.',
  annotations: { title: 'Analytics: sales by team member', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    position_ids: legacyIdList('Restrict to these positions.'),
    service_ids: legacyIdList('Include sales of these services only.'),
    service_category_ids: legacyIdList(
      'Include sales in these service categories only.'
    ),
    product_ids: legacyIdList('Include sales of these products only.'),
    product_category_ids: legacyIdList(
      'Include sales in these product categories only.'
    ),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    period: periodSchema,
    currency: str,
    filters_applied: objectSchema({
      position_ids: {
        type: 'array' as const,
        items: { type: 'integer' as const },
      },
      service_ids: {
        type: 'array' as const,
        items: { type: 'integer' as const },
      },
      service_category_ids: {
        type: 'array' as const,
        items: { type: 'integer' as const },
      },
      product_ids: {
        type: 'array' as const,
        items: { type: 'integer' as const },
      },
      product_category_ids: {
        type: 'array' as const,
        items: { type: 'integer' as const },
      },
    }),
    rows: {
      type: 'array' as const,
      items: objectSchema({
        team_member_id: int,
        team_member_identity_status: {
          type: 'string' as const,
          enum: ['matched', 'unavailable', 'ambiguous'],
        },
        team_member_name: str,
        position_title: str,
        revenue: num,
        services_revenue: num,
        services_rendered_count: int,
        products_revenue: num,
        products_count: int,
        payments: paymentBreakdownOutput,
        upcoming_appointments_revenue: num,
        worked_hours: num,
        revenue_per_worked_hour: num,
        revenue_share_percent: num,
      }),
    },
    totals: objectSchema({
      revenue: num,
      services_revenue: num,
      services_rendered_count: int,
      products_revenue: num,
      products_count: int,
      payments: paymentBreakdownOutput,
      upcoming_appointments_revenue: num,
      worked_hours: num,
    }),
    untrusted_data_note: { type: 'string' as const },
  }),
  handler: async ({ input, client }) =>
    legacyAnalytics.getTeamMemberSales(client, input),
});

// ========== task-oriented decision analytics ==========

const boundedIds = (description: string, max = 25) =>
  z
    .array(z.number().int().positive())
    .min(1)
    .max(max)
    .optional()
    .describe(description);

const capacityBucketOutput = closedObjectSchema({
  key: requiredString,
  scheduled_hours: requiredNumber,
  booked_hours: requiredNumber,
  completed_utilized_hours: requiredNumber,
  idle_hours: requiredNumber,
  occupancy_percent: num,
  completed_appointments_count: requiredInteger,
  no_show_appointments_count: requiredInteger,
  cancelled_appointments_count: requiredInteger,
  pending_appointments_count: requiredInteger,
  revenue: num,
  revenue_per_scheduled_hour: num,
});

const matrixRowOutput = closedObjectSchema({
  team_member_id: requiredInteger,
  team_member_name: str,
  position_id: int,
  position_title: str,
  service_id: requiredInteger,
  service_title: str,
  service_category_id: int,
  service_category_title: str,
  completed_appointments_count: nullValue,
  services_rendered_count: requiredInteger,
  clients_count: nullValue,
  revenue: num,
  average_check: num,
  booked_duration_hours: nullValue,
  delivered_duration_hours: nullValue,
  occupancy_contribution_percent: nullValue,
  team_member_compensation: num,
  consumables_cost: num,
  contribution_result: num,
  repeat_or_rebooking_rate_percent: nullValue,
  sample_size: requiredInteger,
  revenue_share_within_team_member_percent: num,
  revenue_share_within_service_percent: num,
});

const inventoryRiskRowOutput = closedObjectSchema({
  product_id: requiredInteger,
  sku: nullValue,
  title: str,
  unit: str,
  supplier_title: str,
  inventory_id: int,
  product_category_id: int,
  current_stock: num,
  reserved_stock: nullValue,
  available_stock: nullValue,
  units_sold: num,
  average_daily_sales: num,
  days_of_cover: num,
  last_sale_date: nullValue,
  stock_value: nullValue,
  cost_per_unit: nullValue,
  risk: { type: 'string' as const, enum: decisionAnalytics.INVENTORY_RISKS },
  recommended_reorder_quantity: num,
  negative_stock: bool,
  source_metrics: closedObjectSchema({
    units_received: num,
    opening_stock: num,
    average_stock: num,
    turnover_days: num,
    turnover_count: num,
    stock_level_days: num,
  }),
});

const leakageAmountCoverageOutput = closedObjectSchema({
  amount_available_count: requiredInteger,
  amount_missing_count: requiredInteger,
});
const leakageUnavailableCoverageOutput = closedObjectSchema({
  available: { type: 'boolean' as const, const: false },
  reason: requiredString,
});
const leakageCategoryOutput = {
  oneOf: [
    closedObjectSchema({
      key: {
        type: 'string' as const,
        enum: [
          'no_show_appointments',
          'cancelled_appointments',
          'completed_but_not_marked_paid',
          'discounts',
        ],
      },
      observed_count: requiredInteger,
      observed_amount: num,
      estimated_opportunity_amount: num,
      formula: requiredString,
      denominator: requiredString,
      coverage: leakageAmountCoverageOutput,
      quality: { type: 'string' as const, enum: ['high', 'medium', 'low'] },
    }),
    closedObjectSchema({
      key: { type: 'string' as const, const: 'loyalty_write_offs' },
      observed_count: nullValue,
      observed_amount: nullValue,
      estimated_opportunity_amount: nullValue,
      formula: nullValue,
      denominator: nullValue,
      coverage: leakageUnavailableCoverageOutput,
      quality: { type: 'string' as const, const: 'unavailable' },
    }),
    closedObjectSchema({
      key: {
        type: 'string' as const,
        const: 'scheduled_but_unbooked_capacity',
      },
      observed_count: nullValue,
      observed_amount: nullValue,
      opportunity_capacity_hours: num,
      estimated_opportunity_amount: num,
      formula: requiredString,
      denominator: requiredString,
      coverage: closedObjectSchema({
        selected_team_members: requiredInteger,
        available_team_members: requiredInteger,
      }),
      quality: {
        type: 'string' as const,
        enum: ['low', 'insufficient_data'],
      },
    }),
    closedObjectSchema({
      key: {
        type: 'string' as const,
        const: 'scheduled_but_unbooked_capacity',
      },
      observed_count: nullValue,
      observed_amount: nullValue,
      opportunity_capacity_hours: nullValue,
      estimated_opportunity_amount: nullValue,
      formula: nullValue,
      denominator: nullValue,
      coverage: leakageUnavailableCoverageOutput,
      quality: { type: 'string' as const, const: 'unavailable' },
    }),
  ],
};

export const analyticsGetProfitAndLossStatementTool = defineTool({
  name: 'analytics_get_profit_and_loss_statement',
  category: 'Analytics',
  description:
    '[Analytics] Explain how much this location earned during a period without overstating accounting completeness. Returns sales streams, posted finance income and expense categories, service consumables, attributed team-member compensation, a service contribution result, and a tracked operating result. It never labels the result net profit when taxes, rent, external payroll, product cost or unposted expenses cannot be proven complete. Use analytics_get_day_end_report for one day’s till reconciliation and analytics_get_service_profitability for service-level detail.',
  annotations: {
    title: 'Analytics: profit and loss statement',
    ...READ_ONLY,
  },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    include_comparison: z
      .boolean()
      .optional()
      .describe(
        'Include a comparison. With no explicit comparison dates, uses the immediately preceding period of equal length.'
      ),
    comparison_date_from: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Optional first day of an explicit comparison period, YYYY-MM-DD. Supply together with comparison_date_to and set include_comparison=true.'
      ),
    comparison_date_to: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe(
        'Optional last day of an explicit comparison period, YYYY-MM-DD, inclusive.'
      ),
  }),
  outputSchema: closedObjectSchema(
    {
      location_id: requiredInteger,
      period: strictPeriodSchema,
      comparison_period: strictDateRangeSchema,
      currency: str,
      sales_revenue_by_stream: closedObjectSchema({
        current_period_status: {
          type: 'string' as const,
          enum: ['verified', 'clamped', 'unverified'],
        },
        current_effective_period: nullableDateRangeSchema,
        comparison_period_status: {
          enum: ['verified', 'clamped', 'unverified', null],
        },
        comparison_effective_period: nullableDateRangeSchema,
        unavailable_reason: str,
        services: comparedValueSchema,
        products: comparedValueSchema,
        memberships: comparedValueSchema,
        gift_cards: comparedValueSchema,
        other: closedObjectSchema({
          current: nullValue,
          reason: requiredString,
        }),
        formula: requiredString,
      }),
      operating_ledger: closedObjectSchema({
        income_total: comparedValueSchema,
        expense_total: comparedValueSchema,
        tracked_operating_result: comparedValueSchema,
        categories: {
          type: 'array' as const,
          items: closedObjectSchema({
            category_id: int,
            title: str,
            direction: {
              type: 'string' as const,
              enum: ['income', 'expense'],
            },
            amount: comparedValueSchema,
          }),
        },
        category_coverage: closedObjectSchema({
          total_count: requiredInteger,
          returned: requiredInteger,
          limit: requiredInteger,
          complete: bool,
        }),
        formula: requiredString,
      }),
      service_contribution: closedObjectSchema({
        cash_or_card_revenue: comparedValueSchema,
        client_account_payments: comparedValueSchema,
        consumables_cost: comparedValueSchema,
        team_member_compensation: comparedValueSchema,
        contribution_result: comparedValueSchema,
        contribution_margin_percent: comparedValueSchema,
        formula: requiredString,
      }),
      cost_classification: closedObjectSchema({
        direct_service_costs: closedObjectSchema({
          consumables: num,
          team_member_compensation: num,
          total: num,
          scope: requiredString,
        }),
        indirect_costs: nullValue,
        indirect_costs_unavailable_reason: requiredString,
      }),
      gross_result: nullValue,
      net_profit: nullValue,
      completeness: closedObjectSchema({
        result_label: {
          type: 'string' as const,
          const: 'tracked_operating_result',
        },
        included_cost_classes: {
          type: 'array' as const,
          items: {
            type: 'string' as const,
            enum: [
              'posted_finance_expense_categories',
              'service_consumables_cost',
              'attributed_team_member_compensation',
            ],
          },
        },
        missing_or_unproven_cost_classes: {
          type: 'array' as const,
          items: {
            type: 'string' as const,
            enum: [
              'retail_product_cost',
              'taxes_completeness',
              'rent_completeness',
              'external_payroll_completeness',
              'unposted_expenses',
            ],
          },
        },
        limitations: {
          type: 'array' as const,
          items: requiredString,
        },
      }),
      provenance: {
        type: 'array' as const,
        items: closedObjectSchema({
          source_id: {
            type: 'string' as const,
            enum: [
              'posted_finance_ledger',
              'day_end_sales_memo',
              'service_contribution_report',
            ],
          },
          format: {
            type: 'string' as const,
            enum: ['HTML', 'JSON', 'JSON envelope with HTML table'],
          },
          metrics: {
            type: 'array' as const,
            items: {
              type: 'string' as const,
              enum: [
                'operating_ledger',
                'sales_revenue_by_stream',
                'service_contribution',
              ],
            },
          },
        }),
      },
      untrusted_data_note: requiredString,
    },
    [
      'location_id',
      'period',
      'currency',
      'sales_revenue_by_stream',
      'operating_ledger',
      'service_contribution',
      'cost_classification',
      'gross_result',
      'net_profit',
      'completeness',
      'provenance',
      'untrusted_data_note',
    ]
  ),
  handler: async ({ input, client }) =>
    decisionAnalytics.getProfitAndLossStatement(client, input),
});

export const analyticsGetCapacityHeatmapTool = defineTool({
  name: 'analytics_get_capacity_heatmap',
  category: 'Analytics',
  description:
    '[Analytics] Show when scheduled capacity is overloaded or underused. Buckets scheduled, booked, completed-utilized and idle hours, appointment outcomes, attributable completed revenue and revenue per scheduled hour. Schedule time is always the denominator; appointment and group-event busy intervals are unioned so overlaps count once, and unscheduled time is never called idle. Use hour_of_day for recurring daily patterns, weekday for weekly patterns, or date_hour for a detailed range of at most 31 days.',
  annotations: { title: 'Analytics: capacity heatmap', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    team_member_ids: boundedIds(
      'Restrict to these team members. At most 25; leave out to use the bounded location roster.'
    ),
    position_ids: boundedIds(
      'Restrict to team members in these positions. At most 20.'
    ),
    granularity: z
      .enum(['hour_of_day', 'weekday', 'date_hour'])
      .describe(
        'hour_of_day combines the same hour across dates; weekday combines each weekday; date_hour returns each local date and hour and is limited to 31 days.'
      ),
  }),
  outputSchema: closedObjectSchema({
    location_id: requiredInteger,
    period: strictPeriodSchema,
    granularity: {
      type: 'string' as const,
      enum: ['hour_of_day', 'weekday', 'date_hour'],
    },
    team_member_ids: {
      type: 'array' as const,
      items: requiredInteger,
    },
    buckets: { type: 'array' as const, items: capacityBucketOutput },
    peak_buckets: {
      type: 'array' as const,
      items: capacityBucketOutput,
    },
    underutilized_buckets: {
      type: 'array' as const,
      items: capacityBucketOutput,
    },
    coverage: closedObjectSchema({
      complete: bool,
      selected_team_members: requiredInteger,
      available_team_members: requiredInteger,
      appointment_pages_read: requiredInteger,
      appointment_page_cap: requiredInteger,
      unscheduled_appointment_count: requiredInteger,
      notes: { type: 'array' as const, items: requiredString },
    }),
    provenance: {
      type: 'array' as const,
      items: closedObjectSchema({
        source_id: {
          type: 'string' as const,
          enum: ['team_member_schedule', 'appointments'],
        },
        metrics: {
          type: 'array' as const,
          items: {
            type: 'string' as const,
            enum: [
              'scheduled_hours',
              'booked_hours_from_busy_intervals',
              'booked_hours_from_appointments',
              'completed_utilized_hours',
              'appointment_counts',
              'revenue',
            ],
          },
        },
      }),
    },
  }),
  handler: async ({ input, client }) =>
    decisionAnalytics.getCapacityHeatmap(client, input),
});

export const analyticsGetRevenueLeakageTool = defineTool({
  name: 'analytics_get_revenue_leakage',
  category: 'Analytics',
  description:
    '[Analytics] Identify revenue reductions and opportunity risk without combining unlike concepts. Reports no-show and cancelled appointments, completed visits not marked paid, observed service discounts, and scheduled-but-unbooked capacity. Actual reductions stay separate from estimated opportunity; every category carries its own formula, denominator, source coverage and quality flag. Use analytics_get_appointments_breakdown for simple outcome shares and analytics_get_capacity_heatmap for detailed time buckets.',
  annotations: { title: 'Analytics: revenue leakage', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    team_member_ids: boundedIds(
      'Restrict appointment and capacity signals to these team members.'
    ),
    service_ids: boundedIds(
      'Keep appointments containing at least one of these services.'
    ),
    service_category_ids: boundedIds(
      'Keep appointments containing a service in one of these categories.'
    ),
    visit_statuses: z
      .array(z.enum(VISIT_STATUSES))
      .min(1)
      .optional()
      .describe(
        'Restrict the analysis to these canonical appointment statuses. Leave out to report every leakage category.'
      ),
    include_capacity_opportunity: z
      .boolean()
      .optional()
      .describe(
        'Include scheduled-but-unbooked capacity and its optional low-confidence opportunity estimate. Defaults to true.'
      ),
  }),
  outputSchema: closedObjectSchema({
    location_id: requiredInteger,
    period: strictPeriodSchema,
    currency: str,
    categories: { type: 'array' as const, items: leakageCategoryOutput },
    totals: nullValue,
    totals_not_combined_reason: requiredString,
    coverage: closedObjectSchema({
      complete: bool,
      appointment_pages_read: requiredInteger,
      appointment_page_cap: requiredInteger,
      limitations: { type: 'array' as const, items: requiredString },
    }),
    provenance: {
      type: 'array' as const,
      items: closedObjectSchema({
        source_id: {
          type: 'string' as const,
          enum: ['appointments', 'team_member_schedule'],
        },
        metrics: {
          type: 'array' as const,
          items: {
            type: 'string' as const,
            enum: [
              'appointment outcomes',
              'booked prices',
              'discount reductions',
              'scheduled capacity',
            ],
          },
        },
      }),
    },
  }),
  handler: async ({ input, client }) =>
    decisionAnalytics.getRevenueLeakage(client, input),
});

export const analyticsGetTeamMemberServiceMatrixTool = defineTool({
  name: 'analytics_get_team_member_service_matrix',
  category: 'Analytics',
  description:
    '[Analytics] Compare genuine team-member × service performance cells from a report grouped by both dimensions. Returns delivered service lines, cash-or-card revenue, average check, compensation, consumables, contribution result, shares within each team member and within each service, plus honest nulls for unavailable pair metrics. Rankings exclude statistically tiny cells by default while the paged canonical matrix keeps every cell. At most ten team members are evaluated per call.',
  annotations: {
    title: 'Analytics: team member service matrix',
    ...READ_ONLY,
  },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    team_member_ids: boundedIds(
      'Team members to compare, at most ten. Leave out to use the first bounded matching roster.',
      10
    ),
    position_ids: boundedIds(
      'Restrict the team-member roster to these positions.',
      20
    ),
    service_ids: boundedIds(
      'Keep only these stable service ids after reading the grouped source.',
      50
    ),
    service_category_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Restrict the source report to one service category; the source supports one category at a time.'
      ),
    sort_by: z
      .enum(['contribution_result', 'revenue', 'services_rendered_count'])
      .optional()
      .describe('Metric used to order matrix rows and compact summaries.'),
    sort_order: z
      .enum(['asc', 'desc'])
      .optional()
      .describe('Ascending or descending order. Defaults to descending.'),
    minimum_sample_size: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(
        'Minimum delivered service lines for top and bottom summaries. Defaults to 3; canonical matrix rows are never dropped by this threshold.'
      ),
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('1-based result page.'),
    page_size: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Matrix cells returned per page, at most 100.'),
  }),
  outputSchema: closedObjectSchema({
    location_id: requiredInteger,
    period: strictPeriodSchema,
    currency: str,
    rows: { type: 'array' as const, items: matrixRowOutput },
    page: closedObjectSchema({
      page: requiredInteger,
      page_size: requiredInteger,
      total_count: requiredInteger,
      returned: requiredInteger,
      has_more: bool,
    }),
    top_cells: { type: 'array' as const, items: matrixRowOutput },
    bottom_cells: {
      type: 'array' as const,
      items: matrixRowOutput,
    },
    ranking: closedObjectSchema({
      sort_by: {
        type: 'string' as const,
        enum: ['contribution_result', 'revenue', 'services_rendered_count'],
      },
      sort_order: { type: 'string' as const, enum: ['asc', 'desc'] },
      minimum_sample_size: requiredInteger,
      excluded_small_sample_cells: requiredInteger,
    }),
    coverage: closedObjectSchema({
      complete: bool,
      selected_team_members: requiredInteger,
      available_team_members: requiredInteger,
      source_pages_per_team_member_cap: requiredInteger,
      unavailable_metrics: closedObjectSchema({
        completed_appointments_count: requiredString,
        clients_count: requiredString,
        booked_duration_hours: requiredString,
        delivered_duration_hours: requiredString,
        occupancy_contribution_percent: requiredString,
        repeat_or_rebooking_rate_percent: requiredString,
      }),
    }),
    formulae: closedObjectSchema({
      average_check: requiredString,
      contribution_result: requiredString,
      shares: requiredString,
    }),
    provenance: {
      type: 'array' as const,
      items: closedObjectSchema({
        source_id: {
          type: 'string' as const,
          const: 'service_contribution_report',
        },
        format: {
          type: 'string' as const,
          const: 'JSON envelope with HTML table',
        },
        grouping: requiredString,
      }),
    },
    untrusted_data_note: requiredString,
  }),
  handler: async ({ input, client }) =>
    decisionAnalytics.getTeamMemberServiceMatrix(client, input),
});

export const analyticsGetInventoryReorderRisksTool = defineTool({
  name: 'analytics_get_inventory_reorder_risks',
  category: 'Analytics',
  description:
    '[Analytics] Show products likely to run out, need reordering, move slowly or be overstocked from the authenticated inventory-turnover report. Uses current stock and period sales velocity with bounded lead-time and safety-stock assumptions. Recommendations are analytical guidance only and never create purchase orders or change inventory. Zero sales, negative stock, fractional units and an all-inventories aggregate are handled explicitly; unavailable codes, reservations, costs and last-sale dates stay null with reasons.',
  annotations: { title: 'Analytics: inventory reorder risks', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    inventory_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Restrict to one inventory. Leave out for the source report’s aggregate across visible inventories.'
      ),
    product_category_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Restrict to one product category supported by the source.'),
    supplier_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Restrict to one supplier supported by the source.'),
    lead_time_days: z
      .number()
      .int()
      .min(1)
      .max(180)
      .optional()
      .describe('Supplier lead time in days. Defaults to 14; maximum 180.'),
    safety_stock_days: z
      .number()
      .int()
      .min(0)
      .max(180)
      .optional()
      .describe('Additional safety-stock cover in days. Defaults to 7.'),
    risks: z
      .array(z.enum(decisionAnalytics.INVENTORY_RISKS))
      .min(1)
      .optional()
      .describe(
        'Return only these risk classes after reading the source page.'
      ),
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('1-based source page.'),
    page_size: z
      .number()
      .int()
      .positive()
      .max(100)
      .optional()
      .describe('Products requested from the source page, at most 100.'),
  }),
  outputSchema: closedObjectSchema({
    location_id: requiredInteger,
    period: strictPeriodSchema,
    assumptions: closedObjectSchema({
      lead_time_days: requiredInteger,
      safety_stock_days: requiredInteger,
    }),
    rows: { type: 'array' as const, items: inventoryRiskRowOutput },
    page: closedObjectSchema({
      page: requiredInteger,
      page_size: requiredInteger,
      total_count: requiredInteger,
      returned: requiredInteger,
      has_more: bool,
      returned_after_risk_filter: requiredInteger,
    }),
    formulae: closedObjectSchema({
      average_daily_sales: requiredString,
      days_of_cover: requiredString,
      recommended_reorder_quantity: requiredString,
      risk: requiredString,
    }),
    coverage: closedObjectSchema({
      complete: bool,
      filters_supported_by_source: {
        type: 'array' as const,
        items: {
          type: 'string' as const,
          enum: ['inventory_id', 'product_category_id', 'supplier_id'],
        },
      },
      unavailable_fields: closedObjectSchema({
        sku: requiredString,
        reserved_stock: requiredString,
        available_stock: requiredString,
        last_sale_date: requiredString,
        stock_value: requiredString,
        cost_per_unit: requiredString,
      }),
      multiple_inventories: requiredString,
    }),
    provenance: {
      type: 'array' as const,
      items: closedObjectSchema({
        source_id: {
          type: 'string' as const,
          const: 'inventory_turnover_report',
        },
        format: {
          type: 'string' as const,
          const: 'JSON envelope with HTML table',
        },
        permission: requiredString,
      }),
    },
    untrusted_data_note: requiredString,
  }),
  handler: async ({ input, client }) =>
    decisionAnalytics.getInventoryReorderRisks(client, input),
});

// ========== report builder ==========

// ========== report builder — DISABLED, not served =========================
// Kept compiling and tested, withheld from every view by
// `src/tools/disabled-tools.ts`. Do not point guidance at these names.

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
  description: `[Analytics] Run a report and get a table back: either a built-in template by template_id, or an ad-hoc report built from a dataset, the fields you want and what to group them by. This is how you answer "revenue by team member last month", "top services by revenue", "sales per client", "income and expenses by month", "P&L for the quarter", "occupancy hours per stylist". Get template_id from analytics_list_report_templates and field keys from analytics_list_report_fields. At most ${REPORT_ROW_CAP} rows come back inline; a longer table is attached as a CSV resource link that stays readable for 30 minutes. The tool reuses a ready "[Altegio Assistant] …" report when one exists and never lets a failed duplicate shadow it. Failed or obsolete assistant reports can be removed with analytics_delete_assistant_report. Period overrides require the location's new report-data API; on the legacy API an existing report can be read only for its stored period. Needs the Analytics access right and an active subscription.`,
  annotations: {
    title: 'Analytics: run a report',
    // Not marked read-only on purpose: running a template requires a stored
    // report in the location's report builder, so the first run of each shape
    // creates one (idempotently reused afterwards, never
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

export const analyticsDeleteAssistantReportTool = defineTool({
  name: 'analytics_delete_assistant_report',
  category: 'Analytics',
  description:
    '[Analytics] Permanently delete one report created by this assistant. The report must have a name beginning with "[Altegio Assistant]"; reports created or named by the owner are refused. Get the exact report_id from analytics_list_saved_reports. Use this to remove failed, obsolete or duplicate assistant artifacts without touching customer-created reports.',
  annotations: {
    title: 'Analytics: delete an assistant report',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: locationId,
    report_id: z
      .string()
      .min(1)
      .describe(
        'Exact assistant-created report ID from analytics_list_saved_reports.'
      ),
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    report_id: { type: 'string' as const },
    report_name: { type: 'string' as const },
    deleted: { type: 'boolean' as const },
  }),
  confirm: {
    action: 'Delete assistant report',
    target: (input) =>
      `report ${input.report_id} at location ${input.location_id}`,
    consequence:
      'The saved report and its stored configuration are removed from the location\u2019s report builder. Only reports this assistant created are eligible; the underlying appointment and payment data is untouched.',
  },
  handler: async ({ input, client }) =>
    analytics.deleteAssistantReport(client, input),
});

export const analyticsRunSavedReportTool = defineTool({
  name: 'analytics_run_saved_report',
  category: 'Analytics',
  description: `[Analytics] Run a report that already exists in the location’s report builder and get the table back. Get report_id from analytics_list_saved_reports. Locations with the new report-data API can override the period per run without changing the report; locations on the legacy API can safely read only the report’s stored period and reject a different range instead of returning mislabeled data. At most ${REPORT_ROW_CAP} rows come back inline; a longer table is attached as a CSV resource link readable for 30 minutes. Needs the Analytics access right and an active subscription.`,
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

const nextPageFields = {
  page: z
    .number()
    .int()
    .min(1)
    .max(100000)
    .optional()
    .describe('One-based page. Default 1.'),
  page_size: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Rows per page, default 25, maximum 100. Reduce if the result is too large.'
    ),
};
const nextBaseOutput = {
  location_id: { type: 'integer' as const },
  period: periodSchema,
  untrusted_data_note: { type: 'string' as const },
};
const capacityMetricsOutput = {
  worked_days: num,
  scheduled_hours: num,
  booked_hours: num,
  idle_hours: num,
  occupancy_percent: num,
  upcoming_appointments_count: int,
};
export const analyticsGetTeamMemberCapacityTool = defineTool({
  name: 'analytics_get_team_member_capacity',
  category: 'Analytics',
  description:
    '[Analytics] Working days and hours, booked hours, idle hours, occupancy percentage and upcoming appointments by team member, with source totals. Use for capacity planning; analytics_get_team_member_occupancy gives daily occupancy. Temporary read-only report pending V3. Requires team occupancy report permission. Narrow the period if the result is too large.',
  annotations: { title: 'Analytics: team-member capacity', ...READ_ONLY },
  input: z.object({ location_id: locationId, ...periodFields }),
  outputSchema: objectSchema({
    ...nextBaseOutput,
    rows: {
      type: 'array' as const,
      items: objectSchema({
        team_member_id: int,
        team_member_name: str,
        position_title: str,
        ...capacityMetricsOutput,
      }),
    },
    totals: objectSchema(capacityMetricsOutput),
  }),
  handler: async ({ input, client }) =>
    legacyAnalytics.getTeamMemberCapacity(client, input),
});
export const analyticsGetClientReactivationCandidatesTool = defineTool({
  name: 'analytics_get_client_reactivation_candidates',
  category: 'Analytics',
  description:
    '[Analytics] Build a universal client-reactivation audience from the location client base. A candidate has prior arrived visits on or before an inclusive last-visit cutoff and no arrived visit after it. Qualify by minimum historical visits and optional lifetime spend, then narrow with the same canonical client filters as clients_search (tags, importance, age, birthday, memberships, gift cards, balances, app use and consent). Returns stable client ids, first/last visit dates, lifetime visit count and spend. Results are ordered by client_id ascending for deterministic bounded pagination. Contacts are withheld unless include_contacts=true. Needs access to clients in this location.',
  annotations: {
    title: 'Analytics: client reactivation candidates',
    ...READ_ONLY,
  },
  input: z.object({
    location_id: locationId,
    last_visit_on_or_before: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .describe(
        'Inclusive last-arrived-visit threshold, YYYY-MM-DD, interpreted as a calendar day in the location timezone. A client whose last arrived visit is exactly this date qualifies; any arrived visit on the following day or later excludes them.'
      ),
    minimum_historical_visits: z
      .number()
      .int()
      .min(1)
      .max(100000)
      .optional()
      .describe(
        'Minimum arrived visits on or before the cutoff. Default 1, which excludes clients who never visited.'
      ),
    minimum_total_spent: z
      .number()
      .nonnegative()
      .optional()
      .describe(
        'Optional minimum lifetime spend in major currency units. This is lifetime spend, not spend before the cutoff.'
      ),
    filters: clientFiltersSchema
      .omit({ appointments: true })
      .optional()
      .describe(
        'Optional canonical clients_search filters, combined with the reactivation rules by AND. Appointment-history filters are intentionally owned by this tool.'
      ),
    ...nextPageFields,
    include_contacts: includeContactsArg,
  }),
  outputSchema: objectSchema({
    location_id: { type: 'integer' as const },
    inactivity: objectSchema({
      last_visit_on_or_before: { type: 'string' as const },
      inactive_from: { type: 'string' as const },
      timezone: { type: 'string' as const },
      boundary: { type: 'string' as const },
      qualifying_outcome: { type: 'string' as const },
    }),
    qualification: objectSchema({
      minimum_historical_visits: { type: 'integer' as const },
      minimum_total_spent: { type: 'number' as const },
    }),
    filters_applied: { type: 'object' as const },
    order: objectSchema({
      field: { type: 'string' as const },
      direction: { type: 'string' as const },
    }),
    total_count: { type: 'integer' as const },
    page: { type: 'integer' as const },
    page_size: { type: 'integer' as const },
    returned: { type: 'integer' as const },
    has_more: { type: 'boolean' as const },
    next_page: { type: ['integer', 'null'] as const },
    contacts_included: { type: 'boolean' as const },
    untrusted_data_note: { type: 'string' as const },
    candidates: {
      type: 'array' as const,
      items: objectSchema({
        client_id: { type: 'integer' as const },
        client_name: str,
        first_visit_date: date,
        last_visit_date: date,
        visit_count: int,
        total_spent: num,
        phone: str,
        email: str,
      }),
    },
  }),
  handler: async ({ input, client }) =>
    reactivationAnalytics.getClientReactivationCandidates(client, input),
});
const groupMetricOutput = objectSchema({
  participants: num,
  capacity: num,
  percent: num,
});
export const analyticsGetGroupEventPerformanceTool = defineTool({
  name: 'analytics_get_group_event_performance',
  category: 'Analytics',
  description:
    '[Analytics] Group events with capacity, booked participants, attended and fully paid clients, appointment value and aggregate fill, attendance, payment and average occupancy metrics. Appointment value is not collected revenue. Source dates retain their display format; service ids are unavailable. Team-member ids are matched only when name and position identify one current member; stale/deleted or ambiguous identities remain null with an explicit status. Filter by team member, service, service category, label and active/deleted status; deleted does not imply cancelled. Requires group-event dashboard access. Temporary read-only report pending V3, paginated at source.',
  annotations: { title: 'Analytics: group-event performance', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    ...nextPageFields,
    team_member_id: z.number().int().positive().optional(),
    service_id: z.number().int().positive().optional(),
    service_category_id: z.number().int().positive().optional(),
    label_id: z.number().int().positive().optional(),
    status: z
      .enum(['all', 'active', 'deleted'])
      .optional()
      .describe(
        'Default all; source distinguishes deleted events, not cancellation.'
      ),
  }),
  outputSchema: objectSchema({
    ...nextBaseOutput,
    currency: str,
    page: legacyPageOutput,
    metrics: {
      anyOf: [
        objectSchema({
          booked: groupMetricOutput,
          attended: groupMetricOutput,
          paid: groupMetricOutput,
          average_occupancy: groupMetricOutput,
        }),
        { type: 'null' as const },
      ],
    },
    rows: {
      type: 'array' as const,
      items: objectSchema({
        group_event_id: int,
        team_member_id: int,
        team_member_identity_status: {
          type: 'string' as const,
          enum: ['matched', 'unavailable', 'ambiguous'],
        },
        team_member_name: str,
        position_title: str,
        service_id: { type: 'null' as const },
        service_title: str,
        date_display: str,
        capacity: int,
        booked_participants: int,
        attended_clients: int,
        fully_paid_clients: int,
        appointment_value: num,
        creator_display: str,
        created_at_display: str,
        duration_minutes: num,
        is_deleted: { type: 'boolean' as const },
      }),
    },
  }),
  handler: async ({ input, client }) =>
    legacyAnalytics.getGroupEventPerformance(client, input),
});
const productAmountsOutput = {
  quantity: num,
  total_cost: num,
  total_markup: num,
  markup_percent: num,
  revenue: num,
};
export const analyticsGetProductSalesTool = defineTool({
  name: 'analytics_get_product_sales',
  category: 'Analytics',
  description:
    '[Analytics] Product sales by product or product category with quantity, SKU, barcode, unit, total cost, total markup, markup percentage and revenue including client-account payments. Total cost is for the sold quantity, not unit cost; missing cost permission produces nulls. Category costs are always withheld because the source category report does not enforce that permission. Category rows include hierarchy and must not be summed; use totals. Product pages come from source; category pagination is local. Requires inventory sales-report access, not export access. Temporary read-only report pending V3.',
  annotations: { title: 'Analytics: product sales', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    ...nextPageFields,
    group_by: z.enum(['product', 'product_category']).optional(),
    product_category_id: z.number().int().positive().optional(),
    team_member_id: z.number().int().positive().optional(),
    supplier_id: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Supplier id; 0 selects no supplier. Omit for all suppliers.'),
  }),
  outputSchema: objectSchema({
    ...nextBaseOutput,
    currency: str,
    group_by: {
      type: 'string' as const,
      enum: ['product', 'product_category'],
    },
    cost_fields_status: {
      type: 'string' as const,
      enum: ['available', 'withheld'],
    },
    pagination_source: {
      type: 'string' as const,
      enum: ['upstream', 'local'],
    },
    page: legacyPageOutput,
    rows: {
      type: 'array' as const,
      items: objectSchema({
        product_id: int,
        product_category_id: int,
        title: str,
        sku: str,
        barcode: str,
        unit: str,
        ...productAmountsOutput,
      }),
    },
    totals: objectSchema(productAmountsOutput),
  }),
  handler: async ({ input, client }) =>
    legacyAnalytics.getProductSales(client, input),
});
export const analyticsGetCashFlowBreakdownTool = defineTool({
  name: 'analytics_get_cash_flow_breakdown',
  category: 'Analytics',
  description:
    '[Analytics] Period cash movement by payment item, day, cash-account type and returned account columns, with signed inflow/outflow and net movement totals. Net movement is not an opening or closing account balance. Amount arrays align with columns; account and type views overlap and must not be summed. Source account ids are unavailable. Supports account, team-member, supplier, payment-item, service and product filters. Requires finance period-report access, not export access. Temporary read-only report pending V3; narrow the period or filters for large tables.',
  annotations: { title: 'Analytics: cash-flow breakdown', ...READ_ONLY },
  input: z.object({
    location_id: locationId,
    ...periodFields,
    cash_account_ids: legacyIdList(
      'Restrict to these cash accounts; upstream permissions still apply.'
    ),
    team_member_id: z.number().int().positive().optional(),
    supplier_id: z.number().int().positive().optional(),
    payment_item_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Source payment-item id, including custom items; not an inflow/outflow enum. When selected, aggregate rows are unavailable.'
      ),
    cash_account_type: z.enum(['all', 'cash', 'non_cash']).optional(),
    service_ids: legacyIdList('Service ids.'),
    product_ids: legacyIdList('Product ids.'),
    service_category_ids: legacyIdList('Service category ids.'),
    product_category_ids: legacyIdList('Product category ids.'),
    include_zero_movement_rows: z
      .boolean()
      .optional()
      .describe('Include zero-movement payment items. Default true.'),
  }),
  outputSchema: objectSchema({
    ...nextBaseOutput,
    currency: str,
    filters_applied: objectSchema({
      cash_account_ids: {
        type: 'array' as const,
        items: { type: 'integer' as const },
      },
      team_member_id: int,
      supplier_id: int,
      payment_item_id: int,
      cash_account_type: {
        type: 'string' as const,
        enum: ['all', 'cash', 'non_cash'],
      },
      service_ids: {
        type: 'array' as const,
        items: { type: 'integer' as const },
      },
      product_ids: {
        type: 'array' as const,
        items: { type: 'integer' as const },
      },
      service_category_ids: {
        type: 'array' as const,
        items: { type: 'integer' as const },
      },
      product_category_ids: {
        type: 'array' as const,
        items: { type: 'integer' as const },
      },
      include_zero_movement_rows: { type: 'boolean' as const },
    }),
    columns: {
      type: 'array' as const,
      items: objectSchema({
        period_label: str,
        period_kind: {
          type: 'string' as const,
          enum: ['day', 'period_total'],
        },
        dimension: {
          type: 'string' as const,
          enum: ['cash_account_type', 'cash_account', 'total'],
        },
        cash_account_type: {
          enum: ['all', 'cash', 'non_cash', null],
        },
        cash_account_id: { type: 'null' as const },
        cash_account_title: str,
      }),
    },
    rows: {
      type: 'array' as const,
      items: objectSchema({
        payment_item_id: int,
        payment_item_title: str,
        kind: {
          type: 'string' as const,
          enum: ['inflow', 'outflow', 'net_movement', 'payment_item'],
        },
        direction: { enum: ['inflow', 'outflow', null] },
        amounts: { type: 'array' as const, items: num },
        total: num,
      }),
    },
    totals: objectSchema({ inflow: num, outflow: num, net_movement: num }),
  }),
  handler: async ({ input, client }) =>
    legacyAnalytics.getCashFlowBreakdown(client, input),
});
