/**
 * Mapping between MCP tool names and OpenAPI spec endpoints.
 *
 * Used by spec-compliance tests to validate that MCP tools
 * match the OpenAPI specification in ../biz.erp.api.docs.
 *
 * Each entry maps a tool name to:
 * - path: OpenAPI path (as defined in openapi.yaml)
 * - method: HTTP method
 * - operationId: OpenAPI operationId for cross-reference
 * - pathParams: parameters extracted from URL path by the handler
 * - queryParams: optional query parameters supported by the tool
 * - bodyParams: optional request body parameters
 */
export interface ApiMapping {
  path: string;
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  operationId: string;
  pathParams: string[];
  queryParams?: string[];
  bodyParams?: string[];
  /**
   * Where the operation's contract lives:
   * - `documented` (default) — the published OpenAPI specification in
   *   `../biz.erp.api.docs`;
   * - `extended` — a hand-written stub in `catalog/extended/*.yaml`, the
   *   allowlist for undocumented endpoints (ADR-001 D4). Those stubs are
   *   observed shapes, not guarantees, and each one is covered by a golden
   *   contract test.
   */
  source?: 'documented' | 'extended';
}

/**
 * Maps each MCP tool to its corresponding OpenAPI endpoint.
 *
 * Onboarding tools are excluded — they orchestrate multiple API calls
 * and don't map 1:1 to spec endpoints.
 */
/**
 * Executor tools (ADR-001 D2). They resolve an operation from
 * `src/generated/catalog.json` at call time and therefore map to every
 * documented operation, not to one endpoint — the 1:1 mapping requirement below
 * does not apply to them.
 */
export const executorTools: string[] = [
  'altegio_search_operations',
  'altegio_describe_operation',
  'altegio_call_operation',
];

