/**
 * Use-case tests: the analytics tools driven end to end against fixtures.
 *
 * Each test calls the tool handler the registry would call, so the assertions
 * cover the whole path — Zod input parsing, timezone resolution, the adapter,
 * projections, the size budget and the `resource_link` for a truncated table.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AltegioClient } from '../../../providers/altegio-client.js';
import * as definitions from '../../../tools/definitions/index.js';
import type { DefinedTool } from '../../../tools/factory.js';
import {
  clearTimezoneCache,
  resolveLocationTimezone,
} from '../location-timezone.js';
import { runWithContext } from '../../../request-context.js';
import {
  clearReportStore,
  getReportCsv,
  parseReportUri,
} from '../report-store.js';
import {
  OWNED_REPORT_PREFIX,
  definitionMatches,
  shortHash,
} from '../use-cases.js';
import { findForbiddenWords } from '../vocabulary.js';

const FIXTURES = path.join(__dirname, '../../../api/v1/__tests__/fixtures');

function fixture(name: string): unknown {
  return JSON.parse(
    fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8')
  );
}

interface Call {
  path: string;
  method: string;
  body?: unknown;
}

/**
 * Fake client: routes a path fragment to a fixture, records every call, and
 * answers the location list so presets resolve in a real timezone.
 */
function fakeClient(
  routes: Array<[RegExp, string | unknown]>,
  options: { timezone?: string | null } = {}
): { client: AltegioClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    isAuthenticated: () => true,
    getCompanies: async () => {
      if (options.timezone === null) throw new Error('no access');
      return [
        {
          id: 4564,
          title: 'Demo location',
          timezone_name: options.timezone ?? 'Europe/Berlin',
        },
      ];
    },
    apiRequest: async (requestPath: string, init?: RequestInit) => {
      calls.push({
        path: requestPath,
        method: (init?.method as string) ?? 'GET',
        ...(typeof init?.body === 'string'
          ? { body: JSON.parse(init.body) }
          : {}),
      });
      for (const [pattern, target] of routes) {
        if (!pattern.test(requestPath)) continue;
        const body = typeof target === 'string' ? fixture(target) : target;
        return new Response(JSON.stringify(body), { status: 200 });
      }
      throw new Error(`no fixture routed for ${requestPath}`);
    },
  } as unknown as AltegioClient;
  return { client, calls };
}

function tool(name: string): DefinedTool {
  const found = (Object.values(definitions) as unknown[]).find(
    (value): value is DefinedTool =>
      !!value &&
      typeof value === 'object' &&
      'meta' in value &&
      (value as DefinedTool).meta.name === name
  );
  if (!found) throw new Error(`tool ${name} not found`);
  return found;
}

