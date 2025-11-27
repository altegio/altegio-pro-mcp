interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, any>;
    required?: string[];
  };
}

export const onboardingTools: ToolDefinition[] = [
  {
    name: 'onboarding_start',
    description: '[Onboarding] Initialize new onboarding session for a company. Creates persistent state and guides through platform setup workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'number', description: 'Company ID to start onboarding for' }
      },
      required: ['company_id']
    }
  },
  {
    name: 'onboarding_resume',
    description: '[Onboarding] Resume existing onboarding session and show progress. Displays completed phases and next steps.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'number', description: 'Company ID' }
      },
      required: ['company_id']
    }
  },
  {
    name: 'onboarding_status',
    description: 'Show current onboarding status and progress. Returns phase, entity counts, and completion status.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'number', description: 'Company ID' }
      },
      required: ['company_id']
    }
  },
  {
    name: 'onboarding_add_staff_batch',
    description: 'Bulk add staff members from JSON array or CSV string. Accepts name, specialization, phone, email, position_id, api_id. Creates checkpoint for rollback.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'number', description: 'Company ID' },
        staff_data: {
          description: 'JSON array of staff objects or CSV string with headers: name,specialization,phone,email,position_id,api_id',
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
                  api_id: { type: 'string' }
                },
                required: ['name']
              }
            },
            { type: 'string' }
          ]
        }
      },
      required: ['company_id', 'staff_data']
    }
  },
  {
    name: 'onboarding_add_services_batch',
    description: 'Bulk add services from JSON array or CSV string. Accepts title, price_min, price_max, duration, category_id, api_id. Creates checkpoint for rollback.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'number', description: 'Company ID' },
        services_data: {
          description: 'JSON array of service objects or CSV string with headers: title,price_min,price_max,duration,category_id,api_id',
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
                  api_id: { type: 'string' }
                },
                required: ['title', 'price_min', 'duration']
              }
            },
            { type: 'string' }
          ]
        }
      },
      required: ['company_id', 'services_data']
    }
  },
  {
    name: 'onboarding_add_categories',
    description: 'Create service categories. Accepts JSON array of category objects with title, api_id, weight. Creates checkpoint for rollback.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'number', description: 'Company ID' },
        categories: {
          type: 'array',
          description: 'Array of category objects',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Category title' },
              api_id: { type: 'string', description: 'Optional API identifier' },
              weight: { type: 'number', description: 'Sort order weight' }
            },
            required: ['title']
          }
        }
      },
      required: ['company_id', 'categories']
    }
  },
  {
    name: 'onboarding_import_clients',
    description: '[Onboarding] Import client database from CSV string. CSV must have headers: name,phone,email,surname,comment. Either phone or email is required. Creates checkpoint for rollback.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'number', description: 'Company ID' },
        clients_csv: {
          type: 'string',
          description: 'CSV string with headers: name,phone,email,surname,comment. Either phone or email required per row.'
        }
      },
      required: ['company_id', 'clients_csv']
    }
  },
  {
    name: 'onboarding_create_test_bookings',
    description: 'Generate test bookings using previously created staff and services. Distributes bookings across next 1-7 days. Marks onboarding as complete.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'number', description: 'Company ID' },
        count: {
          type: 'number',
          description: 'Number of test bookings to create',
          minimum: 1,
          maximum: 10,
          default: 5
        }
      },
      required: ['company_id']
    }
  },
  {
    name: 'onboarding_preview_data',
    description: 'Parse and preview CSV/data without creating entities. Shows first 5 rows, total count, and field names. Use before batch import to validate format.',
    inputSchema: {
      type: 'object',
      properties: {
        data_type: {
          type: 'string',
          description: 'Type of data to preview',
          enum: ['staff', 'services', 'clients', 'categories']
        },
        raw_input: {
          type: 'string',
          description: 'CSV string or raw data to preview'
        }
      },
      required: ['data_type', 'raw_input']
    }
  },
  {
    name: 'onboarding_rollback_phase',
    description: 'Delete all entities from specific phase and reset checkpoint. Supports: staff, services, test_bookings, categories, clients. WARNING: Destructive operation.',
    inputSchema: {
      type: 'object',
      properties: {
        company_id: { type: 'number', description: 'Company ID' },
        phase_name: {
          type: 'string',
          description: 'Phase to rollback (staff, services, test_bookings, categories, clients)'
        }
      },
      required: ['company_id', 'phase_name']
    }
  }
];