export const apiMapping: Record<string, ApiMapping> = {
  // ==========================================
  // Authentication
  // ==========================================
  altegio_login: {
    path: '/auth',
    method: 'post',
    operationId: 'authorize_user',
    pathParams: [],
    bodyParams: ['login', 'password'],
  },
  // altegio_logout: no API endpoint, local credential clear only

  // ==========================================
  // Locations
  // ==========================================
  list_locations: {
    path: '/companies',
    method: 'get',
    operationId: 'get_location_list',
    pathParams: [],
    queryParams: ['my', 'page', 'count'],
  },
  update_location: {
    path: '/company/{location_id}',
    method: 'put',
    operationId: 'update_location',
    pathParams: ['location_id'],
    bodyParams: [
      'title',
      'country',
      'country_id',
      'city',
      'city_id',
      'address',
      'zip',
      'phones',
      'site',
      'coordinate_lat',
      'coordinate_lon',
      'description',
      'business_type_id',
      'short_descr',
    ],
  },

  // ==========================================
  // Appointments
  // ==========================================
  get_appointments: {
    path: '/records/{location_id}',
    method: 'get',
    operationId: 'get_appointment_list',
    pathParams: ['location_id'],
    queryParams: ['page', 'count', 'start_date', 'end_date'],
  },
  create_appointment: {
    path: '/records/{location_id}',
    method: 'post',
    operationId: 'create_appointment',
    pathParams: ['location_id'],
    bodyParams: ['staff_id', 'services', 'datetime', 'client'],
  },
  update_appointment: {
    path: '/record/{location_id}/{record_id}',
    method: 'put',
    operationId: 'update_appointment',
    pathParams: ['location_id', 'record_id'],
    bodyParams: ['staff_id', 'services', 'datetime', 'client'],
  },
  delete_appointment: {
    path: '/record/{location_id}/{record_id}',
    method: 'delete',
    operationId: 'delete_appointment',
    pathParams: ['location_id', 'record_id'],
  },

  // ==========================================
  // Staff (Team Members)
  // ==========================================
  get_staff: {
    path: '/staff/{location_id}',
    method: 'get',
    operationId: 'get_team_member_list',
    pathParams: ['location_id'],
    queryParams: ['page', 'count'],
  },
  create_staff: {
    path: '/company/{location_id}/staff/quick',
    method: 'post',
    operationId: 'create_team_member_quick',
    pathParams: ['location_id'],
    bodyParams: [
      'name',
      'specialization',
      'position_id',
      'phone_number',
      'user_email',
      'user_phone',
      'is_user_invite',
      'is_paid_staff',
    ],
  },
  update_staff: {
    path: '/staff/{location_id}/{team_member_id}',
    method: 'put',
    operationId: 'update_team_member',
    pathParams: ['location_id', 'team_member_id'],
    bodyParams: [
      'name',
      'specialization',
      'weight',
      'information',
      'api_id',
      'hidden',
      'fired',
      'user_id',
    ],
  },
  delete_staff: {
    path: '/staff/{location_id}/{team_member_id}',
    method: 'delete',
    operationId: 'delete_team_member',
    pathParams: ['location_id', 'team_member_id'],
  },

  // ==========================================
  // Services
  // ==========================================
  get_services: {
    path: '/services/{location_id}',
    method: 'get',
    operationId: 'get_service_list',
    pathParams: ['location_id'],
    queryParams: ['page', 'count'],
  },
  create_service: {
    path: '/services/{location_id}',
    method: 'post',
    operationId: 'create_service',
    pathParams: ['location_id'],
    bodyParams: [
      'title',
      'category_id',
      'price_min',
      'price_max',
      'discount',
      'comment',
      'duration',
      'prepaid',
      'active',
    ],
  },
  update_service: {
    path: '/services/{location_id}/{service_id}',
    method: 'put',
    operationId: 'deprecated_update_service_by_id',
    pathParams: ['location_id', 'service_id'],
    bodyParams: [
      'title',
      'category_id',
      'price_min',
      'price_max',
      'discount',
      'comment',
      'duration',
      'active',
    ],
  },
  delete_service: {
    path: '/services/{location_id}/{service_id}',
    method: 'delete',
    operationId: 'delete_service',
    pathParams: ['location_id', 'service_id'],
  },

  // ==========================================
  // Service ↔ Team Member links
  // ==========================================
  link_service_team_member: {
    path: '/company/{location_id}/services/{service_id}/staff',
    method: 'post',
    operationId: 'assign_service_to_team_member',
    pathParams: ['location_id', 'service_id'],
    bodyParams: ['master_id', 'seance_length', 'technological_card_id'],
  },
  // Bulk variant loops the single-assign operation, so it maps to the same op.
  link_team_member_services: {
    path: '/company/{location_id}/services/{service_id}/staff',
    method: 'post',
    operationId: 'assign_service_to_team_member',
    pathParams: ['location_id', 'service_id'],
    bodyParams: ['master_id', 'seance_length', 'technological_card_id'],
  },
  update_service_team_member: {
    path: '/company/{location_id}/services/{service_id}/staff/{team_member_id}',
    method: 'put',
    operationId: 'update_service_team_member_assignment',
    pathParams: ['location_id', 'service_id', 'team_member_id'],
    bodyParams: ['seance_length', 'technological_card_id'],
  },
  unlink_service_team_member: {
    path: '/company/{location_id}/services/{service_id}/staff/{team_member_id}',
    method: 'delete',
    operationId: 'remove_service_from_team_member',
    pathParams: ['location_id', 'service_id', 'team_member_id'],
  },

  // ==========================================
  // Service Categories
  // ==========================================
  get_service_categories: {
    path: '/service_categories/{location_id}/{id}',
    method: 'get',
    operationId: 'deprecated_get_service_category_list',
    pathParams: ['location_id', 'id'],
    queryParams: ['page', 'count'],
  },
  delete_service_category: {
    path: '/service_category/{location_id}/{id}',
    method: 'delete',
    operationId: 'delete_service_category',
    pathParams: ['location_id', 'id'],
  },

  // ==========================================
  // Positions (deprecated V1, pending V2 migration)
  // ==========================================
  get_positions: {
    path: '/company/{location_id}/staff/positions',
    method: 'get',
    operationId: 'get_position_list',
    pathParams: ['location_id'],
  },
  create_position: {
    path: '/company/{location_id}/positions/quick',
    method: 'post',
    operationId: 'create_position_quick',
    pathParams: ['location_id'],
    bodyParams: ['title'],
  },
  // ==========================================
  // Schedule
  // ==========================================
  get_schedule: {
    path: '/schedule/{location_id}/{team_member_id}/{start_date}/{end_date}',
    method: 'get',
    operationId: 'get_team_member_schedule',
    pathParams: ['location_id', 'team_member_id', 'start_date', 'end_date'],
  },
  // create/update/delete_schedule all funnel through client.setSchedule, which
  // PUTs the modern /company/{id}/staff/schedule endpoint. NOTE: the backend
  // expects the per-entry key `staff_id`, not the `team_member_id` the spec
  // documents — the client maps it (see AltegioClient.setSchedule). The body
  // params below name the top-level keys the spec does document.
  create_schedule: {
    path: '/company/{location_id}/staff/schedule',
    method: 'put',
    operationId: 'set_team_member_schedule',
    pathParams: ['location_id'],
    bodyParams: ['schedules_to_set'],
  },
  update_schedule: {
    path: '/company/{location_id}/staff/schedule',
    method: 'put',
    operationId: 'set_team_member_schedule',
    pathParams: ['location_id'],
    bodyParams: ['schedules_to_set'],
  },
  delete_schedule: {
    path: '/company/{location_id}/staff/schedule',
    method: 'put',
    operationId: 'set_team_member_schedule',
    pathParams: ['location_id'],
    bodyParams: ['schedules_to_delete'],
  },

  // ==========================================
  // Location settings
  // ==========================================
  get_appointment_settings: {
    path: '/company/{location_id}/settings/timetable',
    method: 'get',
    operationId: 'get_appointment_calendar_settings',
    pathParams: ['location_id'],
  },
  update_appointment_settings: {
    path: '/company/{location_id}/settings/timetable',
    method: 'patch',
    operationId: 'update_appointment_calendar_settings',
    pathParams: ['location_id'],
    bodyParams: ['record_type', 'activity_record_clients_count_max'],
  },
  get_online_booking_settings: {
    path: '/company/{location_id}/settings/online',
    method: 'get',
    operationId: 'get_online_booking_settings',
    pathParams: ['location_id'],
  },
  update_online_booking_settings: {
    path: '/company/{location_id}/settings/online',
    method: 'patch',
    operationId: 'update_online_booking_settings',
    pathParams: ['location_id'],
    bodyParams: [
      'any_master',
      'confirm_number',
      'seance_delay_step',
      'activity_online_record_clients_count_max',
    ],
  },
  get_booking_forms: {
    path: '/company/{location_id}/booking_forms',
    method: 'get',
    operationId: 'get_booking_widget_list',
    pathParams: ['location_id'],
  },
  create_booking_form: {
    path: '/company/{location_id}/booking_forms',
    method: 'post',
    operationId: 'create_booking_widget',
    pathParams: ['location_id'],
    bodyParams: ['title'],
  },
  delete_booking_form: {
    path: '/company/{location_id}/booking_forms/{form_id}',
    method: 'delete',
    operationId: 'delete_booking_widget',
    pathParams: ['location_id', 'form_id'],
  },

  // ==========================================
  // Resources (read-only)
  // ==========================================
  get_resources: {
    path: '/resources/{location_id}',
    method: 'get',
    operationId: 'get_resource_list',
    pathParams: ['location_id'],
  },

  // ==========================================
  // Clients (client base)
  // ==========================================
  clients_search: {
    path: '/company/{location_id}/clients/search',
    method: 'post',
    operationId: 'get_client_list',
    pathParams: ['location_id'],
    bodyParams: ['filters', 'operation', 'page', 'page_size'],
  },
  clients_get_card: {
    path: '/client/{location_id}/{id}',
    method: 'get',
    operationId: 'get_client',
    pathParams: ['location_id', 'id'],
  },
  clients_get_visit_history: {
    path: '/company/{location_id}/clients/visits/search',
    method: 'post',
    operationId: 'search_client_visits',
    pathParams: ['location_id'],
    bodyParams: [
      'client_id',
      'client_phone',
      'from',
      'to',
      'payment_statuses',
      'attendance',
    ],
  },
  clients_lookup: {
    path: '/company/{location_id}/clients/autocomplete',
    method: 'get',
    operationId: 'autocomplete_clients',
    pathParams: ['location_id'],
    queryParams: ['name', 'limit'],
    source: 'extended',
  },
  clients_delete: {
    path: '/client/{location_id}/{id}',
    method: 'delete',
    operationId: 'delete_client',
    pathParams: ['location_id', 'id'],
  },

  // ==========================================
  // Location users
  // ==========================================
  remove_location_user: {
    path: '/company/{location_id}/users/{user_id}',
    method: 'delete',
    operationId: 'remove_user_from_location',
    pathParams: ['location_id', 'user_id'],
  },

  // ==========================================
  // Analytics — tools that call exactly one operation
  // ==========================================
  analytics_get_overview: {
    path: '/company/{location_id}/analytics/overall',
    method: 'get',
    operationId: 'get_location_analytics_overall',
    pathParams: ['location_id'],
    queryParams: [
      'date_from',
      'date_to',
      'team_member_id',
      'position_id',
      'user_id',
    ],
  },
  analytics_get_day_end_report: {
    path: '/reports/z_report/{location_id}',
    method: 'get',
    operationId: 'get_day_end_report_data',
    pathParams: ['location_id'],
    queryParams: ['start_date', 'master_id'],
  },
  analytics_get_forecast: {
    path: '/company/{location_id}/analytics/rfm/overall',
    method: 'get',
    operationId: 'get_location_analytics_forecast',
    pathParams: ['location_id'],
    queryParams: ['start_date', 'end_date'],
    source: 'extended',
  },
  analytics_get_team_member_occupancy: {
    path: '/company/{location_id}/staff/workload',
    method: 'get',
    operationId: 'get_location_team_member_occupancy',
    pathParams: ['location_id'],
    queryParams: ['start_date', 'end_date', 'team_member_id'],
    source: 'extended',
  },
  analytics_get_client_visit_stats: {
    path: '/api/v2/locations/{location_id}/clients/{client_id}/attendances_statistic',
    method: 'get',
    operationId: 'get_client_visit_statistics',
    pathParams: ['location_id', 'client_id'],
    source: 'extended',
  },
  analytics_list_report_fields: {
    path: '/company/{location_id}/analytics_constructor/columns',
    method: 'get',
    operationId: 'list_report_builder_columns',
    pathParams: ['location_id'],
    source: 'extended',
  },
  analytics_list_saved_reports: {
    path: '/company/{location_id}/analytics_constructor/reports',
    method: 'get',
    operationId: 'list_report_builder_reports',
    pathParams: ['location_id'],
    source: 'extended',
  },
  analytics_list_report_templates: {
    path: '/company/{location_id}/analytics_constructor/report_templates',
    method: 'get',
    operationId: 'list_report_builder_templates',
    pathParams: ['location_id'],
    queryParams: ['include'],
    source: 'extended',
  },
};

