/**
 * Golden contract tests for the v1 analytics adapter.
 *
 * Every endpoint the analytics pack calls is replayed from a recorded, sanitized
 * fixture in `./fixtures` and the canonical DTO is asserted field by field. The
 * fixtures carry no personal data: client ids are synthetic, names are generic
 * and no phone numbers or e-mail addresses appear anywhere.
 *
 * `src/__tests__/analytics-live.test.ts` re-records the same fixtures against
 * the demo location when `ALTEGIO_E2E=1` is set, so a backend change shows up as
 * a fixture diff rather than as a silent production failure.
 */
import * as fs from 'fs';
import * as path from 'path';
import { V1AnalyticsAdapter } from '../analytics-adapter.js';
import type { AltegioHttp } from '../../altegio-http.js';
import {
  AnalyticsAccessError,
  AnalyticsInputError,
  AnalyticsUnavailableError,
} from '../../../capabilities/analytics/errors.js';

const FIXTURES = path.join(__dirname, 'fixtures');

export function fixture(name: string): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')
  );
}

interface Recorded {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** Fake transport: routes a path fragment to a fixture and records the call. */
function http(
  routes: Array<[RegExp, string | { status: number; body?: unknown }]>
): { http: AltegioHttp; calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    http: {
      isAuthenticated: () => true,
      request: async (requestPath, init) => {
        calls.push({
          path: requestPath,
          method: (init?.method as string) ?? 'GET',
          headers: (init?.headers as Record<string, string>) ?? {},
          ...(typeof init?.body === 'string' ? { body: init.body } : {}),
        });
        for (const [pattern, target] of routes) {
          if (!pattern.test(requestPath)) continue;
          if (typeof target === 'string') {
            return new Response(JSON.stringify(fixture(target)), {
              status: 200,
            });
          }
          return new Response(JSON.stringify(target.body ?? {}), {
            status: target.status,
          });
        }
        throw new Error(`no fixture routed for ${requestPath}`);
      },
    },
  };
}

const period = {
  location_id: 4564,
  date_from: '2026-08-01',
  date_to: '2026-08-03',
};

function adapter(
  routes: Array<[RegExp, string | { status: number; body?: unknown }]>,
  timezone = 'UTC'
) {
  const transport = http(routes);
  return {
    api: new V1AnalyticsAdapter(transport.http, { timezone }),
    calls: transport.calls,
  };
}

describe('V1AnalyticsAdapter — key metrics', () => {
  it('maps every KPI block to canonical fields', async () => {
    const { api } = adapter([[/analytics\/overall\?/, 'analytics-overall']]);

    const overview = await api.getOverview({ ...period, team_member_id: 9001 });

    expect(overview.currency).toBe('EUR');
    expect(overview.revenue.total).toEqual({
      current: 12480.5,
      previous: 10900,
      change_percent: 14,
    });
    expect(overview.revenue.services.current).toBe(10230.5);
    expect(overview.revenue.products.current).toBe(2250);
    expect(overview.average_check.current).toBe(48.75);
    expect(overview.average_services_check.current).toBe(39.95);
    expect(overview.occupancy_percent).toEqual({
      current: 63.4,
      previous: 58.1,
      change_percent: 9,
    });
    expect(overview.appointments.total_count).toBe(296);
    expect(overview.appointments.cancelled_count).toBe(24);
    expect(overview.clients).toEqual({
      total_in_base: 1842,
      new_count: 63,
      new_percent: 26,
      returning_count: 178,
      returning_percent: 74,
      active_count: 241,
      lost_count: 54,
      lost_percent: 3,
    });
  });

  it('sends the canonical team member alias and English labels', async () => {
    const { api, calls } = adapter([
      [/analytics\/overall/, 'analytics-overall'],
    ]);
    await api.getOverview({ ...period, team_member_id: 9001, position_id: 7 });

    const call = calls[0]!;
    expect(call.path).toContain('team_member_id=9001');
    expect(call.path).toContain('position_id=7');
    expect(call.path).not.toContain('staff_id');
    expect(call.headers['Accept-Language']).toBe('en');
  });

  it('maps the created_by_user_id filter onto the wire parameter', async () => {
    const { api, calls } = adapter([
      [/analytics\/overall/, 'analytics-overall'],
    ]);
    await api.getOverview({ ...period, created_by_user_id: 555 });
    expect(calls[0]!.path).toContain('user_id=555');
  });
});

