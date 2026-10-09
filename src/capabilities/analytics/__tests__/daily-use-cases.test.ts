import fs from 'node:fs';
import path from 'node:path';
import Ajv from 'ajv';
import type { AltegioClient } from '../../../providers/altegio-client.js';
import {
  V1DailyAnalyticsAdapter,
  bookedShare,
} from '../../../api/v1/daily-analytics-adapter.js';
import type { AltegioHttp } from '../../../api/altegio-http.js';
import {
  analyticsGetDailySummaryTool,
  analyticsGetTeamWorkloadTool,
} from '../../../tools/definitions/daily-analytics.tools.js';
import { getAppointmentsTool } from '../../../tools/definitions/bookings.tools.js';
import { clearTimezoneCache } from '../location-timezone.js';
import { runWithContext } from '../../../request-context.js';
import { mapAnalyticsHttpError } from '../errors.js';
import { AuthenticationError } from '../../../utils/errors.js';

const period = {
  location_id: 4564,
  date_from: '2026-10-01',
  date_to: '2026-10-09',
};
function fixture(name: string): unknown {
  return JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        '../../../api/v1/__tests__/fixtures',
        `${name}-live.json`
      ),
      'utf8'
    )
  );
}
function client(summary = fixture('daily-summary')) {
  const requests: string[] = [];
  const request = async (url: string) => {
    requests.push(url);
    const body = url.includes('working_days')
      ? fixture('working-days')
      : url.includes('workload')
        ? fixture('team-workload')
        : summary;
    return new Response(JSON.stringify(body));
  };
  const http: AltegioHttp = { isAuthenticated: () => true, request };
  const fake = {
    apiRequest: request,
    isAuthenticated: () => true,
    getCompanies: async () => [{ id: 4564, timezone_name: 'Asia/Dubai' }],
  } as unknown as AltegioClient;
  return { fake, http, requests };
}
beforeEach(clearTimezoneCache);

it('distinguishes expired sessions from the documented daily/calendar permission denials', () => {
  for (const kind of ['daily_summary', 'team_workload'] as const) {
    expect(
      mapAnalyticsHttpError(401, {}, kind, 'read daily data')
    ).toBeInstanceOf(AuthenticationError);
  }
  expect(
    mapAnalyticsHttpError(403, {}, 'daily_summary', 'read daily data').message
  ).toContain('basic report metrics');
  expect(
    mapAnalyticsHttpError(403, {}, 'team_workload', 'read daily data').message
  ).toContain('Digital schedule');
});

it('reads aggregate workload and working dates with identical repeated selectors, bounded to the requested period', async () => {
  const { fake, requests } = client();
  const result = await analyticsGetTeamWorkloadTool.createHandler(fake)({
    ...period,
    team_member_ids: [11, 12],
  });
  expect(result.isError).toBeUndefined();
  expect(requests).toHaveLength(2);
  for (const url of requests) {
    const query = new URL(url, 'https://test.invalid').searchParams;
    expect(query.getAll('team_member_ids[]')).toEqual(['11', '12']);
    expect(query.get('team_member_id')).toBeNull();
  }
  expect(result.structuredContent).toMatchObject({
    selection: 'selected_visible_active_team',
    points: expect.arrayContaining([
      { date: '2026-10-01', booked_share: 0.69 },
    ]),
    coverage: { excluded_outside_period_count: 1 },
  });
  const data = result.structuredContent as { points: Array<{ date: string }> };
  expect(data.points.every((p) => p.date <= period.date_to)).toBe(true);
  const validate = new Ajv({ strict: false }).compile(
    analyticsGetTeamWorkloadTool.toMcpTool().outputSchema!
  );
  expect(validate(result.structuredContent)).toBe(true);
});

it('uses the single selector for one person; an absent selector means the visible active team', async () => {
  const { http, requests } = client();
  const api = new V1DailyAnalyticsAdapter(http);
  await api.getTeamWorkload({ ...period, team_member_ids: [11] });
  await api.getWorkingDays(period);
  expect(requests[0]).toContain('team_member_id=11');
  expect(requests[1]).not.toContain('team_member_id');
});

it('keeps null distinct from zero and rejects units outside the documented fraction', () => {
  expect(bookedShare(0.69)).toBe(0.69);
  expect(bookedShare('0')).toBe(0);
  expect(bookedShare(null)).toBeNull();
  for (const value of [69, -1, 'bad', false, ''])
    expect(() => bookedShare(value)).toThrow();
});