/**
 * Tools that compose several API operations into one answer.
 *
 * `apiMapping` holds one operation per tool, which the analytics pack breaks:
 * a daily series pulls four charts, receptionist performance five endpoints,
 * running a report the template list plus the field registry plus create/read
 * plus the data call. Every operation still has to exist in the published spec
 * or in `catalog/extended/*.yaml`, so the compliance test walks both maps.
 */
export const multiApiMapping: Record<string, ApiMapping[]> = {
  analytics_get_daily_series: [
    {
      path: '/company/{location_id}/analytics/overall/charts/income_daily',
      method: 'get',
      operationId: 'get_location_analytics_revenue_daily',
      pathParams: ['location_id'],
      queryParams: [
        'date_from',
        'date_to',
        'team_member_id',
        'position_id',
        'user_id',
      ],
    },
    {
      path: '/company/{location_id}/analytics/overall/charts/records_daily',
      method: 'get',
      operationId: 'get_location_analytics_appointments_daily',
      pathParams: ['location_id'],
      queryParams: [
        'date_from',
        'date_to',
        'team_member_id',
        'position_id',
        'user_id',
      ],
    },
    {
      path: '/company/{location_id}/analytics/overall/charts/fullness_daily',
      method: 'get',
      operationId: 'get_location_analytics_occupancy_daily',
      pathParams: ['location_id'],
      queryParams: [
        'date_from',
        'date_to',
        'team_member_id',
        'position_id',
        'user_id',
      ],
    },
    {
      path: '/company/{location_id}/analytics/overall/charts/clients_daily',
      method: 'get',
      operationId: 'get_location_analytics_clients_daily',
      pathParams: ['location_id'],
      queryParams: [
        'date_from',
        'date_to',
        'team_member_id',
        'position_id',
        'user_id',
      ],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/analytics/overall',
      method: 'get',
      operationId: 'get_location_analytics_overall',
      pathParams: ['location_id'],
      queryParams: ['date_from', 'date_to'],
    },
  ],
  analytics_get_appointments_breakdown: [
    {
      path: '/company/{location_id}/analytics/overall/charts/record_source',
      method: 'get',
      operationId: 'get_appointment_analytics_by_source',
      pathParams: ['location_id'],
      queryParams: [
        'date_from',
        'date_to',
        'team_member_id',
        'position_id',
        'user_id',
      ],
    },
    {
      path: '/company/{location_id}/analytics/overall/charts/record_status',
      method: 'get',
      operationId: 'get_appointment_analytics_by_status',
      pathParams: ['location_id'],
      queryParams: [
        'date_from',
        'date_to',
        'team_member_id',
        'position_id',
        'user_id',
      ],
    },
  ],
  analytics_get_loyalty_program_results: [
    {
      path: '/company/{location_id}/analytics/loyalty_programs/visits',
      method: 'get',
      operationId: 'get_loyalty_program_client_statistics',
      pathParams: ['location_id'],
      queryParams: ['loyalty_program_id', 'date_from', 'date_to'],
    },
    {
      path: '/company/{location_id}/analytics/loyalty_programs/income',
      method: 'get',
      operationId: 'get_loyalty_program_revenue_statistics',
      pathParams: ['location_id'],
      queryParams: ['loyalty_program_id', 'date_from', 'date_to'],
    },
    {
      path: '/company/{location_id}/analytics/loyalty_programs/staff',
      method: 'get',
      operationId: 'get_loyalty_program_team_member_statistics',
      pathParams: ['location_id'],
      queryParams: ['loyalty_program_id', 'date_from', 'date_to'],
    },
  ],
  analytics_get_receptionist_performance: [
    {
      path: '/company/{location_id}/analytics/administrator/clients_scheduled',
      method: 'get',
      operationId: 'get_location_analytics_receptionist_clients_booked',
      pathParams: ['location_id'],
      queryParams: ['date_from', 'date_to', 'user_id', 'include'],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/analytics/administrator/records_closed',
      method: 'get',
      operationId: 'get_location_analytics_receptionist_appointments_closed',
      pathParams: ['location_id'],
      queryParams: ['date_from', 'date_to', 'user_id', 'include'],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/analytics/administrator/income',
      method: 'get',
      operationId: 'get_location_analytics_receptionist_revenue',
      pathParams: ['location_id'],
      queryParams: ['date_from', 'date_to', 'user_id', 'include'],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/analytics/administrator/visited_clients_rescheduled',
      method: 'get',
      operationId: 'get_location_analytics_receptionist_rebooked_after_visit',
      pathParams: ['location_id'],
      queryParams: ['date_from', 'date_to', 'user_id', 'include'],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/analytics/administrator/canceled_clients_rescheduled',
      method: 'get',
      operationId: 'get_location_analytics_receptionist_rebooked_after_no_show',
      pathParams: ['location_id'],
      queryParams: ['date_from', 'date_to', 'user_id', 'include'],
      source: 'extended',
    },
  ],
  analytics_run_report: [
    {
      path: '/company/{location_id}/analytics_constructor/report_templates',
      method: 'get',
      operationId: 'list_report_builder_templates',
      pathParams: ['location_id'],
      queryParams: ['include'],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/analytics_constructor/columns',
      method: 'get',
      operationId: 'list_report_builder_columns',
      pathParams: ['location_id'],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/analytics_constructor/reports',
      method: 'get',
      operationId: 'list_report_builder_reports',
      pathParams: ['location_id'],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/analytics_constructor/reports',
      method: 'post',
      operationId: 'create_report_builder_report',
      pathParams: ['location_id'],
      bodyParams: [
        'name',
        'description',
        'report_template_id',
        'type',
        'report_columns',
        'report_filters',
        'report_groupings',
      ],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/analytics_constructor/reports/{report_id}',
      method: 'get',
      operationId: 'get_report_builder_report',
      pathParams: ['location_id', 'report_id'],
      queryParams: ['include'],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/analytics_constructor/reports/{report_id}',
      method: 'post',
      operationId: 'update_report_builder_report',
      pathParams: ['location_id', 'report_id'],
      bodyParams: [
        'name',
        'description',
        'report_template_id',
        'type',
        'report_columns',
        'report_filters',
        'report_groupings',
      ],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/analytics_constructor/reports/{report_id}/data',
      method: 'post',
      operationId: 'run_report_builder_report',
      pathParams: ['location_id', 'report_id'],
      bodyParams: ['filters'],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/ac/{report_id}/data',
      method: 'post',
      operationId: 'run_report_builder_report_legacy',
      pathParams: ['location_id', 'report_id'],
      bodyParams: ['report_columns'],
      source: 'extended',
    },
  ],
  analytics_run_saved_report: [
    {
      path: '/company/{location_id}/analytics_constructor/columns',
      method: 'get',
      operationId: 'list_report_builder_columns',
      pathParams: ['location_id'],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/analytics_constructor/reports/{report_id}',
      method: 'get',
      operationId: 'get_report_builder_report',
      pathParams: ['location_id', 'report_id'],
      queryParams: ['include'],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/analytics_constructor/reports/{report_id}/data',
      method: 'post',
      operationId: 'run_report_builder_report',
      pathParams: ['location_id', 'report_id'],
      bodyParams: ['filters'],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/ac/{report_id}/data',
      method: 'post',
      operationId: 'run_report_builder_report_legacy',
      pathParams: ['location_id', 'report_id'],
      bodyParams: ['report_columns'],
      source: 'extended',
    },
  ],
  analytics_delete_assistant_report: [
    {
      path: '/company/{location_id}/analytics_constructor/reports/{report_id}',
      method: 'get',
      operationId: 'get_report_builder_report',
      pathParams: ['location_id', 'report_id'],
      queryParams: ['include'],
      source: 'extended',
    },
    {
      path: '/company/{location_id}/ac/{report_id}',
      method: 'delete',
      operationId: 'delete_report_builder_report_legacy',
      pathParams: ['location_id', 'report_id'],
      source: 'extended',
    },
  ],
};

