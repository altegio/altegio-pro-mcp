/**
 * Former and commonly guessed tool names, mapped to the tools that replace
 * them.
 *
 * Hosts cache tool lists. After a rename they keep calling the old name, get
 * "unknown tool", and give up — production logs show `list_locations`,
 * `altegio_search_operations` and `get_appointments` called weeks after their
 * renames. A host that cached the old name also cached the old arguments
 * (`count`, `start_date`, `company_id`, `limit`), so the registry resolves
 * these names in `tools/call` only:
 *
 *  - one replacement → the arguments are translated from the former names
 *    (`LEGACY_ARGUMENT_RENAMES`) and, when they then validate, the call is
 *    dispatched as that tool, through the same view, scope and confirmation
 *    checks as a direct call;
 *  - arguments that still do not fit → an `isError` result naming the
 *    replacement and what to change, in canonical argument names only;
 *  - several replacements → an `isError` result naming them.
 *
 * Aliases are never listed in `tools/list`, never named in a description, and
 * never served where the replacement is not. Keys are fixed strings, so a
 * reply may name them; nothing a caller sent is echoed beyond a validated name.
 */
export const LEGACY_TOOL_ALIASES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    // 0.5.0-alpha.0: `<domain>_<verb>_<object>` everywhere (CHANGELOG).
    altegio_login: ['auth_login'],
    altegio_logout: ['auth_logout'],
    list_locations: ['locations_list'],
    update_location: ['locations_update'],
    diagnose_location_access: ['locations_diagnose_access'],
    remove_location_user: ['locations_remove_user'],
    get_positions: ['positions_list'],
    create_position: ['positions_create'],
    get_services: ['services_list'],
    create_service: ['services_create'],
    update_service: ['services_update'],
    delete_service: ['services_delete'],
    link_service_team_member: ['services_link_team_member'],
    update_service_team_member: ['services_update_team_member_link'],
    unlink_service_team_member: ['services_unlink_team_member'],
    link_team_member_services: ['team_members_link_services'],
    get_service_categories: ['service_categories_list'],
    delete_service_category: ['service_categories_delete'],
    get_schedule: ['schedules_get'],
    create_schedule: ['schedules_create'],
    update_schedule: ['schedules_update'],
    delete_schedule: ['schedules_delete'],
    get_appointments: ['appointments_list'],
    create_appointment: ['appointments_create'],
    update_appointment: ['appointments_update'],
    delete_appointment: ['appointments_delete'],
    get_appointment_settings: ['settings_get_appointment_calendar'],
    update_appointment_settings: ['settings_update_appointment_calendar'],
    get_online_booking_settings: ['settings_get_online_booking'],
    update_online_booking_settings: ['settings_update_online_booking'],
    get_booking_forms: ['booking_forms_list'],
    create_booking_form: ['booking_forms_create'],
    delete_booking_form: ['booking_forms_delete'],
    get_resources: ['resources_list'],
    altegio_search_operations: ['api_search_operations'],
    altegio_describe_operation: ['api_describe_operation'],
    altegio_call_operation: ['api_call_operation'],

    // 0.4.0-alpha.0: staff tools became team-member tools.
    get_staff: ['team_members_list'],
    create_staff: ['team_members_create'],
    update_staff: ['team_members_update'],
    delete_staff: ['team_members_delete'],

    // 2026-10-20: Suppliers and Partners are one glossary concept.
    suppliers_list: ['suppliers_and_partners_list'],

    // Names hosts guessed (production logs, 2026-09-25..10-11).
    companies_list: ['locations_list'],
    team_members_get: ['team_members_list'],
    services_get: ['services_list'],
    schedule_get: ['schedules_get'],
    settings_get: [
      'settings_get_online_booking',
      'settings_get_appointment_calendar',
    ],
  });

/** A former argument name, its canonical name, and how its value changed. */
type ArgumentRename = readonly [
  from: string,
  to: string,
  convert?: (value: unknown) => unknown,
];

/** A 0/1 flag of the former contract as the boolean the tool takes now. */
const flag = (value: unknown): unknown =>
  value === 1 || value === '1'
    ? true
    : value === 0 || value === '0'
      ? false
      : value;

// Renames shared by many former tools (git history of src/tools/definitions:
// `company_id`/`staff_id` until 2026-07-20, `count` until 2026-09-27).
const LOCATION: readonly ArgumentRename[] = [['company_id', 'location_id']];
const TEAM_MEMBER: readonly ArgumentRename[] = [['staff_id', 'team_member_id']];
const PAGE: readonly ArgumentRename[] = [['count', 'page_size']];
const PERIOD: readonly ArgumentRename[] = [
  ['start_date', 'date_from'],
  ['end_date', 'date_to'],
];
const APPOINTMENT: readonly ArgumentRename[] = [
  ['record_id', 'appointment_id'],
];
const LOCATIONS_LIST: readonly ArgumentRename[] = [
  ['my', 'managed_only', flag],
  ...PAGE,
];