it('reports missing working-day measurements and refuses malformed or duplicate source rows', async () => {
  const fake = client().fake;
  (fake as unknown as { apiRequest: AltegioHttp['request'] }).apiRequest =
    async (url) =>
      new Response(
        JSON.stringify({
          success: true,
          data: url.includes('working_days')
            ? ['2026-10-01', '2026-10-02']
            : [{ date: '2026-10-01', workload: null }],
        })
      );
  const result = await analyticsGetTeamWorkloadTool.createHandler(fake)(period);
  expect(result.structuredContent).toMatchObject({
    coverage: { missing_working_days: ['2026-10-01', '2026-10-02'] },
  });
  for (const data of [
    null,
    [{ date: '2026-02-30', workload: 0 }],
    [
      { date: '2026-10-01', workload: 0 },
      { date: '2026-10-01', workload: 1 },
    ],
  ]) {
    const api = new V1DailyAnalyticsAdapter({
      isAuthenticated: () => true,
      request: async () =>
        new Response(JSON.stringify({ success: true, data })),
    });
    await expect(api.getTeamWorkload(period)).rejects.toThrow();
  }
});

it('fails before any source request on an unauthorized location or an excessive range', async () => {
  const { fake, requests } = client();
  const result = await runWithContext(
    { identity: null, companyIds: new Set([99]) },
    () => analyticsGetTeamWorkloadTool.createHandler(fake)(period)
  );
  expect(result.isError).toBe(true);
  expect(requests).toHaveLength(0);
  const long = await analyticsGetTeamWorkloadTool.createHandler(fake)({
    ...period,
    date_to: '2026-12-31',
    date_from: '2026-01-01',
  });
  expect(long.isError).toBe(true);
  expect(requests).toHaveLength(0);
});

it('preserves daily source metric populations, money uncertainty and verified local date', async () => {
  const { fake } = client();
  const result = await analyticsGetDailySummaryTool.createHandler(fake)({
    location_id: 4564,
    date_from: '2026-10-08',
    date_to: '2026-10-08',
  });
  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toMatchObject({
    date: '2026-10-08',
    clients_with_appointments_count: 20,
    booked_services_value: 19005.5,
    completed_sales_value: 0,
    cash_received: 0,
    currency: null,
    average_workload_unit: 'unspecified',
  });
  expect(
    new Ajv({ strict: false }).compile(
      analyticsGetDailySummaryTool.toMcpTool().outputSchema!
    )(result.structuredContent)
  ).toBe(true);
});

it('refuses a multi-day summary and a returned date mismatch instead of inventing period coverage', async () => {
  const { fake, requests } = client();
  const multi = await analyticsGetDailySummaryTool.createHandler(fake)(period);
  expect(multi.isError).toBe(true);
  expect(requests).toHaveLength(0);
  const mismatch = await analyticsGetDailySummaryTool.createHandler(fake)({
    location_id: 4564,
    date_from: '2026-10-07',
    date_to: '2026-10-07',
  });
  expect(mismatch.isError).toBe(true);
  expect(mismatch.structuredContent).toBeUndefined();
});

it('forwards appointment analytics filters without dropping false or confusing appointment and creation dates', async () => {
  const getBookings = jest.fn(async () => []);
  const result = await getAppointmentsTool.createHandler({
    getBookings,
  } as unknown as AltegioClient)({
    location_id: 4564,
    date_from: '2026-10-01',
    date_to: '2026-10-09',
    team_member_id: 11,
    client_id: 22,
    created_by_user_id: 33,
    event_id: 44,
    created_from: '2026-09-01',
    created_to: '2026-09-30',
    changed_after: '2026-10-01T00:00:00+04:00',
    changed_before: '2026-10-09T00:00:00+04:00',
    include_deleted: false,
  });
  expect(result.isError).toBeUndefined();
  expect(getBookings).toHaveBeenCalledWith(
    4564,
    expect.objectContaining({
      team_member_id: 11,
      client_id: 22,
      created_user_id: 33,
      activity_id: 44,
      c_start_date: '2026-09-01',
      c_end_date: '2026-09-30',
      start_date: '2026-10-01',
      end_date: '2026-10-09',
      changed_after: '2026-10-01T00:00:00+04:00',
      with_deleted: 0,
    })
  );
});