/** Every tool → operation pair, from both maps, for the compliance test. */
export function allApiMappings(): Array<[string, ApiMapping]> {
  const pairs: Array<[string, ApiMapping]> = Object.entries(apiMapping).map(
    ([tool, mapping]) => [tool, mapping]
  );
  for (const [tool, mappings] of Object.entries(multiApiMapping)) {
    for (const mapping of mappings) pairs.push([tool, mapping]);
  }
  return pairs;
}

/** Where a mapping's contract is expected to live. */
export function mappingSource(mapping: ApiMapping): 'documented' | 'extended' {
  return mapping.source ?? 'documented';
}

/**
 * Tools that don't map to API endpoints (local operations or orchestrators).
 */
export const unmappedTools: string[] = [
  'altegio_logout',
  // Universal executor (ADR-001 D2): these are backed by the whole generated
  // catalog rather than by one endpoint, so a 1:1 spec mapping cannot exist.
  // Their drift check is `npm run catalog:check` plus the tests in
  // src/tools/executor/__tests__/.
  ...executorTools,
  'onboarding_start',
  'onboarding_resume',
  'onboarding_status',
  'onboarding_add_positions',
  'onboarding_set_schedules',
  'onboarding_add_staff_batch',
  'onboarding_add_services_batch',
  'onboarding_add_categories',
  'onboarding_import_clients',
  'onboarding_create_test_appointments',
  'onboarding_preview_data',
  'onboarding_rollback_phase',
];
