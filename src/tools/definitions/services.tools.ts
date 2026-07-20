import { z } from 'zod';
import { defineTool } from '../factory.js';
import { servicesOutput, serviceEntityOutput } from '../output-schemas.js';

export const getServicesTool = defineTool({
  name: 'get_services',
  category: 'Services',
  description:
    '[Services] Get list of services available at a company. AUTHENTICATION REQUIRED - administrative access to view all services with full pricing, settings, and configuration (not just public booking info). User must be logged in and have access to the company. PAGINATION STRATEGY: May return many services (50+). RECOMMENDED: Start with count=30-50 to show main services. User can request more or use categories for better organization.',
  annotations: {
    title: 'Get Services',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    company_id: z
      .number()
      .int()
      .positive()
      .describe('ID of the company to get services for'),
    page: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Page number for pagination (starts at 0). Use to fetch subsequent pages when user needs more results.'
      ),
    count: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Results per page. Default may be large. RECOMMENDED: Use 30-50 for initial display. Max 300.'
      ),
  }),
  outputSchema: servicesOutput,
  handler: async ({ input, client }) => {
    const { company_id, ...listParams } = input;
    const services = await client.getServices(
      company_id,
      Object.keys(listParams).length > 0 ? listParams : undefined
    );

    const summary = `Found ${services.length} ${services.length === 1 ? 'service' : 'services'} for company ${company_id}:\n\n`;
    const servicesList = services
      .map(
        (s, idx) =>
          `${idx + 1}. ID: ${s.id} - "${s.title}"\n` +
          `   Price: ${s.cost}${s.duration ? `\n   Duration: ${s.duration} min` : ''}${s.category_id ? `\n   Category ID: ${s.category_id}` : ''}`
      )
      .join('\n\n');

    return {
      text: summary + servicesList,
      structuredContent: { items: services, count: services.length },
    };
  },
});

export const createServiceTool = defineTool({
  name: 'create_service',
  category: 'Services',
  description:
    '[Services] Create a new service. AUTHENTICATION REQUIRED. Required fields: title, category_id.',
  annotations: {
    title: 'Create Service',
    openWorldHint: true,
    idempotentHint: false,
  },
  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    title: z.string().min(1).describe('Service title'),
    category_id: z.number().int().positive().describe('Service category ID'),
    price_min: z.number().nonnegative().optional().describe('Minimum price'),
    price_max: z.number().nonnegative().optional().describe('Maximum price'),
    discount: z
      .number()
      .nonnegative()
      .optional()
      .describe('Discount percentage'),
    comment: z.string().optional().describe('Service description'),
    duration: z.number().positive().optional().describe('Duration in seconds'),
    prepaid: z.string().optional().describe('Prepaid option'),
  }),
  outputSchema: serviceEntityOutput,
  handler: async ({ input, client }) => {
    const { company_id, ...serviceData } = input;
    const service = await client.createService(company_id, serviceData);
    return {
      text: `Successfully created service:\nID: ${service.id}\nTitle: ${service.title}\nCategory: ${service.category_id}`,
      structuredContent: {
        id: service.id,
        title: service.title,
        category_id: service.category_id,
      },
    };
  },
});

export const updateServiceTool = defineTool({
  name: 'update_service',
  category: 'Services',
  description:
    '[Services] Update existing service. AUTHENTICATION REQUIRED. Provide only fields to update.',
  annotations: {
    title: 'Update Service',
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    service_id: z.number().int().positive().describe('Service ID'),
    title: z.string().min(1).optional().describe('Service title'),
    category_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Service category ID'),
    price_min: z.number().nonnegative().optional().describe('Minimum price'),
    price_max: z.number().nonnegative().optional().describe('Maximum price'),
    discount: z
      .number()
      .nonnegative()
      .optional()
      .describe('Discount percentage'),
    comment: z.string().optional().describe('Service description'),
    duration: z.number().positive().optional().describe('Duration in seconds'),
    active: z.number().int().min(0).max(1).optional().describe('0 or 1'),
  }),
  outputSchema: serviceEntityOutput,
  handler: async ({ input, client }) => {
    const { company_id, service_id, ...updateData } = input;
    const service = await client.updateService(
      company_id,
      service_id,
      updateData
    );
    return {
      text: `Successfully updated service ${service_id}:\nTitle: ${service.title}`,
      structuredContent: {
        id: service.id,
        title: service.title,
        category_id: service.category_id,
      },
    };
  },
});
