/**
 * Mapping between MCP tool names and OpenAPI spec endpoints.
 *
 * Used by spec-compliance tests to validate that MCP tools
 * match the OpenAPI specification in ../biz.erp.api.docs.
 *
 * Each entry maps a tool name to:
 * - path: the URL the tool calls, exactly as its contract spells it — the
 *   spec's canonical `/locations/{id}/…` URL for a documented operation, the
 *   stub's own URL for an extended one. V1 also accepts the legacy spellings
 *   (`/company/{id}`, `/staff/{id}`, `/record/{id}/{rid}`, …), but the spec no
 *   longer documents them, so a tool never calls one for a documented operation.
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
  /**
   * Which published specification documents the operation: `v1` (default,
   * `docs/en/b2b-v1/openapi.yaml`) or `v2` (`docs/en/b2b-v2/openapi.yaml`).
   * The curated tool's adapter decides the version; the model never sees it.
   */
  spec?: 'v1' | 'v2';
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
  'api_search_operations',
  'api_describe_operation',
  'api_call_operation',
];

export const apiMapping: Record<string, ApiMapping> = {
  clients_list_comments: {
    path: '/locations/{location_id}/clients/{client_id}/comments',
    method: 'get',
    operationId: 'list_client_comments',
    pathParams: ['location_id', 'client_id'],
  },
  clients_add_comment: {
    path: '/locations/{location_id}/clients/{client_id}/comments',
    method: 'post',
    operationId: 'create_client_comment',
    pathParams: ['location_id', 'client_id'],
    bodyParams: ['text'],
  },
  clients_list_files: {
    path: '/locations/{location_id}/clients/files/{client_id}',
    method: 'get',
    operationId: 'get_client_file_list',
    pathParams: ['location_id', 'client_id'],
  },
  clients_upload_file: {
    path: '/locations/{location_id}/clients/files/{client_id}',
    method: 'post',
    operationId: 'upload_client_file',
    pathParams: ['location_id', 'client_id'],
    bodyParams: ['file'],
  },
  // ==========================================
  // Authentication
  // ==========================================
  auth_login: {
    path: '/auth',
    method: 'post',
    operationId: 'authorize_user',
    pathParams: [],
    bodyParams: ['login', 'password'],
  },
  // auth_logout: no API endpoint, local credential clear only

  // ==========================================
  // Users
  // ==========================================
  users_get_current: {
    path: '/user/data',
    method: 'get',
    operationId: 'get_current_user',
    pathParams: [],
    source: 'extended',
  },

  // ==========================================
  // Locations
  // ==========================================
  locations_list: {
    path: '/locations',
    method: 'get',
    operationId: 'get_location_list',
    pathParams: [],
    queryParams: ['my', 'page', 'count'],
  },
  locations_update: {
    path: '/locations/{location_id}',
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
  appointments_list: {
    path: '/locations/{location_id}/appointments',
    method: 'get',
    operationId: 'get_appointment_list',
    pathParams: ['location_id'],
    queryParams: ['page', 'count', 'start_date', 'end_date'],
  },
  appointments_create: {
    path: '/locations/{location_id}/appointments',
    method: 'post',
    operationId: 'create_appointment',
    pathParams: ['location_id'],
    bodyParams: ['staff_id', 'services', 'datetime', 'client'],
  },
  appointments_update: {
    path: '/locations/{location_id}/appointments/{record_id}',
    method: 'put',
    operationId: 'update_appointment',
    pathParams: ['location_id', 'record_id'],
    bodyParams: ['staff_id', 'services', 'datetime', 'client'],
  },
  appointments_delete: {
    path: '/locations/{location_id}/appointments/{appointment_id}',
    method: 'delete',
    operationId: 'delete_appointment',
    pathParams: ['location_id', 'appointment_id'],
    spec: 'v2',
  },

  // ==========================================
  // Group events (V2 first; event services only exist on V1)
  // ==========================================
  events_list: {
    path: '/locations/{location_id}/events',
    method: 'get',
    operationId: 'list_events',
    pathParams: ['location_id'],
    queryParams: [
      'filter[from]',
      'filter[to]',
      'filter[master_ids][]',
      'filter[service_ids][]',
      'filter[resource_ids][]',
      'filter[weekdays][]',
      'filter[capacity]',
      'filter[sort]',
      'filter[include_deleted]',
      'page',
      'limit',
      'include',
    ],
    spec: 'v2',
  },
  events_list_services: {
    path: '/locations/{location_id}/events/services',
    method: 'get',
    operationId: 'search_event_services',
    pathParams: ['location_id'],
    queryParams: ['staff_id', 'term'],
  },
  events_list_duplication_strategies: {
    path: '/locations/{location_id}/events/duplication_strategies',
    method: 'get',
    operationId: 'list_event_duplication_strategies_v2',
    pathParams: ['location_id'],
    spec: 'v2',
  },
  events_create: {
    path: '/locations/{location_id}/events',
    method: 'post',
    operationId: 'create_event',
    pathParams: ['location_id'],
    queryParams: ['include'],
    bodyParams: [
      'staff_id',
      'service_id',
      'resource_instance_ids',
      'label_ids',
      'date',
      'length',
      'capacity',
      'technical_break_duration',
      'comment',
      'color',
      'instructions',
      'stream_link',
      'force',
    ],
    spec: 'v2',
  },
  events_delete: {
    path: '/locations/{location_id}/events/{event_id}',
    method: 'delete',
    operationId: 'delete_event',
    pathParams: ['location_id', 'event_id'],
    spec: 'v2',
  },
  events_duplicate: {
    path: '/locations/{location_id}/events/{event_id}/duplicate',
    method: 'post',
    operationId: 'duplicate_event',
    pathParams: ['location_id', 'event_id'],
    bodyParams: ['dates', 'content_type', 'force'],
    spec: 'v2',
  },
  events_create_duplication_strategy: {
    path: '/locations/{location_id}/events/duplication_strategies',
    method: 'post',
    operationId: 'create_event_duplication_strategy_v2',
    pathParams: ['location_id'],
    bodyParams: ['title', 'repeat_mode_id', 'days', 'interval', 'content_type'],
    spec: 'v2',
  },
  events_delete_duplication_strategy: {
    path: '/locations/{location_id}/events/duplication_strategies/{strategy_id}',
    method: 'delete',
    operationId: 'delete_event_duplication_strategy_v2',
    pathParams: ['location_id', 'strategy_id'],
    spec: 'v2',
  },
  events_book_clients: {
    path: '/locations/{location_id}/events/{event_id}/appointments/bulk',
    method: 'post',
    operationId: 'bulk_create_event_appointments',
    pathParams: ['location_id', 'event_id'],
    bodyParams: ['records'],
    spec: 'v2',
  },
  events_reschedule_appointment: {
    path: '/locations/{location_id}/events/{event_id}/appointments/{record_id}',
    method: 'patch',
    operationId: 'reschedule_event_appointment',
    pathParams: ['location_id', 'event_id', 'record_id'],
    queryParams: ['include'],
    bodyParams: [
      'reschedule_activity_id',
      'with_comer',
      'comment',
      'clients_count',
    ],
    spec: 'v2',
  },

  // ==========================================
  // Staff (Team Members)
  // ==========================================
  team_members_list: {
    path: '/locations/{location_id}/team_members',
    method: 'get',
    operationId: 'get_team_member_list',
    pathParams: ['location_id'],
    queryParams: ['page', 'count'],
  },
  team_members_create: {
    path: '/locations/{location_id}/team_members/quick',
    method: 'post',
    operationId: 'create_team_member_quick',
    pathParams: ['location_id'],
    bodyParams: [
      'name',
      'specialization',
      'position_id',
      'user_email',
      'user_phone',
      'is_user_invite',
      'has_timetable_access',
      'is_paid_staff',
    ],
  },
  team_members_update: {
    path: '/locations/{location_id}/team_members/{team_member_id}',
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
  team_members_delete: {
    path: '/locations/{location_id}/team_members/{team_member_id}',
    method: 'delete',
    operationId: 'delete_team_member',
    pathParams: ['location_id', 'team_member_id'],
  },

  // ==========================================
  // Services
  // ==========================================
  services_list: {
    path: '/services/{location_id}',
    method: 'get',
    operationId: 'get_service_list',
    pathParams: ['location_id'],
    queryParams: ['page', 'count'],
  },
  services_create: {
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
  services_update: {
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
  services_delete: {
    path: '/services/{location_id}/{service_id}',
    method: 'delete',
    operationId: 'delete_service',
    pathParams: ['location_id', 'service_id'],
  },

  // ==========================================
  // Service ↔ Team Member links
  // ==========================================
  services_link_team_member: {
    path: '/locations/{location_id}/services/{service_id}/team_members',
    method: 'post',
    operationId: 'assign_service_to_team_member',
    pathParams: ['location_id', 'service_id'],
    bodyParams: ['master_id', 'seance_length', 'technological_card_id'],
  },
  // Bulk variant loops the single-assign operation, so it maps to the same op.
  team_members_link_services: {
    path: '/locations/{location_id}/services/{service_id}/team_members',
    method: 'post',
    operationId: 'assign_service_to_team_member',
    pathParams: ['location_id', 'service_id'],
    bodyParams: ['master_id', 'seance_length', 'technological_card_id'],
  },
  services_update_team_member_link: {
    path: '/locations/{location_id}/services/{service_id}/team_members/{team_member_id}',
    method: 'put',
    operationId: 'update_service_team_member_assignment',
    pathParams: ['location_id', 'service_id', 'team_member_id'],
    bodyParams: ['seance_length', 'technological_card_id'],
  },
  services_unlink_team_member: {
    path: '/locations/{location_id}/services/{service_id}/team_members/{team_member_id}',
    method: 'delete',
    operationId: 'remove_service_from_team_member',
    pathParams: ['location_id', 'service_id', 'team_member_id'],
  },

  // ==========================================
  // Service Categories
  // ==========================================
  service_categories_list: {
    path: '/service_categories/{location_id}/{id}',
    method: 'get',
    operationId: 'deprecated_get_service_category_list',
    pathParams: ['location_id', 'id'],
    queryParams: ['page', 'count'],
  },
  service_categories_delete: {
    path: '/service_category/{location_id}/{id}',
    method: 'delete',
    operationId: 'delete_service_category',
    pathParams: ['location_id', 'id'],
  },

  // ==========================================
  // Positions
  // ==========================================
  positions_list: {
    path: '/locations/{company_id}/positions',
    method: 'get',
    operationId: 'list_positions',
    pathParams: ['company_id'],
    spec: 'v2',
  },
  positions_create: {
    path: '/locations/{company_id}/positions',
    method: 'post',
    operationId: 'create_position',
    pathParams: ['company_id'],
    bodyParams: ['title', 'description'],
    spec: 'v2',
  },
  // ==========================================
  // Schedule
  // ==========================================
  schedules_get: {
    path: '/schedule/{location_id}/{team_member_id}/{start_date}/{end_date}',
    method: 'get',
    operationId: 'get_team_member_schedule',
    pathParams: ['location_id', 'team_member_id', 'start_date', 'end_date'],
  },
  // create/update/schedules_delete all funnel through client.setSchedule, which
  // PUTs the modern /locations/{id}/team_members/schedule endpoint. NOTE: the backend
  // expects the per-entry key `staff_id`, not the `team_member_id` the spec
  // documents — the client maps it (see AltegioClient.setSchedule). The body
  // params below name the top-level keys the spec does document.
  schedules_create: {
    path: '/locations/{location_id}/team_members/schedule',
    method: 'put',
    operationId: 'set_team_member_schedule',
    pathParams: ['location_id'],
    bodyParams: ['schedules_to_set'],
  },
  schedules_update: {
    path: '/locations/{location_id}/team_members/schedule',
    method: 'put',
    operationId: 'set_team_member_schedule',
    pathParams: ['location_id'],
    bodyParams: ['schedules_to_set'],
  },
  schedules_delete: {
    path: '/locations/{location_id}/team_members/schedule',
    method: 'put',
    operationId: 'set_team_member_schedule',
    pathParams: ['location_id'],
    bodyParams: ['schedules_to_delete'],
  },

  // ==========================================
  // Location settings
  // ==========================================
  settings_get_appointment_calendar: {
    path: '/locations/{location_id}/settings/timetable',
    method: 'get',
    operationId: 'get_appointment_calendar_settings',
    pathParams: ['location_id'],
  },
  settings_update_appointment_calendar: {
    path: '/locations/{location_id}/settings/timetable',
    method: 'patch',
    operationId: 'update_appointment_calendar_settings',
    pathParams: ['location_id'],
    bodyParams: ['record_type', 'activity_record_clients_count_max'],
  },
  settings_get_online_booking: {
    path: '/locations/{location_id}/settings/online',
    method: 'get',
    operationId: 'get_online_booking_settings',
    pathParams: ['location_id'],
  },
  settings_update_online_booking: {
    path: '/locations/{location_id}/settings/online',
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
  booking_forms_list: {
    path: '/locations/{location_id}/booking_forms',
    method: 'get',
    operationId: 'get_booking_widget_list',
    pathParams: ['location_id'],
  },
  booking_forms_create: {
    path: '/locations/{location_id}/booking_forms',
    method: 'post',
    operationId: 'create_booking_widget',
    pathParams: ['location_id'],
    bodyParams: ['title'],
  },
  booking_forms_delete: {
    path: '/locations/{location_id}/booking_forms/{form_id}',
    method: 'delete',
    operationId: 'delete_booking_widget',
    pathParams: ['location_id', 'form_id'],
  },

  // ==========================================
  // Resources (read-only)
  // ==========================================
  resources_list: {
    path: '/resources/{location_id}',
    method: 'get',
    operationId: 'get_resource_list',
    pathParams: ['location_id'],
  },

  // ==========================================
  // Clients (client base)
  // ==========================================
  clients_search: {
    path: '/locations/{location_id}/clients/search',
    method: 'post',
    operationId: 'get_client_list',
    pathParams: ['location_id'],
    bodyParams: ['filters', 'operation', 'page', 'page_size'],
  },
  clients_get_segment_report: {
    path: '/locations/{location_id}/clients/search',
    method: 'post',
    operationId: 'get_client_list',
    pathParams: ['location_id'],
    bodyParams: ['filters', 'operation', 'page', 'page_size', 'fields'],
  },
  clients_list_profiles: {
    path: '/clients/{location_id}',
    method: 'get',
    operationId: 'deprecated_get_client_list',
    pathParams: ['location_id'],
    queryParams: [
      'page',
      'count',
      'fullname',
      'phone',
      'email',
      'card',
      'id[]',
      'paid_min',
      'paid_max',
      'changed_after',
      'changed_before',
    ],
  },
  clients_get_card: {
    path: '/client/{location_id}/{id}',
    method: 'get',
    operationId: 'get_client',
    pathParams: ['location_id', 'id'],
  },
  clients_get_visit_history: {
    path: '/locations/{location_id}/clients/visits/search',
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
  locations_remove_user: {
    path: '/locations/{location_id}/users/{user_id}',
    method: 'delete',
    operationId: 'remove_user_from_location',
    pathParams: ['location_id', 'user_id'],
  },

  // ==========================================
  // Analytics — tools that call exactly one operation
  // ==========================================
  analytics_get_overview: {
    path: '/locations/{location_id}/analytics/overall',
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
  analytics_get_client_sales: {
    path: '/analytics_clients/clients_search/{location_id}/',
    method: 'get',
    operationId: 'get_legacy_client_sales_report',
    pathParams: ['location_id'],
    queryParams: ['start_date', 'end_date', 'page', 'editable_length'],
    source: 'extended',
  },
  analytics_get_client_retention: {
    path: '/analytics_retention/retention_search/{location_id}/',
    method: 'get',
    operationId: 'get_legacy_client_retention_report',
    pathParams: ['location_id'],
    queryParams: ['start_date', 'end_date', 'service_id'],
    source: 'extended',
  },
  analytics_get_client_forecast: {
    path: '/analytics/rfm/{location_id}/excel/clients',
    method: 'get',
    operationId: 'export_legacy_client_forecast',
    pathParams: ['location_id'],
    queryParams: ['prediction_date'],
    source: 'extended',
  },
  analytics_get_service_profitability: {
    path: '/analytics_services/services_search/{location_id}/',
    method: 'get',
    operationId: 'get_legacy_service_profitability_report',
    pathParams: ['location_id'],
    queryParams: [
      'start_date',
      'end_date',
      'master_id',
      'category_id',
      'detailing',
      'page',
      'editable_length',
    ],
    source: 'extended',
  },
  analytics_get_team_member_sales: {
    path: '/analytics_masters/masters_search/{location_id}/',
    method: 'get',
    operationId: 'get_legacy_team_member_sales_report',
    pathParams: ['location_id'],
    queryParams: [
      'start_date',
      'end_date',
      'services_ids[]',
      'groups_ids[]',
      'goods_ids[]',
      'goods_categories_ids[]',
      'position_ids[]',
    ],
    source: 'extended',
  },
  analytics_get_team_member_capacity: {
    path: '/analytics_workload/workload_search/{location_id}/',
    method: 'get',
    operationId: 'get_legacy_team_member_capacity_report',
    pathParams: ['location_id'],
    queryParams: ['start_date', 'end_date'],
    source: 'extended',
  },
  analytics_get_client_reactivation_candidates: {
    path: '/locations/{location_id}/clients/search',
    method: 'post',
    operationId: 'get_client_list',
    pathParams: ['location_id'],
    bodyParams: [
      'filters',
      'operation',
      'page',
      'page_size',
      'fields',
      'order_by',
      'order_by_direction',
    ],
  },
  analytics_get_group_event_performance: {
    path: '/dashboard/activities/{location_id}/search',
    method: 'get',
    operationId: 'get_legacy_group_event_performance_report',
    pathParams: ['location_id'],
    queryParams: [
      'start_date',
      'end_date',
      'page',
      'editable_length',
      'master',
      'service',
      'service_category',
      'category',
      'removed',
    ],
    source: 'extended',
  },
  analytics_get_product_sales: {
    path: '/storages/sales_analysis/search/{location_id}/',
    method: 'get',
    operationId: 'get_legacy_product_sales_report',
    pathParams: ['location_id'],
    queryParams: [
      'start_date',
      'end_date',
      'page',
      'editable_length',
      'category_id',
      'employee_id',
      'supplier_id',
    ],
    source: 'extended',
  },
  analytics_get_cash_flow_breakdown: {
    path: '/finances_reports/account_period_search/{location_id}/',
    method: 'get',
    operationId: 'get_legacy_cash_flow_breakdown_report',
    pathParams: ['location_id'],
    queryParams: [
      'start_date',
      'end_date',
      'accounts_ids[]',
      'master_id',
      'supplier_id',
      'type',
      'account_type',
      'services_ids[]',
      'goods_ids[]',
      'groups_ids[]',
      'goods_categories_ids[]',
      'movements_funds',
    ],
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
  // --- Memberships (V1 only: V2 has no membership operation) ---
  memberships_list_chains: {
    path: '/chains',
    method: 'get',
    operationId: 'get_chain_list',
    pathParams: [],
  },
  memberships_list_types: {
    path: '/chains/{chain_id}/loyalty/abonement_types',
    method: 'get',
    operationId: 'chain_loyalty_membership_types_list',
    pathParams: ['chain_id'],
    queryParams: ['title', 'is_archived', 'page', 'limit'],
  },
  memberships_get_type: {
    path: '/chains/{chain_id}/loyalty/abonement_types/{loyalty_membership_type_id}',
    method: 'get',
    operationId: 'chain_loyalty_membership_types_read',
    pathParams: ['chain_id', 'loyalty_membership_type_id'],
  },
  memberships_delete_type: {
    path: '/chains/{chain_id}/loyalty/abonement_types/{loyalty_membership_type_id}',
    method: 'delete',
    operationId: 'chain_loyalty_membership_types_delete',
    pathParams: ['chain_id', 'loyalty_membership_type_id'],
  },
  memberships_list: {
    path: '/chains/{chain_id}/loyalty/abonements',
    method: 'get',
    operationId: 'get_membership_list',
    pathParams: ['chain_id'],
    queryParams: [
      'abonements_ids',
      'created_after',
      'created_before',
      'page',
      'count',
    ],
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
  // Group events: reads that join two operations, and the updates that read
  // the current state first because the API replaces what it is sent.
  events_get: [
    {
      path: '/locations/{location_id}/events/{event_id}',
      method: 'get',
      operationId: 'get_event',
      pathParams: ['location_id', 'event_id'],
      queryParams: ['include'],
      spec: 'v2',
    },
    {
      path: '/locations/{location_id}/appointments',
      method: 'get',
      operationId: 'list_appointments',
      pathParams: ['location_id'],
      queryParams: ['filter[activity_id]', 'limit', 'include'],
      spec: 'v2',
    },
  ],
  events_list_dates: [
    {
      path: '/locations/{location_id}/events/dates',
      method: 'get',
      operationId: 'list_event_dates',
      pathParams: ['location_id'],
      queryParams: ['filter[from]', 'filter[to]'],
      spec: 'v2',
    },
    {
      path: '/locations/{location_id}/events/filters',
      method: 'get',
      operationId: 'list_event_filters',
      pathParams: ['location_id'],
      queryParams: ['filter[from]', 'filter[to]'],
      spec: 'v2',
    },
  ],
  events_update: [
    {
      path: '/locations/{location_id}/events/{event_id}',
      method: 'get',
      operationId: 'get_event',
      pathParams: ['location_id', 'event_id'],
      queryParams: ['include'],
      spec: 'v2',
    },
    {
      path: '/locations/{location_id}/events/{event_id}',
      method: 'put',
      operationId: 'update_event',
      pathParams: ['location_id', 'event_id'],
      queryParams: ['include'],
      bodyParams: [
        'staff_id',
        'service_id',
        'resource_instance_ids',
        'label_ids',
        'date',
        'length',
        'capacity',
        'technical_break_duration',
        'comment',
        'color',
        'instructions',
        'stream_link',
        'force',
      ],
      spec: 'v2',
    },
  ],
  events_update_duplication_strategy: [
    {
      path: '/locations/{location_id}/events/duplication_strategies',
      method: 'get',
      operationId: 'list_event_duplication_strategies_v2',
      pathParams: ['location_id'],
      spec: 'v2',
    },
    {
      path: '/locations/{location_id}/events/duplication_strategies/{strategy_id}',
      method: 'put',
      operationId: 'update_event_duplication_strategy_v2',
      pathParams: ['location_id', 'strategy_id'],
      bodyParams: [
        'title',
        'repeat_mode_id',
        'days',
        'interval',
        'content_type',
      ],
      spec: 'v2',
    },
  ],
  events_update_appointment: [
    {
      path: '/locations/{location_id}/appointments',
      method: 'get',
      operationId: 'list_appointments',
      pathParams: ['location_id'],
      queryParams: ['filter[activity_id]', 'limit', 'include'],
      spec: 'v2',
    },
    {
      path: '/locations/{location_id}/events/{event_id}/appointments/{record_id}',
      method: 'put',
      operationId: 'update_event_appointment',
      pathParams: ['location_id', 'event_id', 'record_id'],
      queryParams: ['include'],
      bodyParams: [
        'attendance_service_item',
        'label_ids',
        'clients_count',
        'comment',
        'color',
      ],
      spec: 'v2',
    },
  ],
  analytics_get_service_mix_trend: [
    {
      path: '/locations/{location_id}/appointments',
      method: 'get',
      operationId: 'get_appointment_list',
      pathParams: ['location_id'],
      queryParams: ['start_date', 'end_date', 'staff_id', 'page', 'count'],
    },
    {
      path: '/locations/{location_id}',
      method: 'get',
      operationId: 'get_location',
      pathParams: ['location_id'],
    },
    {
      path: '/services/{location_id}',
      method: 'get',
      operationId: 'get_service_list',
      pathParams: ['location_id'],
    },
    {
      path: '/service_categories/{location_id}/{id}',
      method: 'get',
      operationId: 'deprecated_get_service_category_list',
      pathParams: ['location_id', 'id'],
    },
    {
      path: '/resources/{location_id}',
      method: 'get',
      operationId: 'get_resource_list',
      pathParams: ['location_id'],
    },
  ],
  analytics_get_client_service_penetration: [
    {
      path: '/locations/{location_id}/appointments',
      method: 'get',
      operationId: 'get_appointment_list',
      pathParams: ['location_id'],
      queryParams: ['start_date', 'end_date', 'page', 'count'],
    },
    {
      path: '/locations/{location_id}',
      method: 'get',
      operationId: 'get_location',
      pathParams: ['location_id'],
    },
    {
      path: '/services/{location_id}',
      method: 'get',
      operationId: 'get_service_list',
      pathParams: ['location_id'],
    },
    {
      path: '/service_categories/{location_id}/{id}',
      method: 'get',
      operationId: 'deprecated_get_service_category_list',
      pathParams: ['location_id', 'id'],
    },
    {
      path: '/resources/{location_id}',
      method: 'get',
      operationId: 'get_resource_list',
      pathParams: ['location_id'],
    },
  ],
  // The optional Marketplace application read is a developers-contract route
  // (`docs/en/developers/openapi.yaml`), outside the B2B V1 spec this map is
  // checked against, so it is not listed here.
  locations_diagnose_access: [
    {
      path: '/locations/{location_id}',
      method: 'get',
      operationId: 'get_location',
      pathParams: ['location_id'],
    },
    {
      path: '/user/permissions/{location_id}',
      method: 'get',
      operationId: 'get_permission_list',
      pathParams: ['location_id'],
    },
  ],
  clients_get_membership_purchases: [
    {
      path: '/client/{location_id}/{id}',
      method: 'get',
      operationId: 'get_client',
      pathParams: ['location_id', 'id'],
    },
    {
      path: '/loyalty/abonements',
      method: 'get',
      operationId: 'get_client_memberships',
      pathParams: [],
      queryParams: ['company_id', 'phone'],
    },
    {
      path: '/locations/{location_id}/client/{client_id}/loyalty/abonements/{membership_id}/history',
      method: 'get',
      operationId: 'get_client_membership_activity_history',
      pathParams: ['location_id', 'client_id', 'membership_id'],
    },
    {
      path: '/storage_operations/goods_transactions/{location_id}/{transaction_id}',
      method: 'get',
      operationId: 'get_transaction',
      pathParams: ['location_id', 'transaction_id'],
    },
    {
      path: '/locations/{location_id}/sale/{document_id}',
      method: 'get',
      operationId: 'get_sale_transaction',
      pathParams: ['location_id', 'document_id'],
    },
  ],
  appointments_preview_attendance: [
    {
      path: '/locations/{location_id}/appointments/{record_id}',
      method: 'get',
      operationId: 'get_appointment',
      pathParams: ['location_id', 'record_id'],
    },
    {
      path: '/user/permissions/{location_id}',
      method: 'get',
      operationId: 'get_permission_list',
      pathParams: ['location_id'],
    },
  ],
  appointments_apply_attendance: [
    {
      path: '/locations/{location_id}/appointments/{record_id}',
      method: 'get',
      operationId: 'get_appointment',
      pathParams: ['location_id', 'record_id'],
    },
    {
      path: '/locations/{location_id}/appointments/{record_id}/attendance',
      method: 'post',
      operationId: 'update_appointment_attendance',
      pathParams: ['location_id', 'record_id'],
      bodyParams: ['attendance'],
    },
  ],
  analytics_get_product_sales: [
    {
      path: '/storages/sales_analysis/search/{location_id}/',
      method: 'get',
      operationId: 'get_legacy_product_sales_report',
      pathParams: ['location_id'],
      queryParams: [
        'start_date',
        'end_date',
        'page',
        'editable_length',
        'category_id',
        'employee_id',
        'supplier_id',
      ],
      source: 'extended',
    },
    {
      path: '/storages/sales_analysis/categories_search/{location_id}/',
      method: 'get',
      operationId: 'get_legacy_product_category_sales_report',
      pathParams: ['location_id'],
      queryParams: [
        'start_date',
        'end_date',
        'category_id',
        'employee_id',
        'supplier_id',
      ],
      source: 'extended',
    },
  ],
  analytics_get_profit_and_loss_statement: [
    {
      path: '/finances_reports/annual_report/{location_id}/',
      method: 'get',
      operationId: 'get_legacy_profit_and_loss_report',
      pathParams: ['location_id'],
      queryParams: ['date_from', 'date_to'],
      source: 'extended',
    },
    {
      path: '/reports/z_report/{location_id}',
      method: 'get',
      operationId: 'get_day_end_report_data',
      pathParams: ['location_id'],
      queryParams: ['start_date', 'end_date'],
    },
    {
      path: '/analytics_services/services_search/{location_id}/',
      method: 'get',
      operationId: 'get_legacy_service_profitability_report',
      pathParams: ['location_id'],
      queryParams: ['start_date', 'end_date', 'page', 'editable_length'],
      source: 'extended',
    },
  ],
  analytics_get_client_cash_receipts: [
    {
      path: '/user/permissions/{location_id}',
      method: 'get',
      operationId: 'get_permission_list',
      pathParams: ['location_id'],
    },
    {
      path: '/finances_reports/annual_report/{location_id}/',
      method: 'get',
      operationId: 'get_legacy_profit_and_loss_report',
      pathParams: ['location_id'],
      queryParams: ['date_from', 'date_to'],
      source: 'extended',
    },
  ],
  analytics_get_client_payer_cohorts: [
    {
      path: '/user/permissions/{location_id}',
      method: 'get',
      operationId: 'get_permission_list',
      pathParams: ['location_id'],
    },
    {
      path: '/finances_reports/annual_report/{location_id}/',
      method: 'get',
      operationId: 'get_legacy_profit_and_loss_report',
      pathParams: ['location_id'],
      queryParams: ['date_from', 'date_to'],
      source: 'extended',
    },
    {
      path: '/finances/transactions_search/{location_id}/',
      method: 'get',
      operationId: 'get_legacy_finance_transaction_list',
      pathParams: ['location_id'],
      queryParams: [
        'start_date',
        'end_date',
        'type',
        'page',
        'editable_length',
      ],
      source: 'extended',
    },
    {
      path: '/finance_transactions/{location_id}/{transaction_id}',
      method: 'get',
      operationId: 'get_financial_transaction',
      pathParams: ['location_id', 'transaction_id'],
    },
  ],
  analytics_get_capacity_heatmap: [
    {
      path: '/locations/{location_id}/team_members/schedule',
      method: 'get',
      operationId: 'get_team_member_schedule_list',
      pathParams: ['location_id'],
      queryParams: ['start_date', 'end_date', 'staff_ids', 'include'],
    },
    {
      path: '/locations/{location_id}/appointments',
      method: 'get',
      operationId: 'get_appointment_list',
      pathParams: ['location_id'],
      queryParams: [
        'start_date',
        'end_date',
        'page',
        'count',
        'with_deleted',
        'include_finance_transactions',
      ],
    },
  ],
  analytics_get_revenue_leakage: [
    {
      path: '/locations/{location_id}/appointments',
      method: 'get',
      operationId: 'get_appointment_list',
      pathParams: ['location_id'],
      queryParams: [
        'start_date',
        'end_date',
        'page',
        'count',
        'with_deleted',
        'include_finance_transactions',
      ],
    },
    {
      path: '/locations/{location_id}/team_members/schedule',
      method: 'get',
      operationId: 'get_team_member_schedule_list',
      pathParams: ['location_id'],
      queryParams: ['start_date', 'end_date', 'staff_ids', 'include'],
    },
    {
      path: '/services/{location_id}',
      method: 'get',
      operationId: 'get_service_list',
      pathParams: ['location_id'],
    },
  ],
  analytics_get_team_member_service_matrix: [
    {
      path: '/analytics_services/services_search/{location_id}/',
      method: 'get',
      operationId: 'get_legacy_service_profitability_report',
      pathParams: ['location_id'],
      queryParams: [
        'start_date',
        'end_date',
        'master_id',
        'category_id',
        'page',
        'editable_length',
      ],
      source: 'extended',
    },
  ],
  analytics_get_inventory_reorder_risks: [
    {
      path: '/storages/turnover/search/{location_id}/',
      method: 'get',
      operationId: 'get_legacy_inventory_turnover_report',
      pathParams: ['location_id'],
      queryParams: [
        'start_date',
        'end_date',
        'storage_id',
        'category_id',
        'supplier_id',
        'page',
        'editable_length',
      ],
      source: 'extended',
    },
  ],
  analytics_get_daily_series: [
    {
      path: '/locations/{location_id}/analytics/overall/charts/income_daily',
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
      path: '/locations/{location_id}/analytics/overall/charts/records_daily',
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
      path: '/locations/{location_id}/analytics/overall/charts/fullness_daily',
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
      path: '/locations/{location_id}/analytics/overall',
      method: 'get',
      operationId: 'get_location_analytics_overall',
      pathParams: ['location_id'],
      queryParams: ['date_from', 'date_to'],
    },
  ],
  analytics_get_appointments_breakdown: [
    {
      path: '/locations/{location_id}/analytics/overall/charts/record_source',
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
      path: '/locations/{location_id}/analytics/overall/charts/record_status',
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
      path: '/locations/{location_id}/analytics/loyalty_programs/visits',
      method: 'get',
      operationId: 'get_loyalty_program_client_statistics',
      pathParams: ['location_id'],
      queryParams: ['loyalty_program_id', 'date_from', 'date_to'],
    },
    {
      path: '/locations/{location_id}/analytics/loyalty_programs/income',
      method: 'get',
      operationId: 'get_loyalty_program_revenue_statistics',
      pathParams: ['location_id'],
      queryParams: ['loyalty_program_id', 'date_from', 'date_to'],
    },
    {
      path: '/locations/{location_id}/analytics/loyalty_programs/team_members',
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
      path: '/company/{location_id}/analytics_constructor/reports',
      method: 'get',
      operationId: 'list_report_builder_reports',
      pathParams: ['location_id'],
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
  // --- Memberships: tools that read before or after they write ---
  memberships_create_type: [
    {
      path: '/chains/{chain_id}/loyalty/abonement_types',
      method: 'post',
      operationId: 'chain_loyalty_membership_types_create',
      pathParams: ['chain_id'],
      bodyParams: [
        'title',
        'chain_id',
        'cost',
        'location_ids',
        'period',
        'period_unit_id',
        'expiration_type_id',
        'autoactivation_period',
        'autoactivation_time_unit_id',
        'is_allow_empty_code',
        'is_united_balance',
        'is_united_balance_unlimited',
        'united_balance_services_count',
        'services',
        'service_categories',
        'service_links',
        'allow_freeze',
        'freeze_limit',
        'freeze_limit_unit_id',
        'is_booking_when_frozen_allowed',
        'service_price_correction',
        'balance_edit_type_id',
        'is_online_sale_enabled',
        'online_sale_title',
        'online_sale_price',
        'online_sale_description',
        'category_id',
        'availability',
        'category',
      ],
    },
    {
      path: '/chains/{chain_id}/loyalty/abonement_types/{loyalty_membership_type_id}',
      method: 'put',
      operationId: 'chain_loyalty_membership_types_update',
      pathParams: ['chain_id', 'loyalty_membership_type_id'],
      bodyParams: [
        'title',
        'chain_id',
        'cost',
        'location_ids',
        'period',
        'period_unit_id',
        'expiration_type_id',
        'autoactivation_period',
        'autoactivation_time_unit_id',
        'is_allow_empty_code',
        'is_united_balance',
        'is_united_balance_unlimited',
        'united_balance_services_count',
        'services',
        'service_categories',
        'service_links',
        'allow_freeze',
        'freeze_limit',
        'freeze_limit_unit_id',
        'is_booking_when_frozen_allowed',
        'service_price_correction',
        'balance_edit_type_id',
        'is_online_sale_enabled',
        'online_sale_title',
        'online_sale_price',
        'online_sale_description',
        'category_id',
        'availability',
        'category',
      ],
    },
  ],
  memberships_update_type: [
    {
      path: '/chains/{chain_id}/loyalty/abonement_types/{loyalty_membership_type_id}',
      method: 'get',
      operationId: 'chain_loyalty_membership_types_read',
      pathParams: ['chain_id', 'loyalty_membership_type_id'],
    },
    {
      path: '/chains/{chain_id}/loyalty/abonement_types/{loyalty_membership_type_id}',
      method: 'put',
      operationId: 'chain_loyalty_membership_types_update',
      pathParams: ['chain_id', 'loyalty_membership_type_id'],
      bodyParams: [
        'title',
        'chain_id',
        'cost',
        'location_ids',
        'period',
        'period_unit_id',
        'expiration_type_id',
        'autoactivation_period',
        'autoactivation_time_unit_id',
        'is_allow_empty_code',
        'is_united_balance',
        'is_united_balance_unlimited',
        'united_balance_services_count',
        'services',
        'service_categories',
        'service_links',
        'allow_freeze',
        'freeze_limit',
        'freeze_limit_unit_id',
        'is_booking_when_frozen_allowed',
        'service_price_correction',
        'balance_edit_type_id',
        'is_online_sale_enabled',
        'online_sale_title',
        'online_sale_price',
        'online_sale_description',
        'category_id',
        'availability',
        'category',
      ],
    },
  ],
  memberships_archive_type: [
    {
      path: '/chains/{chain_id}/loyalty/abonement_types/{loyalty_membership_type_id}',
      method: 'get',
      operationId: 'chain_loyalty_membership_types_read',
      pathParams: ['chain_id', 'loyalty_membership_type_id'],
    },
    {
      path: '/chains/{chain_id}/loyalty/abonement_types/{loyalty_membership_type_id}',
      method: 'patch',
      operationId: 'chain_loyalty_membership_types_archive',
      pathParams: ['chain_id', 'loyalty_membership_type_id'],
      bodyParams: ['is_archived'],
    },
  ],
  memberships_list_for_client: [
    {
      path: '/client/{location_id}/{id}',
      method: 'get',
      operationId: 'get_client',
      pathParams: ['location_id', 'id'],
    },
    {
      path: '/loyalty/abonements',
      method: 'get',
      operationId: 'get_client_memberships',
      pathParams: [],
      queryParams: ['location_id', 'phone', 'chain_id'],
    },
  ],
  memberships_freeze: [
    {
      path: '/chains/{chain_id}/loyalty/abonements/{membership_id}/freeze',
      method: 'post',
      operationId: 'chain_loyalty_memberships_freeze',
      pathParams: ['chain_id', 'membership_id'],
      bodyParams: ['freeze_till'],
    },
    {
      path: '/chains/{chain_id}/loyalty/abonements',
      method: 'get',
      operationId: 'get_membership_list',
      pathParams: ['chain_id'],
      queryParams: [
        'abonements_ids',
        'created_after',
        'created_before',
        'page',
        'count',
      ],
    },
  ],
  memberships_unfreeze: [
    {
      path: '/chains/{chain_id}/loyalty/abonements/{membership_id}/unfreeze',
      method: 'post',
      operationId: 'chain_loyalty_memberships_unfreeze',
      pathParams: ['chain_id', 'membership_id'],
    },
    {
      path: '/chains/{chain_id}/loyalty/abonements',
      method: 'get',
      operationId: 'get_membership_list',
      pathParams: ['chain_id'],
      queryParams: [
        'abonements_ids',
        'created_after',
        'created_before',
        'page',
        'count',
      ],
    },
  ],
  memberships_set_balance: [
    {
      path: '/chains/{chain_id}/loyalty/abonements',
      method: 'get',
      operationId: 'get_membership_list',
      pathParams: ['chain_id'],
      queryParams: [
        'abonements_ids',
        'created_after',
        'created_before',
        'page',
        'count',
      ],
    },
    {
      path: '/chains/{chain_id}/loyalty/abonements/{membership_id}/set_balance',
      method: 'post',
      operationId: 'chain_loyalty_memberships_set_balance',
      pathParams: ['chain_id', 'membership_id'],
      bodyParams: ['united_balance_services_count', 'services_balance_count'],
    },
  ],
  memberships_set_validity: [
    {
      path: '/chains/{chain_id}/loyalty/abonements/{membership_id}/set_period',
      method: 'post',
      operationId: 'chain_loyalty_memberships_set_period',
      pathParams: ['chain_id', 'membership_id'],
      bodyParams: ['period', 'period_unit_id'],
    },
    {
      path: '/chains/{chain_id}/loyalty/abonements',
      method: 'get',
      operationId: 'get_membership_list',
      pathParams: ['chain_id'],
      queryParams: [
        'abonements_ids',
        'created_after',
        'created_before',
        'page',
        'count',
      ],
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
  'auth_logout',
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
  'onboarding_add_team_members_batch',
  'onboarding_add_services_batch',
  'onboarding_add_categories',
  'onboarding_import_clients',
  'onboarding_create_test_appointments',
  'onboarding_preview_data',
  'onboarding_rollback_phase',
];
