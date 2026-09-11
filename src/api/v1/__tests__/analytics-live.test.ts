/**
 * Opt-in live suite: calls the real analytics endpoints against the demo
 * location and re-records the golden fixtures.
 *
 * Skipped unless `ALTEGIO_E2E=1`. It needs a partner token in
 * `ALTEGIO_PARTNER_TOKEN` (or `ALTEGIO_LIVE_API_TOKEN`) and the demo
 * credentials in `ALTEGIO_TEST_LOGIN` / `ALTEGIO_TEST_PASSWORD`, or an
 * existing technical-user token in `ALTEGIO_USER_TOKEN` — from the
 * environment, never from a file in this repository, which is public. The
 * partner token is read from its own variable because the shared Jest setup
 * pins `ALTEGIO_API_TOKEN` to a dummy value for every other suite.
 *
 *   ALTEGIO_E2E=1 CREDENTIALS_DIR=/tmp/altegio-mcp-live npx jest analytics-live
 *
 * It is read-only. The report-builder check reuses a ready assistant-owned
 * report left by the maintained demo fixture and never creates or updates one.
 *
 * Every recorded payload passes through `sanitize` first: personal fields
 * (names, phone numbers, e-mail addresses) are replaced with neutral
 * placeholders before anything is written to `./fixtures`.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AltegioClient } from '../../../providers/altegio-client.js';
import { httpFromClient } from '../../altegio-http.js';
import { V1AnalyticsAdapter } from '../analytics-adapter.js';
import {
  runReport,
  runSavedReport,
} from '../../../capabilities/analytics/use-cases.js';
import { callAnalytics } from '../analytics-http.js';
import { resolveLocationTimezone } from '../../../capabilities/analytics/location-timezone.js';

const LIVE = process.env.ALTEGIO_E2E === '1';
const DEMO_LOCATION_ID = 4564;
const FIXTURES = path.join(__dirname, 'fixtures', 'live');
const CREDENTIALS_DIR = process.env.CREDENTIALS_DIR ?? '/tmp/altegio-mcp-live';

/** A short, recent window so a recording stays small and stable. */
const PERIOD = { date_from: '2026-08-01', date_to: '2026-08-03' };

/** Field names that may carry personal data in any analytics payload. */
const PERSONAL_KEYS = [
  'client_name',
  'client_phone',
  'client_email',
  'master_name',
  'staff_name',
  'phone',
  'email',
];

/** Parent keys whose objects describe a person, so their `name` is personal. */
const PERSON_PARENT_KEYS = [
  'actor',
  'staff',
  'client',
  'user',
  'master',
  'masters',
];
/** Keys whose presence marks an object as a person record (not a template, currency or report). */
const PERSON_MARKER_KEYS = [
  'phone',
  'email',
  'login',
  'client_id',
  'master_id',
  'user_id',
  'specialization',
  'rating',
  'avatar',
];

function isPersonObject(
  value: Record<string, unknown>,
  parentKey: string | undefined
): boolean {
  if (parentKey && PERSON_PARENT_KEYS.includes(parentKey)) return true;
  return PERSON_MARKER_KEYS.some((key) => key in value);
}

/** Replace personal values in place, keeping the shape intact. */
export function sanitize(
  value: unknown,
  seen = new Map<string, string>(),
  parentKey?: string
): unknown {
  if (Array.isArray(value))
    return value.map((item) => sanitize(item, seen, parentKey));
  if (!value || typeof value !== 'object') return value;

  const object = value as Record<string, unknown>;
  const personal = isPersonObject(object, parentKey);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    if (PERSONAL_KEYS.includes(key) || (key === 'name' && personal)) {
      if (item === null || item === '' || typeof item === 'number') {
        out[key] = item;
      } else if (typeof item === 'string') {
        const known = seen.get(item);
        if (known) {
          out[key] = known;
        } else {
          const placeholder = /phone/.test(key)
            ? ''
            : /email/.test(key)
              ? ''
              : `Person ${seen.size + 1}`;
          seen.set(item, placeholder);
          out[key] = placeholder;
        }
      } else {
        out[key] = sanitize(item, seen, key);
      }
      continue;
    }
    out[key] = sanitize(item, seen, key);
  }
  return out;
}