describe('V1AnalyticsAdapter — daily series', () => {
  it('keys the revenue series by canonical slug and buckets days', async () => {
    const { api } = adapter([[/income_daily/, 'charts-income-daily']]);
    const series = await api.getRevenueDaily(period);

    expect(series.map((s) => s.key)).toEqual([
      'revenue_total',
      'revenue_services',
      'revenue_products',
    ]);
    expect(series[0]!.points).toEqual([
      ['2026-08-01', 430.5],
      ['2026-08-02', 512],
      ['2026-08-03', 388.25],
    ]);
    // The API label "Goods" must not survive.
    expect(series[2]!.label).toBe('Products');
  });

  it('falls back to positional keys for the slug-less appointment chart', async () => {
    const { api } = adapter([[/records_daily/, 'charts-records-daily']]);
    const series = await api.getAppointmentsDaily(period);

    expect(series.map((s) => s.key)).toEqual([
      'appointments_total',
      'appointments_online',
      'appointments_from_new_clients',
    ]);
    expect(series[1]!.points[1]).toEqual(['2026-08-02', 7]);
  });

  it('renames the occupancy series and its no-show share', async () => {
    const { api } = adapter([[/fullness_daily/, 'charts-fullness-daily']]);
    const series = await api.getOccupancyDaily(period);
    expect(series.map((s) => s.key)).toEqual([
      'occupancy_percent',
      'occupancy_no_show_percent',
    ]);
    expect(series[0]!.label).toBe('Occupancy');
  });

  it('maps the client series slugs to canonical keys', async () => {
    const { api } = adapter([[/clients_daily/, 'charts-clients-daily']]);
    const series = await api.getClientsDaily(period);
    expect(series.map((s) => s.key)).toEqual([
      'clients_total',
      'clients_new',
      'clients_returning',
    ]);
  });

  it('buckets chart timestamps in the location timezone', async () => {
    const { api } = adapter(
      [[/income_daily/, 'charts-income-daily']],
      'America/New_York'
    );
    const series = await api.getRevenueDaily(period);
    // UTC midnight is the previous evening in New York.
    expect(series[0]!.points[0]![0]).toBe('2026-07-31');
  });
});

describe('V1AnalyticsAdapter — breakdowns', () => {
  it('maps appointment sources to canonical keys, keeping the original label', async () => {
    const { api } = adapter([[/record_source/, 'charts-record-source']]);
    const slices = await api.getAppointmentSourceBreakdown(period);

    expect(slices[0]).toEqual({
      key: 'receptionist',
      label: 'Receptionist',
      count: 180,
    });
    expect(slices[1]!.key).toBe('online_booking_widget');
    expect(slices[2]!.key).toBe('client_app');
    expect(slices[3]!.key).toBe('api');
  });

  it('maps visit statuses to the canonical enum', async () => {
    const { api } = adapter([[/record_status/, 'charts-record-status']]);
    const slices = await api.getVisitStatusBreakdown(period);

    expect(slices.map((s) => s.key)).toEqual([
      'arrived',
      'confirmed',
      'waiting',
      'no_show',
      'cancelled',
    ]);
  });
});

