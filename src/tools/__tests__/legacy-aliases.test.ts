import { servedDefinedTools } from '../inventory.js';
import {
  LEGACY_ARGUMENT_RENAMES,
  LEGACY_TOOL_ALIASES,
  translateLegacyArguments,
} from '../legacy-aliases.js';

const tools = new Map(
  servedDefinedTools().map((tool) => [tool.meta.name, tool])
);

/** What the replacement's own validation finds in an alias's translated call. */
function issuesVia(alias: string, args: Record<string, unknown>) {
  const [target] = LEGACY_TOOL_ALIASES[alias] ?? [];
  const tool = tools.get(target ?? '');
  if (!tool) throw new Error(`no served replacement for ${alias}`);
  return tool.inputIssues(translateLegacyArguments(alias, args));
}

/**
 * Argument shapes from the former tools' schemas in git history: the
 * `company_id`/`staff_id` era (until 2026-07-20), the `count` era (until
 * 2026-09-27) and the executor's `limit`, plus the names hosts guessed.
 */
const FORMER_CALLS: Array<[alias: string, args: Record<string, unknown>]> = [
  ['list_locations', { my: 1, page: 1, count: 25 }],
  ['companies_list', { count: 50 }],
  [
    'get_appointments',
    {
      location_id: 4564,
      page: 2,
      count: 100,
      start_date: '2026-10-01',
      end_date: '2026-10-07',
      include_contacts: false,
    },
  ],
  ['get_appointments', { company_id: 4564, staff_id: 7, count: 25 }],
  [
    'altegio_search_operations',
    { query: 'appointments', method: 'GET', include_preview: false, limit: 5 },
  ],
  ['altegio_describe_operation', { operation_id: 'get_appointment' }],
  [
    'altegio_call_operation',
    { operation_id: 'get_appointment', params: { location_id: 4564 } },
  ],
  ['get_staff', { company_id: 4564, page: 1, count: 100 }],
  ['team_members_get', { location_id: 4564 }],
  ['get_services', { location_id: 4564, page: 1, count: 50 }],
  ['services_get', { company_id: 4564 }],
  [
    'get_schedule',
    {
      company_id: 4564,
      staff_id: 7,
      start_date: '2026-10-01',
      end_date: '2026-10-07',
    },
  ],
  [
    'schedule_get',
    {
      location_id: 4564,
      team_member_id: 7,
      start_date: '2026-10-01',
      end_date: '2026-10-07',
    },
  ],
  ['get_positions', { company_id: 4564, count: 10 }],
  ['get_resources', { company_id: 4564 }],
  ['get_booking_forms', { company_id: 4564, count: 10 }],
  ['get_service_categories', { company_id: 4564, category_id: 3, count: 10 }],
  ['get_appointment_settings', { company_id: 4564 }],
  ['get_online_booking_settings', { company_id: 4564 }],
  [
    'update_online_booking_settings',
    {
      company_id: 4564,
      any_master: true,
      confirm_number: true,
      seance_delay_step: 15,
      activity_online_record_clients_count_max: 5,
    },
  ],
  [
    'update_appointment_settings',
    { company_id: 4564, record_type: 1, activity_record_clients_count_max: 5 },
  ],
  ['delete_appointment', { company_id: 4564, record_id: 987 }],
  ['delete_staff', { company_id: 4564, staff_id: 7 }],
  ['update_staff', { company_id: 4564, staff_id: 7, hidden: 1, fired: 0 }],
  [
    'update_service',
    { company_id: 4564, service_id: 5, duration: 3600, active: 1 },
  ],
  ['delete_schedule', { company_id: 4564, staff_id: 7, dates: ['2026-10-12'] }],
  ['update_location', { company_id: 4564, zip: '01001', site: 'example.test' }],
  ['suppliers_list', { location_id: 4564, query: 'Acme', page_size: 20 }],
];

describe('legacy tool aliases', () => {
  it.each(FORMER_CALLS)(
    '%s: a former argument shape fits the replacement once translated',
    (alias, args) => {
      expect(issuesVia(alias, args)).toBeUndefined();
    }
  );

  it('renames into the names each replacement takes, for every alias it covers', () => {
    for (const [alias, renames] of Object.entries(LEGACY_ARGUMENT_RENAMES)) {
      const targets = LEGACY_TOOL_ALIASES[alias];
      expect(targets).toHaveLength(1);
      const properties = Object.keys(
        (tools.get(targets![0]!)?.toMcpTool().inputSchema.properties ??
          {}) as Record<string, unknown>
      );
      for (const [, to] of renames) expect(properties).toContain(to);
    }
  });

  it('turns a former 0/1 flag into the boolean the replacement takes', () => {
    expect(translateLegacyArguments('list_locations', { my: 1 })).toEqual({
      managed_only: true,
    });
    expect(
      translateLegacyArguments('update_staff', { hidden: '0', fired: 1 })
    ).toEqual({ hidden_from_online_booking: false, dismissed: true });
  });

  it('carries a former page size over as is: only a first page is lowered', () => {
    expect(
      translateLegacyArguments('get_appointments', { count: 300 })
    ).toEqual({ page_size: 300 });
    expect(
      issuesVia('get_appointments', { location_id: 1, count: 300 })
    ).toBeUndefined();
    expect(
      issuesVia('get_appointments', { location_id: 1, page: 2, count: 300 })
    ).toEqual([
      expect.objectContaining({ code: 'too_big', path: ['page_size'] }),
    ]);
  });

  it('keeps a former name next to its canonical one, so the call fails instead of losing a value', () => {
    expect(
      translateLegacyArguments('get_appointments', {
        location_id: 1,
        count: 10,
        page_size: 20,
      })
    ).toEqual({ location_id: 1, count: 10, page_size: 20 });
    expect(
      issuesVia('get_appointments', {
        location_id: 1,
        count: 10,
        page_size: 20,
      })
    ).toEqual([expect.objectContaining({ code: 'unrecognized_keys' })]);
  });

  it('leaves arguments that are not an object alone', () => {
    expect(translateLegacyArguments('get_appointments', undefined)).toBe(
      undefined
    );
    expect(translateLegacyArguments('no_such_alias', { count: 1 })).toEqual({
      count: 1,
    });
  });
});
