import { z } from 'zod';
import { defineTool } from '../factory.js';
import { formatCategoriesList } from '../formatters.js';

export const getServiceCategoriesTool = defineTool({
  name: 'get_service_categories',
  category: 'Categories',
  description:
    '[Categories] Get service categories for a company. PUBLIC ENDPOINT (no auth required).',
  requiresAuth: false,

  input: z.object({
    company_id: z.number().int().positive().describe('Company ID'),
    page: z.number().int().positive().optional().describe('Page number'),
    count: z.number().int().positive().optional().describe('Results per page'),
  }),

  handler: async ({ input, client }) => {
    const { company_id, ...params } = input;
    const categories = await client.getServiceCategories(company_id, params);
    return formatCategoriesList(categories, company_id);
  },
});