describe('V1AnalyticsAdapter — receptionist performance', () => {
  const routes: Array<[RegExp, string]> = [
    [/administrator\/clients_scheduled/, 'receptionist-clients-scheduled'],
    [/administrator\/records_closed/, 'receptionist-records-closed'],
    [/administrator\/income/, 'receptionist-income'],
    [
      /administrator\/visited_clients_rescheduled/,
      'receptionist-visited-rescheduled',
    ],
    [
      /administrator\/canceled_clients_rescheduled/,
      'receptionist-canceled-rescheduled',
    ],
  ];

  it('combines the five endpoints into one canonical object', async () => {
    const { api } = adapter([
      [
        /administrator\/visited_clients_rescheduled/,
        'receptionist-visited-rescheduled',
      ],
      [
        /administrator\/canceled_clients_rescheduled/,
        'receptionist-canceled-rescheduled',
      ],
      ...routes.slice(0, 3),
    ]);

    const performance = await api.getReceptionistPerformance(period);

    expect(performance.clients_booked).toEqual({
      current: 184,
      previous: 160,
      change_percent: 15,
    });
    expect(performance.appointments_closed.current).toBe(212);
    expect(performance.revenue.current).toBe(9312.4);
    expect(performance.currency).toBe('EUR');
    expect(performance.rebooked_after_visit).toEqual({
      clients_count: 150,
      rebooked_count: 96,
      rate_percent: 64,
    });
    expect(performance.rebooked_after_no_show.rate_percent).toBe(22.5);
    expect(performance.daily).toBeUndefined();
  });

  it('asks for the daily includes and returns them as [date, value] pairs', async () => {
    const { api, calls } = adapter([
      [
        /administrator\/visited_clients_rescheduled/,
        'receptionist-visited-rescheduled',
      ],
      [
        /administrator\/canceled_clients_rescheduled/,
        'receptionist-canceled-rescheduled',
      ],
      ...routes.slice(0, 3),
    ]);

    const performance = await api.getReceptionistPerformance({
      ...period,
      created_by_user_id: 555,
      include_daily: true,
    });

    expect(calls.some((c) => c.path.includes('include[]='))).toBe(true);
    expect(calls.every((c) => c.path.includes('user_id=555'))).toBe(true);
    expect(performance.daily?.clients_booked).toEqual([
      ['2026-08-01', 9],
      ['2026-08-02', 12],
    ]);
    expect(performance.daily?.revenue).toEqual([
      ['2026-08-01', 401.5],
      ['2026-08-02', 486],
    ]);
  });
});

describe('V1AnalyticsAdapter — loyalty programs', () => {
  it('renames old to returning and income to revenue', async () => {
    const { api, calls } = adapter([
      [/loyalty_programs\/visits/, 'loyalty-visits'],
      [/loyalty_programs\/income/, 'loyalty-income'],
      [/loyalty_programs\/staff/, 'loyalty-staff'],
    ]);

    const results = await api.getLoyaltyProgramResults({
      ...period,
      loyalty_program_id: 42,
    });

    expect(results.clients.returning.all_count).toBe(96);
    expect(results.clients.total.returned_percent).toBe(60.8);
    expect(results.revenue.total.all_total).toBe(8400.75);
    expect(results.visits_by_day[0]).toEqual({
      date: '2026-08-01',
      new_count: 2,
      returning_count: 9,
    });
    expect(results.revenue_by_day[1]!.returning_total).toBe(302);
    expect(results.by_team_member[0]).toMatchObject({
      team_member_id: 9001,
      team_member_name: 'Team member A',
    });
    expect(calls.every((c) => c.path.includes('loyalty_program_id=42'))).toBe(
      true
    );
  });
});

describe('V1AnalyticsAdapter — forecast', () => {
  it('pairs the forecast with the actuals per bucket', async () => {
    const { api } = adapter([[/rfm\/overall/, 'forecast-overall']]);
    const forecast = await api.getForecast({ location_id: 4564 });

    expect(forecast.prediction_date).toBe('2026-08-31');
    expect(forecast.revenue).toEqual({ forecast: 13100, actual: 12480.5 });
    expect(forecast.visits).toEqual({ forecast: 268, actual: 241 });
    expect(forecast.granularity).toBe('month');
    expect(forecast.by_period).toEqual([
      {
        date: '2026-07-01',
        revenue_forecast: 11800,
        revenue_actual: 10900,
        visits_forecast: 250,
        visits_actual: 232,
      },
      {
        date: '2026-08-01',
        revenue_forecast: 13100,
        revenue_actual: 12480.5,
        visits_forecast: 268,
        visits_actual: 241,
      },
    ]);
    expect(forecast.is_empty).toBe(false);
  });

  it('reports an empty container as empty, not as an error', async () => {
    const { api } = adapter([[/rfm\/overall/, 'forecast-empty']]);
    const forecast = await api.getForecast({ location_id: 4564 });
    expect(forecast.is_empty).toBe(true);
    expect(forecast.by_period).toEqual([]);
  });

  it('turns a switched-off module into an actionable message', async () => {
    const { api } = adapter([[/rfm\/overall/, { status: 403 }]]);
    await expect(api.getForecast({ location_id: 4564 })).rejects.toBeInstanceOf(
      AnalyticsUnavailableError
    );
    await expect(api.getForecast({ location_id: 4564 })).rejects.toThrow(
      /not enabled for this location/
    );
  });
});

