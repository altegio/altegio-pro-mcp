import { z } from 'zod';
import { defineTool } from '../factory.js';
import { formatCompaniesList } from '../formatters.js';

export const listCompaniesTool = defineTool({
  name: 'list_companies',
  category: 'Company',
  description:
    '[Company] List companies accessible to the authenticated user. AUTHENTICATION REQUIRED.',
  requiresAuth: true,

  input: z.object({
    my: z
      .number()
      .int()
      .min(0)
      .max(1)
      .optional()
      .describe('Filter: 1 for user companies only, 0 or omit for all'),
    page: z.number().int().positive().optional().describe('Page number'),
    count: z.number().int().positive().optional().describe('Results per page'),
  }),

  handler: async ({ input, client }) => {
    const companies = await client.getCompanies(input);
    return formatCompaniesList(companies, input.my === 1);
  },
});