function record(name: string, payload: unknown): void {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(
    path.join(FIXTURES, `${name}.json`),
    `${JSON.stringify(sanitize(payload), null, 2)}\n`
  );
}

/** Fields of the registry the adapter reads; the rest is noise in a golden. */
const REGISTRY_FIELDS = [
  'id',
  'table_name',
  'table_title',
  'column_name',
  'column_name_alias',
  'title',
  'data_type',
  'data_type_slug',
  'expression_slug',
  'metric_type_slug',
  'is_default',
  'is_groupable',
  'is_granularity',
  'is_filterable',
] as const;

const AGGREGATE_SUFFIXES = [
  '_count_distinct',
  '_count',
  '_sum',
  '_avg',
  '_min',
  '_max',
];

/**
 * Keep one row per distinct column stem plus a dozen mechanical aggregates.
 * The identifier space is {raw field} x {aggregate}, so the stems are what the
 * renaming rules have to cover.
 */
export function trimColumnRegistry(payload: unknown): unknown {
  const rows = ((payload as { data?: unknown[] })?.data ?? []) as Array<
    Record<string, unknown>
  >;
  const stemOf = (alias: string) => {
    for (const suffix of AGGREGATE_SUFFIXES) {
      if (alias.endsWith(suffix)) return alias.slice(0, -suffix.length);
    }
    return alias;
  };

  const seen = new Set<string>();
  const kept: Array<Record<string, unknown>> = [];
  let derived = 0;
  for (const row of rows) {
    const trimmed = Object.fromEntries(
      REGISTRY_FIELDS.map((key) => [key, row[key]])
    );
    const alias = String(row.column_name_alias ?? row.column_name ?? '');
    const stem = stemOf(alias);
    if (stem === alias) {
      if (seen.has(stem)) continue;
      seen.add(stem);
      kept.push(trimmed);
    } else if (derived < 12) {
      kept.push(trimmed);
      derived++;
    }
  }
  return {
    success: true,
    data: kept,
    meta: { count: kept.length, recorded_total: rows.length },
  };
}

const describeLive = LIVE ? describe : describe.skip;