describe('V1AnalyticsAdapter — day-end report', () => {
  it('converts the period to dotted dates and renames every total', async () => {
    const { api, calls } = adapter([[/z_report/, 'z-report']]);
    const report = await api.getDayEndReport({
      ...period,
      team_member_id: 9001,
    });

    expect(calls[0]!.path).toContain('start_date=01.08.2026');
    expect(calls[0]!.path).toContain('end_date=03.08.2026');
    expect(report.currency).toBe('EUR');
    expect(report.totals.services_count).toBe(31);
    expect(report.totals.services_revenue).toBe(1180.5);
    expect(report.totals.products_revenue).toBe(168);
    expect(report.totals.gift_cards_count).toBe(1);
    expect(report.totals.memberships_revenue).toBe(190);
    expect(report.takings_by_account).toEqual([
      { title: 'Cash', amount: 740.5 },
      { title: 'Cards', amount: 612 },
    ]);
    expect(report.takings_total).toBe(1352.5);
    expect(report.write_offs_total).toBe(60.5);
    expect(report.details).toBeUndefined();
  });

  it('flattens the per-client detail without any personal data', async () => {
    const { api } = adapter([[/z_report/, 'z-report']]);
    const report = await api.getDayEndReport({
      ...period,
      include_details: true,
    });

    expect(report.details).toHaveLength(1);
    const row = report.details![0]!;
    expect(row).toMatchObject({
      date: '2026-08-01',
      client_id: 0,
      team_member_id: 9001,
    });
    expect(row.services[0]!.title).toBe('Haircut');
    expect(row.products[0]!.result_cost).toBe(12.75);
    expect(row.other[0]!.title).toBe('Other operations');
    expect(JSON.stringify(row)).not.toContain('phone');
    expect(JSON.stringify(row)).not.toContain('client_name');
  });

  it('explains a missing finance right instead of leaking the backend message', async () => {
    const { api } = adapter([
      [
        /z_report/,
        {
          status: 403,
          body: { meta: { message: 'No rights to view the statistics' } },
        },
      ],
    ]);
    await expect(api.getDayEndReport(period)).rejects.toBeInstanceOf(
      AnalyticsAccessError
    );
    await expect(api.getDayEndReport(period)).rejects.toThrow(
      /Analytics access right/
    );
  });
});

describe('V1AnalyticsAdapter — occupancy and client visits', () => {
  it('attributes occupancy rows to the requested team member', async () => {
    const { api, calls } = adapter([[/staff\/workload/, 'staff-workload']]);
    const occupancy = await api.getTeamMemberOccupancy({
      ...period,
      team_member_id: 9001,
    });

    expect(calls[0]!.path).toContain('start_date=2026-08-01');
    expect(calls[0]!.path).toContain('team_member_id=9001');
    expect(occupancy).toEqual({
      team_member_id: 9001,
      points: [
        ['2026-08-01', 61.5],
        ['2026-08-02', 72],
        ['2026-08-03', 0],
      ],
    });
  });

  it('reads the v2 client visit statistics through the normalized path', async () => {
    const { api, calls } = adapter([
      [/attendances_statistic/, 'client-attendances'],
    ]);
    const stats = await api.getClientVisitStats({
      location_id: 4564,
      client_id: 777,
    });

    expect(
      new URL(`https://api.alteg.io/api/v1${calls[0]!.path}`).pathname
    ).toBe('/api/v2/locations/4564/clients/777/attendances_statistic');
    expect(stats).toEqual({
      client_id: 777,
      successful_visits_count: 14,
      failed_visits_count: 2,
      spent_total: 842.5,
      paid_total: 817.5,
      client_account_balance: 25,
      last_visit_at: '2026-08-02T11:30:00+02:00',
    });
  });
});

