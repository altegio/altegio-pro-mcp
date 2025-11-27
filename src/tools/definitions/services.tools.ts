import { z } from 'zod';
import { defineTool } from '../factory.js';
import { formatServicesList } from '../formatters.js';

export const getServicesTool = defineTool({
  name: 'get_services',
  category: 'Services',
  description:
    '[Services] Get list of services for a company. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    page: z.number().int().positive().optional().describe('Page number'),
    count: z.number().int().positive().optional().describe('Results per page'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, ...params } = input;
    const services = await client.getServices(company_id, params);
    return formatServicesList(services, company_id);
  },
});

export const createServiceTool = defineTool({
  name: 'create_service',
  category: 'Services',
  description: '[Services] Create a new service. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    title: z.string().min(1).describe('Service title'),
    category_id: z.number().int().positive().describe('Service category ID'),
    price_min: z.number().nonnegative().optional().describe('Minimum price'),
    price_max: z.number().nonnegative().optional().describe('Maximum price'),
    discount: z.number().nonnegative().optional().describe('Discount amount'),
    comment: z.string().optional().describe('Service description/comment'),
    duration: z.number().positive().optional().describe('Duration in minutes'),
    prepaid: z.string().optional().describe('Prepaid settings'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, ...serviceData } = input;
    const service = await client.createService(company_id, serviceData);
    return `Successfully created service:\nID: ${service.id}\nTitle: ${service.title}\nCategory: ${service.category_id}`;
  },
});

export const updateServiceTool = defineTool({
  name: 'update_service',
  category: 'Services',
  description: '[Services] Update existing service. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

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
    discount: z.number().nonnegative().optional().describe('Discount amount'),
    comment: z.string().optional().describe('Service description/comment'),
    duration: z.number().positive().optional().describe('Duration in minutes'),
    active: z
      .number()
      .int()
      .min(0)
      .max(1)
      .optional()
      .describe('Active status (0/1)'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, service_id, ...updateData } = input;
    const service = await client.updateService(
      company_id,
      service_id,
      updateData
    );
    return `Successfully updated service ${service_id}:\nTitle: ${service.title}`;
  },
});
