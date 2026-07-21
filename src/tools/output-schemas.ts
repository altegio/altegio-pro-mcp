/**
 * JSON Schema definitions for structured tool output (MCP spec 2025-06-18+).
 * Each schema describes the shape of `structuredContent` returned by a tool.
 */

// Reusable property definitions
const idProp = { type: 'number' as const };
const strProp = { type: 'string' as const };
const numProp = { type: 'number' as const };
const boolProp = { type: 'boolean' as const };

function listSchema(
  itemProps: Record<string, object>,
  itemRequired?: string[]
) {
  return {
    type: 'object' as const,
    properties: {
      items: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: itemProps,
          ...(itemRequired ? { required: itemRequired } : {}),
        },
      },
      count: numProp,
    },
    required: ['items', 'count'],
  };
}

function entitySchema(props: Record<string, object>, required?: string[]) {
  return {
    type: 'object' as const,
    properties: props,
    ...(required ? { required } : {}),
  };
}

// ========== Auth ==========

export const loginOutput = entitySchema({ success: boolProp, error: strProp }, [
  'success',
]);

// ========== Lists (GET) ==========

export const companiesOutput = listSchema(
  { id: idProp, title: strProp, address: strProp, phone: strProp },
  ['id']
);

export const bookingsOutput = listSchema(
  {
    id: idProp,
    datetime: strProp,
    date: strProp,
    status: strProp,
    team_member_id: idProp,
    team_member_name: strProp,
    client_name: strProp,
    client_phone: strProp,
    services: { type: 'array' as const, items: { type: 'object' as const } },
  },
  ['id']
);

export const staffListOutput = listSchema(
  {
    id: idProp,
    name: strProp,
    specialization: strProp,
    rating: numProp,
    position_id: numProp,
    position_title: strProp,
    hidden: numProp,
    fired: numProp,
  },
  ['id', 'name']
);

export const servicesOutput = listSchema(
  {
    id: idProp,
    title: strProp,
    cost: strProp,
    duration: numProp,
    category_id: numProp,
    active: numProp,
    discount: numProp,
  },
  ['id', 'title']
);

export const categoriesOutput = listSchema({ id: idProp, title: strProp }, [
  'id',
  'title',
]);

export const positionsOutput = listSchema(
  { id: idProp, title: strProp, api_id: strProp },
  ['id', 'title']
);

export const scheduleOutput = listSchema(
  { date: strProp, time: strProp, session_length: numProp },
  ['date']
);

// ========== Single entity (CREATE/UPDATE) ==========

export const staffEntityOutput = entitySchema(
  { id: idProp, name: strProp, specialization: strProp },
  ['id', 'name']
);

export const serviceEntityOutput = entitySchema(
  { id: idProp, title: strProp, category_id: numProp },
  ['id', 'title']
);

export const positionEntityOutput = entitySchema(
  { id: idProp, title: strProp },
  ['id', 'title']
);

export const scheduleEntityOutput = listSchema(
  { date: strProp, time: strProp, session_length: numProp },
  ['date']
);

export const bookingEntityOutput = entitySchema(
  { id: idProp, team_member_id: numProp, datetime: strProp, date: strProp },
  ['id']
);

// ========== Onboarding ==========

export const onboardingStatusOutput = entitySchema(
  {
    location_id: numProp,
    phase: numProp,
    completed: boolProp,
    entity_counts: {
      type: 'object' as const,
      properties: {
        staff: numProp,
        services: numProp,
        categories: numProp,
        clients: numProp,
        appointments: numProp,
      },
    },
    created_at: strProp,
    updated_at: strProp,
  },
  ['location_id', 'phase']
);

export const batchImportOutput = entitySchema(
  {
    created: numProp,
    failed: numProp,
    errors: { type: 'array' as const, items: { type: 'string' as const } },
  },
  ['created', 'failed']
);

export const previewOutput = entitySchema(
  {
    total: numProp,
    fields: { type: 'array' as const, items: { type: 'string' as const } },
    preview: { type: 'array' as const, items: { type: 'object' as const } },
  },
  ['total', 'fields', 'preview']
);

// ========== Location Settings & Resources ==========

export const appointmentSettingsOutput = entitySchema(
  {
    appointment_type: numProp,
    group_event_max_seats: numProp,
    is_show_newsletter_agreement: boolProp,
    is_show_personal_data_processing_agreement: boolProp,
  },
  ['appointment_type', 'group_event_max_seats']
);

export const onlineSettingsOutput = entitySchema(
  {
    confirm_number: boolProp,
    any_team_member: boolProp,
    session_delay_step: numProp,
    online_group_event_max_seats: numProp,
  },
  [
    'confirm_number',
    'any_team_member',
    'session_delay_step',
    'online_group_event_max_seats',
  ]
);

export const bookingFormsOutput = listSchema(
  { id: idProp, title: strProp, is_default: boolProp },
  ['id', 'title']
);

export const bookingFormEntityOutput = entitySchema(
  { id: idProp, title: strProp },
  ['id', 'title']
);

export const resourcesOutput = listSchema({ id: idProp, title: strProp }, [
  'id',
  'title',
]);