describe('V1AnalyticsAdapter — report builder', () => {
  it('renames the field registry to canonical keys and drops unknown datasets', async () => {
    const { api } = adapter([
      [/analytics_constructor\/columns/, 'constructor-columns'],
    ]);
    const fields = await api.listReportFields({ location_id: 4564 });

    const keys = fields.map((field) => field.field_key);
    expect(keys).toContain('revenue_total');
    expect(keys).toContain('team_member_name');
    expect(keys).toContain('occupancy_percent');
    expect(keys).toContain('income_total');
    expect(keys).toContain('memberships_and_gift_cards_sold_count');
    expect(keys).toContain('revenue_total_avg');
    // The unknown dataset row is skipped rather than guessed at.
    expect(keys).not.toContain('whatever');

    const occupancy = fields.find((f) => f.field_key === 'occupancy_percent')!;
    expect(occupancy).toMatchObject({
      dataset: 'team_member_schedules',
      kind: 'metric',
      data_type: 'number',
      aggregation: 'percent',
      is_curated: true,
    });
    expect(occupancy.title).toBe('Occupancy, %');

    const dimension = fields.find((f) => f.field_key === 'team_member_name')!;
    expect(dimension.kind).toBe('dimension');
    expect(dimension.title).toBe('Team member');

    const granularity = fields.find((f) => f.kind === 'granularity')!;
    expect(granularity.field_key).toBe('date_month');
  });

  it('gives templates their canonical names and datasets', async () => {
    const { api } = adapter([
      [
        /analytics_constructor\/report_templates/,
        'constructor-report-templates',
      ],
    ]);
    const templates = await api.listReportTemplates({ location_id: 4564 });

    expect(templates[0]).toMatchObject({
      template_id: 't-master-sales',
      name: 'Revenue by team member',
      kind: 'static',
      dataset: 'sales',
    });
    expect(templates[0]!.answers).toContain('revenue');
    expect(templates[1]!.name).toBe('Occupancy');
    expect(templates[1]!.dataset).toBe('team_member_schedules');
    expect(templates[2]).toMatchObject({
      name: 'P&L (profit and loss)',
      kind: 'dynamic',
      dataset: 'financial_transactions',
    });
  });

  it('reads the template definition when asked for it', async () => {
    const { api, calls } = adapter([
      [
        /analytics_constructor\/report_templates/,
        'constructor-report-templates',
      ],
    ]);
    const templates = await api.listReportTemplates({
      location_id: 4564,
      with_definition: true,
    });

    expect(calls[0]!.path).toContain('include[]=report_template_columns');
    expect(templates[0]!.columns).toEqual([
      { column_id: 'c-sales-revenue', title: null },
      { column_id: 'c-sales-visits', title: null },
    ]);
    expect(templates[1]!.filters).toEqual([
      {
        column_id: 'c-sched-date',
        operator: 'BETWEEN',
        value: '2026-01-01,2026-12-31',
      },
    ]);
    expect(templates[0]!.groupings).toEqual(['c-sales-master']);
  });

  it('lists saved reports with their filter ids', async () => {
    const { api } = adapter([
      [/analytics_constructor\/reports$/, 'constructor-reports'],
    ]);
    const reports = await api.listSavedReports({ location_id: 4564 });

    expect(reports).toHaveLength(2);
    expect(reports[0]!.name).toBe('[Altegio Assistant] Revenue by team member');
    expect(reports[0]!.filters).toEqual([
      { filter_id: 'rf-1', column_id: 'c-sales-date', operator: 'BETWEEN' },
    ]);
  });

  it('sends a create body in the shape the builder validates', async () => {
    const { api, calls } = adapter([
      [/analytics_constructor\/reports/, 'constructor-report'],
    ]);
    await api.createReport({
      location_id: 4564,
      definition: {
        name: '[Altegio Assistant] Revenue by team member',
        kind: 'static',
        columns: [{ column_id: 'c-sales-revenue', title: 'Revenue' }],
        filters: [
          {
            column_id: 'c-sales-date',
            operator: 'BETWEEN',
            value: '2026-08-01,2026-08-03',
          },
        ],
        groupings: ['c-sales-master'],
      },
    });

    const body = JSON.parse(calls[0]!.body!);
    expect(calls[0]!.method).toBe('POST');
    expect(body).toMatchObject({
      name: '[Altegio Assistant] Revenue by team member',
      type: 'static',
      report_columns: [{ column_id: 'c-sales-revenue', title: 'Revenue' }],
      report_groupings: [{ column_id: 'c-sales-master' }],
    });
    expect(body.report_filters).toHaveLength(1);
  });

  it('refuses a definition with no field or no grouping', async () => {
    const { api } = adapter([
      [/analytics_constructor\/reports/, 'constructor-report'],
    ]);
    await expect(
      api.createReport({
        location_id: 4564,
        definition: {
          name: 'x',
          kind: 'static',
          columns: [],
          filters: [],
          groupings: ['c-sales-master'],
        },
      })
    ).rejects.toBeInstanceOf(AnalyticsInputError);
  });

  it('flattens the pivot response into a table with totals', async () => {
    const { api, calls } = adapter([
      [/reports\/.+\/data/, 'constructor-report-data'],
    ]);
    const table = await api.runReport({
      location_id: 4564,
      report_id: 'r-owned',
      filters: [
        {
          filter_id: 'rf-1',
          operator: 'BETWEEN',
          value: { from: '2026-08-01', to: '2026-08-31' },
        },
      ],
    });

    expect(JSON.parse(calls[0]!.body!)).toEqual({
      filters: [
        {
          id: 'rf-1',
          operator: 'BETWEEN',
          value: { from: '2026-08-01', to: '2026-08-31' },
        },
      ],
    });
    expect(table.columns.map((c) => c.key)).toEqual(['g_1', 'c_1', 'c_2']);
    expect(table.row_count).toBe(3);
    expect(table.rows[0]).toEqual({
      g_1: 'Team member A',
      c_1: 6120.5,
      c_2: 128,
    });
    expect(table.totals).toEqual({ c_1: 12480.5, c_2: 265 });
    expect(table.column_ids).toEqual({
      g_1: 'c-sales-master',
      c_1: 'c-sales-revenue',
      c_2: 'c-sales-visits',
    });
  });

  it('reads the builder 404 as a missing access right, not a missing report', async () => {
    const { api } = adapter([
      [/analytics_constructor/, { status: 404, body: { success: false } }],
    ]);
    await expect(
      api.listSavedReports({ location_id: 4564 })
    ).rejects.toBeInstanceOf(AnalyticsUnavailableError);
    await expect(api.listSavedReports({ location_id: 4564 })).rejects.toThrow(
      /report builder is unavailable/
    );
  });
});

describe('V1AnalyticsAdapter — error mapping', () => {
  it('turns a 401 from the chart endpoints into a permission message', async () => {
    const { api } = adapter([[/income_daily/, { status: 401 }]]);
    await expect(api.getRevenueDaily(period)).rejects.toThrow(
      /Analytics access right/
    );
  });

  it('explains a 422 range rejection with the next action', async () => {
    const { api } = adapter([
      [
        /analytics\/overall/,
        {
          status: 422,
          body: {
            meta: {
              errors: { '[date_to]': ['The maximum interval is 365 days'] },
            },
          },
        },
      ],
    ]);
    await expect(api.getOverview(period)).rejects.toThrow(
      /Narrow the range and retry/
    );
  });

  it('asks for a retry on a rate limit', async () => {
    const { api } = adapter([[/analytics\/overall/, { status: 429 }]]);
    await expect(api.getOverview(period)).rejects.toThrow(/rate limited/);
  });
});
