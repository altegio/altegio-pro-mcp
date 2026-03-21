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
}

/**
 * Maps each MCP tool to its corresponding OpenAPI endpoint.
 *
 * Onboarding tools are excluded — they orchestrate multiple API calls
 * and don't map 1:1 to spec endpoints.
 */
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
  // Companies
  // ==========================================
  list_companies: {
    path: '/companies',
    method: 'get',
    operationId: 'get_location_list',
    pathParams: [],
    queryParams: ['my', 'page', 'count'],
  },

  // ==========================================
  // Bookings (Appointments)
  // ==========================================
  get_bookings: {
    path: '/records/{location_id}',
    method: 'get',
    operationId: 'get_appointment_list',
    pathParams: ['location_id'],
    queryParams: ['page', 'count', 'start_date', 'end_date'],
  },
  create_booking: {
    path: '/records/{location_id}',
    method: 'post',
    operationId: 'create_appointment',
    pathParams: ['location_id'],
    bodyParams: ['staff_id', 'services', 'datetime', 'client'],
  },
  update_booking: {
    path: '/record/{location_id}/{record_id}',
    method: 'put',
    operationId: 'update_appointment',
    pathParams: ['location_id', 'record_id'],
    bodyParams: ['staff_id', 'services', 'datetime', 'client'],
  },
  delete_booking: {
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
    ],
  },
  update_staff: {
    path: '/staff/{location_id}/{team_member_id}',
    method: 'put',
    operationId: 'update_team_member',
    pathParams: ['location_id', 'team_member_id'],
    bodyParams: ['name', 'specialization', 'weight', 'information', 'api_id', 'hidden', 'fired', 'user_id'],
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
    bodyParams: ['title', 'category_id', 'price_min', 'price_max', 'discount', 'comment', 'duration', 'prepaid'],
  },
  update_service: {
    path: '/services/{location_id}/{service_id}',
    method: 'patch',
    operationId: 'patch_service',
    pathParams: ['location_id', 'service_id'],
    bodyParams: ['title', 'category_id', 'price_min', 'price_max', 'discount', 'comment', 'duration', 'active'],
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
  // update_position and delete_position use V1 endpoints not in current spec
  // They call /positions/{company_id}/{position_id} which aren't documented in V1 openapi.yaml

  // ==========================================
  // Schedule
  // ==========================================
  get_schedule: {
    path: '/schedule/{location_id}/{team_member_id}/{start_date}/{end_date}',
    method: 'get',
    operationId: 'get_team_member_schedule',
    pathParams: ['location_id', 'team_member_id', 'start_date', 'end_date'],
  },
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
};

/**
 * Tools that don't map to API endpoints (local operations or orchestrators).
 */
export const unmappedTools: string[] = [
  'altegio_logout',
  'update_position',
  'delete_position',
  'onboarding_start',
  'onboarding_resume',
  'onboarding_status',
  'onboarding_add_staff_batch',
  'onboarding_add_services_batch',
  'onboarding_add_categories',
  'onboarding_import_clients',
  'onboarding_create_test_bookings',
  'onboarding_preview_data',
  'onboarding_rollback_phase',
];
