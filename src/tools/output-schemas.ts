/**
 * JSON Schema definitions for structured tool output (MCP spec 2025-06-18+).
 * Each schema describes the shape of `structuredContent` returned by a tool.
 */

// Reusable property definitions
const idProp = { type: 'number' as const };
const strProp = { type: 'string' as const };
const numProp = { type: 'number' as const };
const boolProp = { type: 'boolean' as const };
const nullableStrProp = { type: ['string', 'null'] as const };
const nullableNumProp = { type: ['number', 'null'] as const };
const nullableBoolProp = { type: ['boolean', 'null'] as const };

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

export const companyEntityOutput = entitySchema(
  { id: idProp, title: strProp, city: strProp, address: strProp },
  ['id']
);

export const locationUpdateOutput = entitySchema(
  {
    id: idProp,
    title: nullableStrProp,
    city: nullableStrProp,
    address: nullableStrProp,
    phones: {
      type: ['array', 'null'] as const,
      items: strProp,
    },
    verification_source: strProp,
    requested_fields: {
      type: 'array' as const,
      items: strProp,
    },
    verified_fields: {
      type: 'array' as const,
      items: strProp,
    },
    unconfirmed_fields: {
      type: 'array' as const,
      items: strProp,
    },
    verification_error: nullableStrProp,
  },
  [
    'id',
    'verification_source',
    'requested_fields',
    'verified_fields',
    'unconfirmed_fields',
  ]
);

export const bookingsOutput = listSchema(
  {
    id: idProp,
    location_id: idProp,
    datetime: nullableStrProp,
    date: nullableStrProp,
    status: strProp,
    team_member_id: nullableNumProp,
    team_member_name: nullableStrProp,
    client_id: nullableNumProp,
    client_name: nullableStrProp,
    client_phone: nullableStrProp,
    services: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          id: idProp,
          title: strProp,
          cost: nullableNumProp,
          amount: nullableNumProp,
        },
        required: ['id', 'title'],
      },
    },
    total_cost: nullableNumProp,
    duration_seconds: nullableNumProp,
    visit_id: nullableNumProp,
    paid_in_full: nullableBoolProp,
    prepaid: nullableBoolProp,
    online: nullableBoolProp,
    comment: nullableStrProp,
    deleted: boolProp,
  },
  ['id', 'status', 'services', 'deleted']
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
    price_min: nullableNumProp,
    price_max: nullableNumProp,
    duration_seconds: nullableNumProp,
    category_id: nullableNumProp,
    active: nullableBoolProp,
    discount: nullableNumProp,
    comment: nullableStrProp,
    team_members: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          team_member_id: idProp,
          session_length_seconds: numProp,
          technological_card_id: nullableNumProp,
        },
        required: ['team_member_id', 'session_length_seconds'],
      },
    },
  },
  ['id', 'title', 'team_members']
);

export const categoriesOutput = listSchema({ id: idProp, title: strProp }, [
  'id',
  'title',
]);

export const positionsOutput = listSchema({ id: idProp, title: strProp }, [
  'id',
  'title',
]);

const slotsProp = {
  type: 'array' as const,
  items: {
    type: 'object' as const,
    properties: { from: strProp, to: strProp },
  },
};

export const scheduleOutput = listSchema(
  {
    date: strProp,
    time: strProp,
    session_length: numProp,
    slots: slotsProp,
    is_working: boolProp,
  },
  ['date']
);

// ========== Single entity (CREATE/UPDATE) ==========

export const staffEntityOutput = entitySchema(
  { id: idProp, name: strProp, specialization: strProp },
  ['id', 'name']
);

export const serviceEntityOutput = entitySchema(
  {
    id: idProp,
    title: strProp,
    category_id: nullableNumProp,
    price_min: nullableNumProp,
    price_max: nullableNumProp,
    duration_seconds: nullableNumProp,
    active: nullableBoolProp,
    team_members: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          team_member_id: idProp,
          session_length_seconds: numProp,
          technological_card_id: nullableNumProp,
        },
        required: ['team_member_id', 'session_length_seconds'],
      },
    },
  },
  ['id', 'title']
);

export const positionEntityOutput = entitySchema(
  { id: idProp, title: strProp },
  ['id', 'title']
);

export const scheduleEntityOutput = listSchema(
  {
    date: strProp,
    time: strProp,
    session_length: numProp,
    slots: slotsProp,
    is_working: boolProp,
  },
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
