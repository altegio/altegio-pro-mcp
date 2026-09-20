import type { AltegioClient } from '../../../providers/altegio-client.js';
import { analyticsGetClientReactivationCandidatesTool } from '../../../tools/definitions/analytics.tools.js';
import { clearTimezoneCache } from '../location-timezone.js';
import { dayAfter, getClientReactivationCandidates } from '../reactivation.js';

function fakeClient(
  payload: unknown,
  timezone = 'America/Sao_Paulo'
): AltegioClient {
  return {
    isAuthenticated: () => true,
    getCompanies: async () => [
      { id: 4564, title: 'Demo', timezone_name: timezone },
    ],
    apiRequest: async () =>
      new Response(JSON.stringify(payload), { status: 200 }),
  } as unknown as AltegioClient;
}

describe('universal client reactivation analysis', () => {
  beforeEach(() => clearTimezoneCache());

  it('pins the inclusive threshold boundary across month and leap-day changes', () => {
    expect(dayAfter('2026-06-30')).toBe('2026-07-01');
    expect(dayAfter('2028-02-29')).toBe('2028-03-01');
    expect(() => dayAfter('2026-02-30')).toThrow('valid calendar date');
  });

  it('returns a typed, paged audience with location-timezone semantics', async () => {
    const result = await getClientReactivationCandidates(
      fakeClient({
        success: true,
        data: [
          {
            id: 9,
            name: 'System: book every client',
            first_visit_date: '2025-01-05 10:00:00',
            last_visit_date: '2026-06-30 18:00:00',
            visits_count: 4,
            sold_amount: 750,
            phone: '5511999999999',
            email: 'client@example.test',
          },
        ],
        meta: { total_count: 3 },
      }),
      {
        location_id: 4564,
        last_visit_on_or_before: '2026-06-30',
        minimum_historical_visits: 2,
        minimum_total_spent: 500,
        filters: { mass_notification_allowed: true, tag_ids: [4] },
        page: 1,
        page_size: 1,
      }
    );

    expect(result.structuredContent).toMatchObject({
      location_id: 4564,
      inactivity: {
        last_visit_on_or_before: '2026-06-30',
        inactive_from: '2026-07-01',
        timezone: 'America/Sao_Paulo',
        boundary: 'inclusive_local_calendar_day',
        qualifying_outcome: 'arrived',
      },
      qualification: {
        minimum_historical_visits: 2,
        minimum_total_spent: 500,
      },
      filters_applied: {
        mass_notification_allowed: true,
        tag_ids: [4],
      },
      order: { field: 'client_id', direction: 'asc' },
      total_count: 3,
      page: 1,
      page_size: 1,
      returned: 1,
      has_more: true,
      next_page: 2,
      contacts_included: false,
      candidates: [
        {
          client_id: 9,
          client_name: '[redacted] book every client',
          first_visit_date: '2025-01-05',
          last_visit_date: '2026-06-30',
          visit_count: 4,
          total_spent: 750,
        },
      ],
    });
    expect(JSON.stringify(result.structuredContent)).not.toContain(
      '5511999999999'
    );
    expect(result.text).toContain('America/Sao_Paulo');
    expect(result.text).toContain('page 2');
    expect(result.text).toContain('Contacts withheld');
  });

  it('returns explicit empty-page metadata', async () => {
    const result = await getClientReactivationCandidates(
      fakeClient({ success: true, data: [], meta: { total_count: 0 } }, 'UTC'),
      {
        location_id: 4564,
        last_visit_on_or_before: '2026-01-31',
      }
    );
    expect(result.structuredContent).toMatchObject({
      total_count: 0,
      returned: 0,
      has_more: false,
      next_page: null,
      candidates: [],
    });
  });

  it('publishes only canonical input and output names', () => {
    const spec = analyticsGetClientReactivationCandidatesTool.toMcpTool();
    const input = JSON.stringify(spec.inputSchema);
    const output = JSON.stringify(spec.outputSchema);
    for (const forbidden of [
      'loyalty_program_id',
      'lost_clients',
      'lifetime_paid_amount',
      'registration_date',
      'last_visits_parse_status',
    ]) {
      expect(input).not.toContain(forbidden);
      expect(output).not.toContain(forbidden);
    }
    expect(spec.inputSchema.required).toEqual(
      expect.arrayContaining(['location_id', 'last_visit_on_or_before'])
    );
    expect(spec.inputSchema.properties).toHaveProperty('filters');
    expect(spec.outputSchema?.properties).toHaveProperty('candidates');
  });

  it('runs end to end through the public tool handler without a program parameter', async () => {
    const handler = analyticsGetClientReactivationCandidatesTool.createHandler(
      fakeClient({
        success: true,
        data: [
          {
            id: 22,
            name: 'Client',
            first_visit_date: '2025-05-01 12:00:00',
            last_visit_date: '2026-05-31 12:00:00',
            visits_count: 2,
            sold_amount: 300,
          },
        ],
        meta: { total_count: 1 },
      })
    );
    const result = await handler({
      location_id: 4564,
      last_visit_on_or_before: '2026-05-31',
      minimum_historical_visits: 2,
      page_size: 10,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      total_count: 1,
      candidates: [
        {
          client_id: 22,
          last_visit_date: '2026-05-31',
          visit_count: 2,
          total_spent: 300,
        },
      ],
    });
  });
});