/**
 * Per former name: the argument names its cached schema used, mapped to the
 * replacement's (the same name when only the value's form changed). A name
 * absent here passes through unchanged; a value the replacement no longer
 * accepts (`count` over the page-size limit) still fails its validation and
 * is answered with what to change — never clamped.
 */
export const LEGACY_ARGUMENT_RENAMES: Readonly<
  Record<string, readonly ArgumentRename[]>
> = Object.freeze({
  list_locations: LOCATIONS_LIST,
  companies_list: LOCATIONS_LIST,
  update_location: [
    ...LOCATION,
    ['zip', 'postal_code'],
    ['site', 'website'],
    ['short_descr', 'short_description'],
  ],
  diagnose_location_access: LOCATION,
  get_positions: [...LOCATION, ...PAGE],
  create_position: LOCATION,
  get_services: [...LOCATION, ...PAGE],
  services_get: [...LOCATION, ...PAGE],
  create_service: [
    ...LOCATION,
    ['duration', 'duration_seconds'],
    ['active', 'active', flag],
  ],
  update_service: [
    ...LOCATION,
    ['duration', 'duration_seconds'],
    ['active', 'active', flag],
  ],
  delete_service: LOCATION,
  link_service_team_member: [...LOCATION, ...TEAM_MEMBER],
  update_service_team_member: [...LOCATION, ...TEAM_MEMBER],
  unlink_service_team_member: [...LOCATION, ...TEAM_MEMBER],
  link_team_member_services: [...LOCATION, ...TEAM_MEMBER],
  get_service_categories: [...LOCATION, ...PAGE],
  delete_service_category: LOCATION,
  get_schedule: [...LOCATION, ...TEAM_MEMBER, ...PERIOD],
  schedule_get: [...LOCATION, ...TEAM_MEMBER, ...PERIOD],
  create_schedule: [...LOCATION, ...TEAM_MEMBER],
  update_schedule: [...LOCATION, ...TEAM_MEMBER],
  delete_schedule: [...LOCATION, ...TEAM_MEMBER],
  get_appointments: [...LOCATION, ...TEAM_MEMBER, ...PAGE, ...PERIOD],
  create_appointment: [
    ...LOCATION,
    ...TEAM_MEMBER,
    ['seance_length', 'session_length'],
  ],
  update_appointment: [
    ...LOCATION,
    ...TEAM_MEMBER,
    ...APPOINTMENT,
    ['seance_length', 'session_length'],
  ],
  delete_appointment: [...LOCATION, ...APPOINTMENT],
  get_appointment_settings: LOCATION,
  update_appointment_settings: [
    ...LOCATION,
    ['record_type', 'appointment_type'],
    ['activity_record_clients_count_max', 'group_event_max_seats'],
  ],
  get_online_booking_settings: LOCATION,
  update_online_booking_settings: [
    ...LOCATION,
    ['any_master', 'any_team_member'],
    ['seance_delay_step', 'session_delay_step'],
    [
      'activity_online_record_clients_count_max',
      'online_group_event_max_seats',
    ],
  ],
  get_booking_forms: [...LOCATION, ...PAGE],
  create_booking_form: LOCATION,
  delete_booking_form: LOCATION,
  get_resources: [...LOCATION, ...PAGE],
  altegio_search_operations: [['limit', 'page_size']],
  get_staff: [...LOCATION, ...PAGE],
  team_members_get: [...LOCATION, ...PAGE],
  create_staff: [
    ...LOCATION,
    ['is_user_invite', 'invite_user'],
    ['has_timetable_access', 'has_schedule_access'],
    ['is_paid_staff', 'has_paid_seat'],
  ],
  update_staff: [
    ...LOCATION,
    ...TEAM_MEMBER,
    ['weight', 'sort_weight'],
    ['api_id', 'external_id'],
    ['hidden', 'hidden_from_online_booking', flag],
    ['fired', 'dismissed', flag],
  ],
  delete_staff: [...LOCATION, ...TEAM_MEMBER],
});

/**
 * `args` with the former argument names of `alias` renamed to the canonical
 * ones. A former name is renamed only when the canonical one is absent, so a
 * call that sends both still fails validation instead of losing a value.
 */
export function translateLegacyArguments(
  alias: string,
  args: unknown
): unknown {
  const renames = Object.hasOwn(LEGACY_ARGUMENT_RENAMES, alias)
    ? LEGACY_ARGUMENT_RENAMES[alias]
    : undefined;
  if (!renames || !args || typeof args !== 'object' || Array.isArray(args)) {
    return args;
  }
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  for (const [from, to, convert] of renames) {
    if (!Object.hasOwn(out, from)) continue;
    if (from !== to && Object.hasOwn(out, to)) continue;
    const value = out[from];
    delete out[from];
    out[to] = convert ? convert(value) : value;
  }
  return out;
}

/** The replacements for `name`, or `undefined` when it is not a known alias. */
export function legacyAliasTargets(
  name: string
): readonly string[] | undefined {
  return Object.hasOwn(LEGACY_TOOL_ALIASES, name)
    ? LEGACY_TOOL_ALIASES[name]
    : undefined;
}
