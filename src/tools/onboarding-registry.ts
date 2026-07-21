import type { McpToolSpec } from './factory.js';
import * as output from './output-schemas.js';

export const onboardingTools: McpToolSpec[] = [
  {
    name: 'onboarding_start',
    description:
      '[Onboarding] Initialize new onboarding session for a location. Creates persistent state and guides through platform setup workflow.',
    annotations: {
      title: 'Start Onboarding',
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        location_id: {
          type: 'number',
          description: 'Location ID to start onboarding for',
        },
      },
      required: ['location_id'],
    },
    outputSchema: output.onboardingStatusOutput,
  },
  {
    name: 'onboarding_resume',
    description:
      '[Onboarding] Resume existing onboarding session and show progress. Displays completed phases and next steps.',
    annotations: {
      title: 'Resume Onboarding',
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'number', description: 'Location ID' },
      },
      required: ['location_id'],
    },
    outputSchema: output.onboardingStatusOutput,
  },
  {
    name: 'onboarding_status',
    description:
      'Show current onboarding status and progress. Returns phase, entity counts, and completion status.',
    annotations: {
      title: 'Onboarding Status',
      readOnlyHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'number', description: 'Location ID' },
      },
      required: ['location_id'],
    },
    outputSchema: output.onboardingStatusOutput,
  },
  {
    name: 'onboarding_add_positions',
    description:
      '[Onboarding] Bulk create staff positions/roles (e.g. Manager, Stylist, Receptionist) from a JSON array or CSV string. Create positions BEFORE staff so staff can reference position_id. Accepts title (required) and api_id. Creates checkpoint for rollback.',
    annotations: {
      title: 'Batch Add Positions',
      openWorldHint: true,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'number', description: 'Location ID' },
        positions: {
          description:
            'JSON array of position objects or CSV string with headers: title,api_id',
          oneOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  api_id: { type: 'string' },
                },
                required: ['title'],
              },
            },
            { type: 'string' },
          ],
        },
      },
      required: ['location_id', 'positions'],
    },
    outputSchema: output.batchImportOutput,
  },
  {
    name: 'onboarding_add_staff_batch',
    description:
      'Bulk add staff members from JSON array or CSV string. Accepts name, specialization, phone, email, position_id, api_id. Creates checkpoint for rollback.',
    annotations: {
      title: 'Batch Add Staff',
      openWorldHint: true,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'number', description: 'Location ID' },
        staff_data: {
          description:
            'JSON array of staff objects or CSV string with headers: name,specialization,phone,email,position_id,api_id',
          oneOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  specialization: { type: 'string' },
                  phone: { type: 'string' },
                  email: { type: 'string' },
                  position_id: { type: 'number' },
                  api_id: { type: 'string' },
                },
                required: ['name'],
              },
            },
            { type: 'string' },
          ],
        },
      },
      required: ['location_id', 'staff_data'],
    },
    outputSchema: output.batchImportOutput,
  },
  {
    name: 'onboarding_add_services_batch',
    description:
      'Bulk add services from JSON array or CSV string. Accepts title, price_min, price_max, duration, category_id, api_id. Creates checkpoint for rollback.',
    annotations: {
      title: 'Batch Add Services',
      openWorldHint: true,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'number', description: 'Location ID' },
        services_data: {
          description:
            'JSON array of service objects or CSV string with headers: title,price_min,price_max,duration,category_id,api_id',
          oneOf: [
            {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string' },
                  price_min: { type: 'number' },
                  price_max: { type: 'number' },
                  duration: { type: 'number' },
                  category_id: { type: 'number' },
                  api_id: { type: 'string' },
                },
                required: ['title', 'price_min', 'duration'],
              },
            },
            { type: 'string' },
          ],
        },
      },
      required: ['location_id', 'services_data'],
    },
    outputSchema: output.batchImportOutput,
  },
  {
    name: 'onboarding_set_schedules',
    description:
      '[Onboarding] Set work schedules (working hours) for staff members. AUTHENTICATION REQUIRED. Accepts an array of { team_member_id, dates[], slots[{from,to}] }. Use the team member IDs returned by onboarding_add_staff_batch. Without schedules the appointment grid stays empty. Creates checkpoint for rollback.',
    annotations: {
      title: 'Set Work Schedules',
      openWorldHint: true,
      idempotentHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'number', description: 'Location ID' },
        schedules: {
          type: 'array',
          description: 'Array of per-staff schedule entries',
          items: {
            type: 'object',
            properties: {
              team_member_id: {
                type: 'number',
                description: 'Team member ID',
              },
              dates: {
                type: 'array',
                items: { type: 'string' },
                description: 'Dates in YYYY-MM-DD format',
              },
              slots: {
                type: 'array',
                description: 'Working time intervals for each date',
                items: {
                  type: 'object',
                  properties: {
                    from: {
                      type: 'string',
                      description: 'Start time (HH:MM)',
                    },
                    to: { type: 'string', description: 'End time (HH:MM)' },
                  },
                  required: ['from', 'to'],
                },
              },
            },
            required: ['team_member_id', 'dates', 'slots'],
          },
        },
      },
      required: ['location_id', 'schedules'],
    },
    outputSchema: output.batchImportOutput,
  },
  {
    name: 'onboarding_add_categories',
    description:
      'Create service categories. Accepts JSON array of category objects with title, api_id, weight. Creates checkpoint for rollback.',
    annotations: {
      title: 'Add Categories',
      openWorldHint: true,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'number', description: 'Location ID' },
        categories: {
          type: 'array',
          description: 'Array of category objects',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Category title' },
              api_id: {
                type: 'string',
                description: 'Optional API identifier',
              },
              weight: { type: 'number', description: 'Sort order weight' },
            },
            required: ['title'],
          },
        },
      },
      required: ['location_id', 'categories'],
    },
    outputSchema: output.batchImportOutput,
  },
  {
    name: 'onboarding_import_clients',
    description:
      '[Onboarding] Import client database from CSV string. CSV must have headers: name,phone,email,surname,comment. Either phone or email is required. Creates checkpoint for rollback.',
    annotations: {
      title: 'Import Clients',
      openWorldHint: true,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'number', description: 'Location ID' },
        clients_csv: {
          type: 'string',
          description:
            'CSV string with headers: name,phone,email,surname,comment. Either phone or email required per row.',
        },
      },
      required: ['location_id', 'clients_csv'],
    },
    outputSchema: output.batchImportOutput,
  },
  {
    name: 'onboarding_create_test_appointments',
    description:
      'Generate test appointments using previously created staff and services. Distributes appointments across next 1-7 days. Marks onboarding as complete.',
    annotations: {
      title: 'Create Test Appointments',
      openWorldHint: true,
      idempotentHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'number', description: 'Location ID' },
        count: {
          type: 'number',
          description: 'Number of test appointments to create',
          minimum: 1,
          maximum: 10,
          default: 5,
        },
      },
      required: ['location_id'],
    },
    outputSchema: output.batchImportOutput,
  },
  {
    name: 'onboarding_preview_data',
    description:
      'Parse and preview CSV/data without creating entities. Shows first 5 rows, total count, and field names. Use before batch import to validate format.',
    annotations: {
      title: 'Preview Import Data',
      readOnlyHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        data_type: {
          type: 'string',
          description: 'Type of data to preview',
          enum: ['staff', 'services', 'clients', 'categories'],
        },
        raw_input: {
          type: 'string',
          description: 'CSV string or raw data to preview',
        },
      },
      required: ['data_type', 'raw_input'],
    },
    outputSchema: output.previewOutput,
  },
  {
    name: 'onboarding_rollback_phase',
    description:
      'Delete all entities from specific phase and reset checkpoint. Supports: positions, staff, categories, services, schedules, clients, test_appointments. WARNING: Destructive operation.',
    annotations: {
      title: 'Rollback Onboarding Phase',
      destructiveHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        location_id: { type: 'number', description: 'Location ID' },
        phase_name: {
          type: 'string',
          description:
            'Phase to rollback (positions, staff, categories, services, schedules, clients, test_appointments)',
        },
      },
      required: ['location_id', 'phase_name'],
    },
  },
];
