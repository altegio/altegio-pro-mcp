/**
 * Former and commonly guessed tool names, mapped to the tools that replace
 * them.
 *
 * Hosts cache tool lists. After a rename they keep calling the old name, get
 * "unknown tool", and give up — production logs show `list_locations`,
 * `altegio_search_operations` and `get_appointments` called weeks after their
 * renames. The registry resolves these names in `tools/call` only:
 *
 *  - one replacement and arguments that validate against it → the call is
 *    dispatched as that tool, through the same view, scope and confirmation
 *    checks as a direct call;
 *  - otherwise → an `isError` result naming the replacement(s).
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

/** The replacements for `name`, or `undefined` when it is not a known alias. */
export function legacyAliasTargets(
  name: string
): readonly string[] | undefined {
  return Object.hasOwn(LEGACY_TOOL_ALIASES, name)
    ? LEGACY_TOOL_ALIASES[name]
    : undefined;
}