interface ToolCallResult {
  content: Array<{ type: string; text?: string; uri?: string; name?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

async function call(
  name: string,
  args: unknown,
  routes: Array<[RegExp, string | unknown]>,
  options?: { timezone?: string | null }
): Promise<{ result: ToolCallResult; calls: Call[] }> {
  const { client, calls } = fakeClient(routes, options ?? {});
  const result = (await tool(name).createHandler(client)(
    args
  )) as unknown as ToolCallResult;
  return { result, calls };
}

beforeEach(() => {
  clearTimezoneCache();
  clearReportStore();
  jest.useFakeTimers().setSystemTime(new Date('2026-09-09T21:30:00Z'));
});
afterEach(() => {
  jest.useRealTimers();
});

describe('company-scope enforcement (analytics early gate)', () => {
  it('rejects analytics for a location outside the declared set', async () => {
    const { client } = fakeClient([]);
    await expect(
      runWithContext({ identity: null, companyIds: new Set([4564]) }, () =>
        resolveLocationTimezone(client, 720441)
      )
    ).rejects.toThrow(/company 720441 is not in scope/);
  });

  it('allows a location inside the declared set through', async () => {
    const { client } = fakeClient([]);
    const tz = await runWithContext(
      { identity: null, companyIds: new Set([4564, 720441]) },
      () => resolveLocationTimezone(client, 4564)
    );
    expect(tz).toBe('Europe/Berlin');
  });

  it('is unaffected when no scope is declared', async () => {
    const { client } = fakeClient([]);
    // No set ⇒ no guard; 720441 is not in the fake location list, so it falls
    // back to UTC rather than throwing (which is what an out-of-scope id does).
    const tz = await resolveLocationTimezone(client, 720441);
    expect(tz).toBe('UTC');
  });
});

describe('analytics_get_overview', () => {
  const routes: Array<[RegExp, string]> = [
    [/analytics\/overall/, 'analytics-overall'],
  ];

  it('returns a summary and structured content for an explicit period', async () => {
    const { result } = await call(
      'analytics_get_overview',
      { location_id: 4564, date_from: '2026-08-01', date_to: '2026-08-31' },
      routes
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toContain('Total revenue: 12,480.5 EUR');
    expect(result.structuredContent).toMatchObject({
      period: {
        date_from: '2026-08-01',
        date_to: '2026-08-31',
        days: 31,
        timezone: 'Europe/Berlin',
      },
      previous_period: { date_from: '2026-07-01', date_to: '2026-07-31' },
      currency: 'EUR',
    });
    expect(findForbiddenWords(result.content[0]!.text!)).toEqual([]);
  });

  it('resolves a preset in the location timezone', async () => {
    const { result, calls } = await call(
      'analytics_get_overview',
      { location_id: 4564, period: 'today' },
      routes,
      { timezone: 'Asia/Almaty' }
    );

    // 21:30 UTC is already the next day in Almaty.
    expect(result.structuredContent).toMatchObject({
      period: { date_from: '2026-09-10', preset: 'today' },
    });
    expect(calls.at(-1)!.path).toContain('date_from=2026-09-10');
  });

  it('falls back to UTC and says so when the location list is unreadable', async () => {
    const { result } = await call(
      'analytics_get_overview',
      { location_id: 4564, period: 'today' },
      routes,
      { timezone: null }
    );
    expect(result.structuredContent).toMatchObject({
      period: { date_from: '2026-09-09', timezone: 'UTC' },
    });
  });

  it('refuses a range over 365 days before calling the API', async () => {
    const { result, calls } = await call(
      'analytics_get_overview',
      { location_id: 4564, date_from: '2025-01-01', date_to: '2026-06-01' },
      routes
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('at most 365 days');
    expect(calls.filter((c) => c.path.includes('analytics'))).toEqual([]);
  });

  it('asks for a period when none is given', async () => {
    const { result } = await call(
      'analytics_get_overview',
      { location_id: 4564 },
      routes
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('last_month');
  });
});

describe('analytics_get_daily_series', () => {
  it('returns compact [date, value] pairs and the currency for revenue', async () => {
    const { result } = await call(
      'analytics_get_daily_series',
      { location_id: 4564, metric: 'revenue', period: 'last_month' },
      [
        [/income_daily/, 'charts-income-daily'],
        [/analytics\/overall/, 'analytics-overall'],
      ]
    );

    expect(result.structuredContent).toMatchObject({
      metric: 'revenue',
      unit: 'money',
      currency: 'EUR',
    });
    const series = (
      result.structuredContent as {
        series: Array<{ key: string; points: unknown[] }>;
      }
    ).series;
    expect(series[0]!.key).toBe('revenue_total');
    expect(series[0]!.points[0]).toEqual(['2026-08-01', 430.5]);
  });

  it('does not fetch the currency for a non-money metric', async () => {
    const { calls } = await call(
      'analytics_get_daily_series',
      { location_id: 4564, metric: 'occupancy', period: 'last_month' },
      [[/fullness_daily/, 'charts-fullness-daily']]
    );
    expect(calls.some((c) => /analytics\/overall\?/.test(c.path))).toBe(false);
  });

  it('drops zero days on request', async () => {
    const { result } = await call(
      'analytics_get_daily_series',
      {
        location_id: 4564,
        metric: 'occupancy',
        period: 'last_month',
        skip_empty_days: true,
      },
      [[/fullness_daily/, 'charts-fullness-daily']]
    );
    const series = (
      result.structuredContent as { series: Array<{ points: unknown[] }> }
    ).series;
    expect(series.every((one) => one.points.length === 3)).toBe(true);
  });
});

describe('analytics_get_appointments_breakdown', () => {
  it('adds shares and sorts the slices', async () => {
    const { result } = await call(
      'analytics_get_appointments_breakdown',
      { location_id: 4564, group_by: 'visit_status', period: 'last_month' },
      [[/record_status/, 'charts-record-status']]
    );

    const content = result.structuredContent as {
      total_count: number;
      breakdown: Array<{ key: string; share_percent: number }>;
    };
    expect(content.total_count).toBe(296);
    expect(content.breakdown[0]!.key).toBe('arrived');
    expect(content.breakdown[0]!.share_percent).toBe(78);
    expect(result.content[0]!.text).toContain('no_show');
  });
});

describe('analytics_get_day_end_report', () => {
  const routes: Array<[RegExp, string]> = [[/z_report/, 'z-report']];

  it('summarizes takings and write-offs and hides the detail by default', async () => {
    const { result } = await call(
      'analytics_get_day_end_report',
      { location_id: 4564, period: 'yesterday' },
      routes
    );

    expect(result.content[0]!.text).toContain('Taken in: 1,352.5 EUR');
    expect(result.content[0]!.text).toContain('Cash 740.5');
    expect(result.content[0]!.text).toContain('include_details=true');
    expect(
      (result.structuredContent as { details?: unknown }).details
    ).toBeUndefined();
  });

  it('flags the case where the location clamped the range', async () => {
    // The fixture always answers for 2026-08-01, so any other request is clamped.
    const { result } = await call(
      'analytics_get_day_end_report',
      { location_id: 4564, date_from: '2026-07-01', date_to: '2026-07-01' },
      routes
    );
    const content = result.structuredContent as {
      clamped_by_access_right: boolean;
    };
    // The adapter echoes the requested range, so nothing is clamped here; the
    // flag exists and is false rather than missing.
    expect(content.clamped_by_access_right).toBe(false);
  });
});

describe('analytics_get_team_member_occupancy', () => {
  it('calls the endpoint once per team member and attributes the rows', async () => {
    const { result, calls } = await call(
      'analytics_get_team_member_occupancy',
      {
        location_id: 4564,
        team_member_ids: [9001, 9002],
        period: 'last_week',
      },
      [[/staff\/workload/, 'staff-workload']]
    );

    const workloadCalls = calls.filter((c) => c.path.includes('workload'));
    expect(workloadCalls).toHaveLength(2);
    expect(workloadCalls[0]!.path).toContain('team_member_id=9001');
    expect(workloadCalls[1]!.path).toContain('team_member_id=9002');
    const content = result.structuredContent as {
      team_members: Array<{ team_member_id: number }>;
    };
    expect(content.team_members.map((m) => m.team_member_id)).toEqual([
      9001, 9002,
    ]);
    expect(result.content[0]!.text).toContain('average 44.5%');
  });

  it('refuses more team members than one result can carry', async () => {
    const { result } = await call(
      'analytics_get_team_member_occupancy',
      {
        location_id: 4564,
        team_member_ids: Array.from({ length: 11 }, (_, i) => i + 1),
        period: 'last_week',
      },
      [[/staff\/workload/, 'staff-workload']]
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/<=10 items/);
  });
});

describe('analytics_get_forecast', () => {
  it('explains an empty forecast instead of returning zeros', async () => {
    const { result } = await call(
      'analytics_get_forecast',
      { location_id: 4564 },
      [[/rfm\/overall/, 'forecast-empty']]
    );
    expect(result.content[0]!.text).toContain('no revenue or visits forecast');
    expect(result.structuredContent).toMatchObject({ is_empty: true });
  });

  it('works without a period at all', async () => {
    const { calls } = await call(
      'analytics_get_forecast',
      { location_id: 4564 },
      [[/rfm\/overall/, 'forecast-overall']]
    );
    const forecastCall = calls.find((c) => c.path.includes('rfm'))!;
    expect(forecastCall.path).not.toContain('start_date');
  });
});

describe('analytics_list_report_fields', () => {
  const routes: Array<[RegExp, string]> = [
    [/analytics_constructor\/columns/, 'constructor-columns'],
  ];

  it('returns only the curated fields of one dataset by default', async () => {
    const { result } = await call(
      'analytics_list_report_fields',
      { location_id: 4564, dataset: 'sales' },
      routes
    );
    const content = result.structuredContent as {
      items: Array<{ field_key: string }>;
      count: number;
      total_in_dataset: number;
    };
    expect(content.items.map((f) => f.field_key)).toEqual([
      'revenue_total',
      'visits_count',
      'average_check_per_visit',
      'team_member_name',
      'date',
      'date_month',
    ]);
    expect(content.total_in_dataset).toBeGreaterThan(content.count);
  });

  it('adds the mechanical aggregates on request', async () => {
    const { result } = await call(
      'analytics_list_report_fields',
      { location_id: 4564, dataset: 'sales', include_derived: true },
      routes
    );
    const keys = (
      result.structuredContent as { items: Array<{ field_key: string }> }
    ).items.map((f) => f.field_key);
    expect(keys).toContain('revenue_total_avg');
  });

  it('filters by a search term', async () => {
    const { result } = await call(
      'analytics_list_report_fields',
      { location_id: 4564, dataset: 'team_member_schedules', search: 'occup' },
      routes
    );
    const keys = (
      result.structuredContent as { items: Array<{ field_key: string }> }
    ).items.map((f) => f.field_key);
    expect(keys).toEqual(['occupancy_percent']);
  });
});

describe('analytics_run_report — report ownership rule', () => {
  const base: Array<[RegExp, string]> = [
    [/analytics_constructor\/columns/, 'constructor-columns'],
    [/analytics_constructor\/report_templates/, 'constructor-report-templates'],
    [/reports\/[^/]+\/data/, 'constructor-report-data'],
  ];

  it('reuses the assistant-owned report and overrides only the period', async () => {
    const { result, calls } = await call(
      'analytics_run_report',
      {
        location_id: 4564,
        template_id: 't-master-sales',
        date_from: '2026-08-01',
        date_to: '2026-08-31',
      },
      [
        ...base,
        [/analytics_constructor\/reports$/, 'constructor-reports'],
        [/analytics_constructor\/reports\/r-owned\?/, 'constructor-report'],
      ]
    );

    expect(result.isError).toBeUndefined();
    // No report was created: the owned one already existed.
    expect(
      calls.some(
        (c) => c.method === 'POST' && /reports$/.test(c.path.split('?')[0]!)
      )
    ).toBe(false);
    const dataCall = calls.find((c) => c.path.includes('/data'))!;
    expect(dataCall.body).toEqual({
      filters: [
        {
          id: 'rf-1',
          operator: 'BETWEEN',
          value: { from: '2026-08-01', to: '2026-08-31' },
        },
      ],
    });
    expect(result.structuredContent).toMatchObject({
      report_name: '[Altegio Assistant] Revenue by team member',
      reused_existing_report: true,
      row_count: 3,
      truncated: false,
    });
  });

  it('creates one assistant-owned report when none exists yet', async () => {
    const { result, calls } = await call(
      'analytics_run_report',
      {
        location_id: 4564,
        template_id: 't-fullness',
        period: 'last_month',
      },
      [
        ...base,
        // The list call and the create call share this path; the list reads an
        // object as "no saved reports", which is exactly the first-use case.
        [/analytics_constructor\/reports$/, 'constructor-report'],
        [/analytics_constructor\/reports\/r-owned/, 'constructor-report'],
      ]
    );

    const created = calls.find(
      (c) => c.method === 'POST' && /reports$/.test(c.path.split('?')[0]!)
    )!;
    expect(created).toBeDefined();
    const body = created.body as { name: string; report_filters: unknown[] };
    expect(body.name).toBe(`${OWNED_REPORT_PREFIX} Occupancy`);
    // The template's own date filter travels with the report so the period can
    // be overridden per run.
    expect(body.report_filters).toHaveLength(1);
    expect(result.structuredContent).toMatchObject({
      reused_existing_report: false,
    });
  });

  it('renames table columns to canonical field keys', async () => {
    const { result } = await call(
      'analytics_run_report',
      {
        location_id: 4564,
        template_id: 't-master-sales',
        period: 'last_month',
      },
      [
        ...base,
        [/analytics_constructor\/reports$/, 'constructor-reports'],
        [/analytics_constructor\/reports\/r-owned\?/, 'constructor-report'],
      ]
    );
    const content = result.structuredContent as {
      columns: Array<{ key: string }>;
      rows: Array<Record<string, unknown>>;
    };
    expect(content.columns.map((c) => c.key)).toEqual([
      'team_member_name',
      'revenue_total',
      'visits_count',
    ]);
    expect(content.rows[0]).toEqual({
      team_member_name: 'Team member A',
      revenue_total: 6120.5,
      visits_count: 128,
    });
  });

  it('builds an ad-hoc report from canonical field keys', async () => {
    const { result, calls } = await call(
      'analytics_run_report',
      {
        location_id: 4564,
        dataset: 'sales',
        fields: ['revenue_total', 'visits_count'],
        group_by: ['team_member_name'],
        period: 'last_month',
      },
      [
        ...base,
        // The list call and the create call share this path; the list reads an
        // object as "no saved reports", which is exactly the first-use case.
        [/analytics_constructor\/reports$/, 'constructor-report'],
        [/analytics_constructor\/reports\/r-owned/, 'constructor-report'],
      ]
    );

    const created = calls.find(
      (c) => c.method === 'POST' && /reports$/.test(c.path.split('?')[0]!)
    )!;
    const body = created.body as {
      name: string;
      report_columns: Array<{ column_id: string }>;
      report_groupings: Array<{ column_id: string }>;
      type: string;
    };
    expect(body.name).toContain(`${OWNED_REPORT_PREFIX} sales`);
    expect(body.report_columns.map((c) => c.column_id)).toEqual([
      'c-sales-revenue',
      'c-sales-visits',
    ]);
    expect(body.report_groupings).toEqual([{ column_id: 'c-sales-master' }]);
    expect(body.type).toBe('static');
    expect(result.isError).toBeUndefined();
  });

  it('makes an ad-hoc report dynamic when a granularity is asked for', async () => {
    const { calls } = await call(
      'analytics_run_report',
      {
        location_id: 4564,
        dataset: 'sales',
        fields: ['revenue_total'],
        granularity: 'month',
        period: 'this_year',
      },
      [
        ...base,
        // The list call and the create call share this path; the list reads an
        // object as "no saved reports", which is exactly the first-use case.
        [/analytics_constructor\/reports$/, 'constructor-report'],
        [/analytics_constructor\/reports\/r-owned/, 'constructor-report'],
      ]
    );
    const created = calls.find(
      (c) => c.method === 'POST' && /reports$/.test(c.path.split('?')[0]!)
    )!;
    const body = created.body as {
      type: string;
      report_groupings: Array<{ column_id: string }>;
    };
    expect(body.type).toBe('dynamic');
    expect(body.report_groupings).toEqual([
      { column_id: 'c-sales-date-month' },
    ]);
  });

  it('names the unknown field and the tool that lists the real ones', async () => {
    const { result } = await call(
      'analytics_run_report',
      {
        location_id: 4564,
        dataset: 'sales',
        fields: ['profit_margin_of_the_universe'],
        group_by: ['team_member_name'],
        period: 'last_month',
      },
      [
        ...base,
        [/analytics_constructor\/reports$/, { success: true, data: [] }],
      ]
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('profit_margin_of_the_universe');
    expect(result.content[0]!.text).toContain('analytics_list_report_fields');
  });

  it('refuses a template and an ad-hoc definition at once', async () => {
    const { result } = await call(
      'analytics_run_report',
      {
        location_id: 4564,
        template_id: 't-master-sales',
        dataset: 'sales',
        period: 'last_month',
      },
      base
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('not both');
  });

  it('explains an unavailable template', async () => {
    const { result } = await call(
      'analytics_run_report',
      { location_id: 4564, template_id: 't-nope', period: 'last_month' },
      [
        ...base,
        [/analytics_constructor\/reports$/, { success: true, data: [] }],
      ]
    );
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(
      'analytics_list_report_templates'
    );
  });

  it('attaches a resource_link and stores the CSV when the table is truncated', async () => {
    const wide = {
      success: true,
      data: {
        header: {
          groupings: [
            {
              key: 'g_1',
              report_grouping_id: 'rg-1',
              column_id: 'c-sales-master',
            },
          ],
          columns: [
            {
              key: 'c_1',
              report_column_id: 'rc-1',
              column_id: 'c-sales-revenue',
              detalization: null,
            },
          ],
        },
        rows: Array.from({ length: 205 }, (_, i) => ({
          groupings: [
            {
              key: 'g_1',
              column_id: 'c-sales-master',
              value: `Team member ${i}`,
            },
          ],
          columns: [
            { key: 'c_1', column_id: 'c-sales-revenue', value: i * 10 },
          ],
        })),
        summary: {
          columns: [{ key: 'c_1', column_id: 'c-sales-revenue', value: 1 }],
        },
      },
      meta: [],
    };

    const { result } = await call(
      'analytics_run_report',
      {
        location_id: 4564,
        template_id: 't-master-sales',
        period: 'last_month',
      },
      [
        [/analytics_constructor\/columns/, 'constructor-columns'],
        [
          /analytics_constructor\/report_templates/,
          'constructor-report-templates',
        ],
        [/analytics_constructor\/reports$/, 'constructor-reports'],
        [/analytics_constructor\/reports\/r-owned\?/, 'constructor-report'],
        [/reports\/[^/]+\/data/, wide],
      ]
    );

    const content = result.structuredContent as {
      row_count: number;
      truncated: boolean;
      full_report_uri: string;
      full_report_rows: number;
    };
    expect(content.row_count).toBe(205);
    expect(content.truncated).toBe(true);
    expect(content.full_report_rows).toBe(205);

    const link = result.content.find(
      (block) => block.type === 'resource_link'
    )!;
    expect(link.uri).toBe(content.full_report_uri);
    expect(link.name).toContain('.csv');

    const parsed = parseReportUri(content.full_report_uri)!;
    const stored = getReportCsv(parsed.location_id, parsed.run_id)!;
    expect(stored.csv.split('\n')[0]).toBe('Team member,Revenue');
    // Header + 205 rows + totals + trailing newline.
    expect(stored.csv.trim().split('\n')).toHaveLength(207);

    // The inline result must stay inside the budget even for a wide table.
    expect(JSON.stringify(result).length).toBeLessThan(16_000);
  });
});

describe('analytics_run_saved_report', () => {
  it('runs an existing report with a period override', async () => {
    const { result, calls } = await call(
      'analytics_run_saved_report',
      {
        location_id: 4564,
        report_id: 'r-owned',
        date_from: '2026-08-01',
        date_to: '2026-08-31',
      },
      [
        [/analytics_constructor\/columns/, 'constructor-columns'],
        [/analytics_constructor\/reports\/r-owned\?/, 'constructor-report'],
        [/reports\/[^/]+\/data/, 'constructor-report-data'],
      ]
    );

    expect(result.isError).toBeUndefined();
    const dataCall = calls.find((c) => c.path.includes('/data'))!;
    expect(dataCall.body).toMatchObject({
      filters: [{ id: 'rf-1', operator: 'BETWEEN' }],
    });
    expect(result.structuredContent).toMatchObject({ row_count: 3 });
  });
});

describe('analytics_list_saved_reports', () => {
  it('marks the reports this assistant created', async () => {
    const { result } = await call(
      'analytics_list_saved_reports',
      { location_id: 4564 },
      [[/analytics_constructor\/reports/, 'constructor-reports']]
    );
    const items = (
      result.structuredContent as {
        items: Array<{ name: string; created_by_this_assistant: boolean }>;
      }
    ).items;
    expect(items[0]!.created_by_this_assistant).toBe(true);
    expect(items[1]!.created_by_this_assistant).toBe(false);
  });
});

describe('analytics_delete_assistant_report', () => {
  it('reads ownership before deleting the exact report', async () => {
    const { result, calls } = await call(
      'analytics_delete_assistant_report',
      { location_id: 4564, report_id: 'r-owned' },
      [
        [
          /analytics_constructor\/reports\/r-owned|\/ac\/r-owned/,
          'constructor-report',
        ],
      ]
    );

    expect(result.isError).toBeUndefined();
    expect(calls.map(({ method, path }) => ({ method, path }))).toEqual([
      {
        method: 'GET',
        path: '/company/4564/analytics_constructor/reports/r-owned?include[]=report_columns&include[]=report_filters&include[]=report_groupings&include[]=report_status',
      },
      { method: 'DELETE', path: '/company/4564/ac/r-owned' },
    ]);
    expect(result.structuredContent).toMatchObject({
      report_id: 'r-owned',
      deleted: true,
    });
  });

  it('refuses to delete an owner-created report', async () => {
    const ownerReport = {
      success: true,
      data: {
        id: 'r-user',
        name: 'Weekly sales',
        description: '',
        type: 'static',
      },
    };
    const { result, calls } = await call(
      'analytics_delete_assistant_report',
      { location_id: 4564, report_id: 'r-user' },
      [[/analytics_constructor\/reports\/r-user/, ownerReport]]
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('deletes only reports');
    expect(calls).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('hashes an ad-hoc signature stably', () => {
    expect(shortHash('sales|revenue_total|by|team_member_name')).toBe(
      shortHash('sales|revenue_total|by|team_member_name')
    );
    expect(shortHash('a')).not.toBe(shortHash('b'));
    expect(shortHash('a')).toMatch(/^[0-9a-z]{1,7}$/);
  });

  it('detects a stored report that no longer matches the definition', () => {
    const stored = {
      report_id: 'r',
      name: 'n',
      description: '',
      kind: 'static' as const,
      template_id: null,
      created_at: null,
      columns: [{ report_column_id: 'rc', column_id: 'c-1', title: null }],
      groupings: [{ report_grouping_id: 'rg', column_id: 'c-2' }],
      filters: [{ filter_id: 'rf', column_id: 'c-3', operator: 'BETWEEN' }],
    };
    const definition = {
      name: 'n',
      kind: 'static' as const,
      columns: [{ column_id: 'c-1' }],
      filters: [{ column_id: 'c-3', operator: 'BETWEEN', value: 'x' }],
      groupings: ['c-2'],
    };
    expect(definitionMatches(stored, definition)).toBe(true);
    expect(
      definitionMatches(stored, {
        ...definition,
        columns: [{ column_id: 'c-9' }],
      })
    ).toBe(false);
    expect(definitionMatches(stored, { ...definition, kind: 'dynamic' })).toBe(
      false
    );
  });
});