describeLive('analytics endpoints against the demo location', () => {
  let client: AltegioClient;
  let timezone = 'UTC';

  beforeAll(async () => {
    const login = process.env.ALTEGIO_TEST_LOGIN;
    const password = process.env.ALTEGIO_TEST_PASSWORD;
    const userToken = process.env.ALTEGIO_USER_TOKEN;
    const partnerToken =
      process.env.ALTEGIO_PARTNER_TOKEN ?? process.env.ALTEGIO_LIVE_API_TOKEN;
    if (!partnerToken || (!userToken && (!login || !password))) {
      throw new Error(
        'The live suite needs ALTEGIO_PARTNER_TOKEN (or ALTEGIO_LIVE_API_TOKEN) and either ALTEGIO_USER_TOKEN or ALTEGIO_TEST_LOGIN plus ALTEGIO_TEST_PASSWORD.'
      );
    }
    client = new AltegioClient({ partnerToken, userToken }, CREDENTIALS_DIR);
    // The ERP rate-limits logins per IP and login (403 after a handful of
    // attempts), so reuse the token cached in CREDENTIALS_DIR between runs and
    // log in only when there is none.
    if (!client.isAuthenticated()) {
      const result = await client.login(login!, password!);
      expect(result.success).toBe(true);
    }
    timezone = await resolveLocationTimezone(client, DEMO_LOCATION_ID);
  }, 60_000);

  // No logout on purpose: it would clear the cached token and force a login on
  // every run, which is what trips the rate limit.
  afterAll(() => undefined);

  /** Raw call plus a recording, so the fixture is what the API really sent. */
  async function capture(
    fixtureName: string,
    endpoint: string,
    kind: Parameters<typeof callAnalytics>[2]['kind']
  ): Promise<unknown> {
    const payload = await callAnalytics(httpFromClient(client), endpoint, {
      kind,
      context: `record ${fixtureName}`,
    });
    record(fixtureName, payload);
    return payload;
  }

  const query = `?date_from=${PERIOD.date_from}&date_to=${PERIOD.date_to}`;
  const base = `/company/${DEMO_LOCATION_ID}`;

  it('records the key metrics and every chart', async () => {
    await capture(
      'analytics-overall',
      `${base}/analytics/overall${query}`,
      'metrics'
    );
    for (const [fixtureName, chart] of [
      ['charts-income-daily', 'income_daily'],
      ['charts-records-daily', 'records_daily'],
      ['charts-fullness-daily', 'fullness_daily'],
      ['charts-clients-daily', 'clients_daily'],
      ['charts-record-source', 'record_source'],
      ['charts-record-status', 'record_status'],
    ] as const) {
      await capture(
        fixtureName,
        `${base}/analytics/overall/charts/${chart}${query}`,
        'charts'
      );
    }
  }, 120_000);

  it('records the receptionist performance endpoints', async () => {
    for (const [fixtureName, endpoint, include] of [
      [
        'receptionist-clients-scheduled',
        'clients_scheduled',
        'clients_count_daily',
      ],
      ['receptionist-records-closed', 'records_closed', 'records_count_daily'],
      ['receptionist-income', 'income', 'income_sum_daily'],
      [
        'receptionist-visited-rescheduled',
        'visited_clients_rescheduled',
        'clients_count_daily',
      ],
      [
        'receptionist-canceled-rescheduled',
        'canceled_clients_rescheduled',
        'clients_count_daily',
      ],
    ] as const) {
      await capture(
        fixtureName,
        `${base}/analytics/administrator/${endpoint}${query}&include[]=${include}`,
        'receptionist'
      );
    }
  }, 120_000);

  it('records the forecast, occupancy and day-end report', async () => {
    // The forecast module may be off for the demo location; that is a valid
    // recording too, so the failure is reported rather than thrown away.
    try {
      await capture(
        'forecast-overall',
        `${base}/analytics/rfm/overall`,
        'forecast'
      );
    } catch (error) {
      console.warn(`forecast not recorded: ${(error as Error).message}`);
    }

    await capture(
      'staff-workload',
      `${base}/staff/workload?start_date=${PERIOD.date_from}&end_date=${PERIOD.date_to}`,
      'occupancy'
    );

    await capture(
      'z-report',
      `/reports/z_report/${DEMO_LOCATION_ID}?start_date=01.08.2026&end_date=03.08.2026`,
      'day_end_report'
    );
  }, 120_000);

  it('records the report builder catalogues', async () => {
    // The field registry has 565 rows; only one row per distinct column stem
    // plus a sample of the mechanical aggregates is kept, which is what the
    // vocabulary guard in `live-registry.test.ts` needs and keeps the golden
    // file readable. The small hand-built wiring fixtures are left alone.
    const columns = await callAnalytics(
      httpFromClient(client),
      `${base}/analytics_constructor/columns`,
      { kind: 'report_builder', context: 'record the field registry' }
    );
    record('constructor-columns-live', trimColumnRegistry(columns));

    await capture(
      'report-templates-live',
      `${base}/analytics_constructor/report_templates?include[]=report_template_columns&include[]=report_template_filters&include[]=report_template_groupings`,
      'report_builder'
    );
    await capture(
      'constructor-reports',
      `${base}/analytics_constructor/reports`,
      'report_builder'
    );
  }, 120_000);

  it('reads the key metrics through the adapter and returns canonical fields', async () => {
    const api = new V1AnalyticsAdapter(httpFromClient(client), { timezone });
    const overview = await api.getOverview({
      location_id: DEMO_LOCATION_ID,
      ...PERIOD,
    });

    expect(overview.revenue.total.current).not.toBeUndefined();
    expect(overview.appointments.total_count).not.toBeUndefined();
    expect(Object.keys(overview)).toEqual([
      'currency',
      'revenue',
      'average_check',
      'average_services_check',
      'occupancy_percent',
      'appointments',
      'clients',
    ]);
  }, 60_000);

  it('runs a ready assistant-owned report without mutating the builder', async () => {
    const api = new V1AnalyticsAdapter(httpFromClient(client), { timezone });
    const saved = await api.listSavedReports({
      location_id: DEMO_LOCATION_ID,
    });
    const owned = saved.filter((report) =>
      report.name.startsWith('[Altegio Assistant]')
    );
    const detailed = await Promise.all(
      owned.map((report) =>
        api.getSavedReport({
          location_id: DEMO_LOCATION_ID,
          report_id: report.report_id,
        })
      )
    );
    const ready = detailed.find((report) => report.status === 'success');
    expect(ready).toBeDefined();
    const full = await api.getSavedReport({
      location_id: DEMO_LOCATION_ID,
      report_id: ready!.report_id,
    });
    const storedPeriod = (full.filters ?? [])
      .map((filter) => filter.value)
      .find((value) =>
        typeof value === 'string'
          ? /^\d{4}-\d{2}-\d{2},\d{4}-\d{2}-\d{2}$/.test(value)
          : false
      );
    expect(storedPeriod).toBeDefined();
    const [dateFrom, dateTo] = storedPeriod!.split(',');
    const result = await runSavedReport(client, {
      location_id: DEMO_LOCATION_ID,
      report_id: full.report_id,
      date_from: dateFrom!,
      date_to: dateTo!,
    });
    const table = result.structuredContent as {
      row_count: number;
      columns: unknown[];
    };
    expect(table.row_count).toBeGreaterThan(0);
    expect(table.columns).not.toHaveLength(0);
  }, 120_000);

  it('runs a template through the complete use case', async () => {
    const api = new V1AnalyticsAdapter(httpFromClient(client), { timezone });
    const templates = await api.listReportTemplates({
      location_id: DEMO_LOCATION_ID,
    });
    const template = templates.find(
      (candidate) => candidate.name === 'Revenue by team member'
    );
    expect(template).toBeDefined();

    const result = await runReport(client, {
      location_id: DEMO_LOCATION_ID,
      template_id: template!.template_id,
      ...PERIOD,
    });
    const table = result.structuredContent as {
      row_count: number;
      columns: unknown[];
      reused_existing_report: boolean;
    };
    expect(table.row_count).toBeGreaterThan(0);
    expect(table.columns).not.toHaveLength(0);
    expect(table.reused_existing_report).toBe(true);
  }, 120_000);
});

describe('sanitize', () => {
  it('replaces names consistently and blanks contact details', () => {
    const cleaned = sanitize({
      z_data: {
        '1785542400': [
          {
            client_id: 12,
            client_name: 'Real Person',
            client_phone: '+3512345678',
            client_email: 'real@example.test',
            masters: [{ master_id: 9, master_name: 'Real Person' }],
          },
        ],
      },
    }) as {
      z_data: Record<
        string,
        Array<{
          client_id: number;
          client_name: string;
          client_phone: string;
          client_email: string;
          masters: Array<{ master_id: number; master_name: string }>;
        }>
      >;
    };

    const row = cleaned.z_data['1785542400']![0]!;
    expect(row.client_id).toBe(12);
    expect(row.client_name).toBe('Person 1');
    expect(row.client_phone).toBe('');
    expect(row.client_email).toBe('');
    // The same person keeps the same placeholder across the payload.
    expect(row.masters[0]!.master_name).toBe('Person 1');
  });

  it('keeps numbers, nulls and unrelated fields untouched', () => {
    expect(
      sanitize({ amount: 12.5, name: null, title: 'Cash', nested: [1, 2] })
    ).toEqual({ amount: 12.5, name: null, title: 'Cash', nested: [1, 2] });
  });
});
