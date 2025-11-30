import { z } from 'zod';
import { defineTool } from '../factory.js';
import { parseCSV } from '../../utils/csv-parser.js';
import {
  StaffBatchSchema,
  ServiceBatchSchema
} from '../../types/onboarding.types.js';

export const onboardingStartTool = defineTool({
  name: 'onboarding_start',
  category: 'Onboarding',
  description: '[Onboarding] Initialize new onboarding session for a company. Creates persistent state and guides through platform setup workflow.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().describe('Company ID to start onboarding for')
  }),

  handler: async () => {
    // This will be replaced by a custom handler that has stateManager
    throw new Error('Onboarding tools require stateManager context');
  }
});

export const onboardingResumeTool = defineTool({
  name: 'onboarding_resume',
  category: 'Onboarding',
  description: '[Onboarding] Resume existing onboarding session and show progress. Displays completed phases and next steps.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().describe('Company ID')
  }),

  handler: async () => {
    throw new Error('Onboarding tools require stateManager context');
  }
});

export const onboardingStatusTool = defineTool({
  name: 'onboarding_status',
  category: 'Onboarding',
  description: 'Show current onboarding status and progress. Returns phase, entity counts, and completion status.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().describe('Company ID')
  }),

  handler: async () => {
    throw new Error('Onboarding tools require stateManager context');
  }
});

export const onboardingAddStaffBatchTool = defineTool({
  name: 'onboarding_add_staff_batch',
  category: 'Onboarding',
  description: 'Bulk add staff members from JSON array or CSV string. Accepts name, specialization, phone, email, position_id, api_id. Creates checkpoint for rollback.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().describe('Company ID'),
    staff_data: z.union([StaffBatchSchema, z.string()]).describe('JSON array of staff objects or CSV string with headers: name,specialization,phone,email,position_id,api_id')
  }),

  handler: async () => {
    throw new Error('Onboarding tools require stateManager context');
  }
});

export const onboardingAddServicesBatchTool = defineTool({
  name: 'onboarding_add_services_batch',
  category: 'Onboarding',
  description: 'Bulk add services from JSON array or CSV string. Accepts title, price_min, price_max, duration, category_id, api_id. Creates checkpoint for rollback.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().describe('Company ID'),
    services_data: z.union([ServiceBatchSchema, z.string()]).describe('JSON array of service objects or CSV string with headers: title,price_min,price_max,duration,category_id,api_id')
  }),

  handler: async () => {
    throw new Error('Onboarding tools require stateManager context');
  }
});

export const onboardingAddCategoriesTool = defineTool({
  name: 'onboarding_add_categories',
  category: 'Onboarding',
  description: 'Create service categories. Accepts JSON array of category objects with title, api_id, weight. Creates checkpoint for rollback.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().describe('Company ID'),
    categories: z.array(
      z.object({
        title: z.string().describe('Category title'),
        api_id: z.string().optional().describe('Optional API identifier'),
        weight: z.number().optional().describe('Sort order weight')
      })
    ).describe('Array of category objects')
  }),

  handler: async () => {
    throw new Error('Onboarding tools require stateManager context');
  }
});

export const onboardingImportClientsTool = defineTool({
  name: 'onboarding_import_clients',
  category: 'Onboarding',
  description: '[Onboarding] Import client database from CSV string. CSV must have headers: name,phone,email,surname,comment. Either phone or email is required. Creates checkpoint for rollback.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().describe('Company ID'),
    clients_csv: z.string().describe('CSV string with headers: name,phone,email,surname,comment. Either phone or email required per row.')
  }),

  handler: async () => {
    throw new Error('Onboarding tools require stateManager context');
  }
});

export const onboardingCreateTestBookingsTool = defineTool({
  name: 'onboarding_create_test_bookings',
  category: 'Onboarding',
  description: 'Generate test bookings using previously created staff and services. Distributes bookings across next 1-7 days. Marks onboarding as complete.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().describe('Company ID'),
    count: z.number().min(1).max(10).default(5).describe('Number of test bookings to create')
  }),

  handler: async () => {
    throw new Error('Onboarding tools require stateManager context');
  }
});

export const onboardingPreviewDataTool = defineTool({
  name: 'onboarding_preview_data',
  category: 'Onboarding',
  description: 'Parse and preview CSV/data without creating entities. Shows first 5 rows, total count, and field names. Use before batch import to validate format.',
  requiresAuth: false, // No auth needed for preview

  input: z.object({
    data_type: z.enum(['staff', 'services', 'clients', 'categories']).describe('Type of data to preview'),
    raw_input: z.string().describe('CSV string or raw data to preview')
  }),

  handler: async ({ input }) => {
    const { data_type, raw_input } = input;

    // Try to parse as JSON first, fall back to CSV
    let parsed;
    try {
      const jsonData = JSON.parse(raw_input);
      parsed = Array.isArray(jsonData) ? jsonData : [jsonData];
    } catch {
      parsed = parseCSV(raw_input);
    }

    if (parsed.length === 0 || !parsed[0]) {
      return 'No data parsed. Check CSV format or JSON structure.';
    }

    const preview = parsed.slice(0, 5).map((row, idx) =>
      `${idx + 1}. ${Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(', ')}`
    ).join('\n');

    const fieldCount = Object.keys(parsed[0]).length;

    return `Preview of ${data_type} data:\n\n` +
           `Total rows: ${parsed.length}\n` +
           `Fields: ${fieldCount} (${Object.keys(parsed[0]).join(', ')})\n\n` +
           `First ${Math.min(5, parsed.length)} rows:\n${preview}\n\n` +
           `Proceed with onboarding_add_${data_type}_batch to create entities.`;
  }
});

export const onboardingRollbackPhaseTool = defineTool({
  name: 'onboarding_rollback_phase',
  category: 'Onboarding',
  description: 'Delete all entities from specific phase and reset checkpoint. Supports: staff, services, test_bookings, categories, clients. WARNING: Destructive operation.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().describe('Company ID'),
    phase_name: z.string().describe('Phase to rollback (staff, services, test_bookings, categories, clients)')
  }),

  handler: async () => {
    throw new Error('Onboarding tools require stateManager context');
  }
});

// Export all onboarding tools as an array for easy registration
export const onboardingTools = [
  onboardingStartTool,
  onboardingResumeTool,
  onboardingStatusTool,
  onboardingAddStaffBatchTool,
  onboardingAddServicesBatchTool,
  onboardingAddCategoriesTool,
  onboardingImportClientsTool,
  onboardingCreateTestBookingsTool,
  onboardingPreviewDataTool,
  onboardingRollbackPhaseTool
];
