import { z } from 'zod';
import { defineTool } from '../factory.js';
import { companiesOutput } from '../output-schemas.js';

export const listCompaniesTool = defineTool({
  name: 'list_companies',
  category: 'Company',
  description:
    '[Company] Get list of companies. AUTHENTICATION REQUIRED when my=1 (to get companies user manages). PUBLIC when my=0 or omitted (all companies). If user asks about "their" or "my" companies, use my=1 and ensure user is logged in first. After getting user companies, ask which company they want to work with if not specified. PAGINATION STRATEGY: Default returns 200 companies (can overwhelm context). RECOMMENDED: Start with count=20-50 for initial results. Show user first batch, ask if they need more or can identify their company. Only increase count if user explicitly needs full list. Maximum count=300. Use page parameter to fetch next batches. This approach saves context and computation.',
  annotations: {
    title: 'List Companies',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    my: z
      .number()
      .int()
      .min(0)
      .max(1)
      .optional()
      .describe(
        'Set to 1 to get only companies user has admin access to (REQUIRES LOGIN). Omit or set to 0 for public list of all companies (no login needed).'
      ),
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
        'Results per page. Default 200 (overwhelming). RECOMMENDED: Use 20-50 for user companies (my=1), 50-100 for public searches. Only use 200+ if user explicitly requests complete list. Max 300.'
      ),
  }),
  outputSchema: companiesOutput,
  handler: async ({ input, client }) => {
    const companies = await client.getCompanies(input);

    const summary = `Found ${companies.length} ${companies.length === 1 ? 'company' : 'companies'}${input.my === 1 ? ' (user companies)' : ''}:\n\n`;
    const companiesList = companies
      .map(
        (c, idx) =>
          `${idx + 1}. ID: ${c.id} - "${c.title || c.public_title}"\n   Address: ${c.address || 'N/A'}\n   Phone: ${c.phone || 'N/A'}`
      )
      .join('\n\n');

    return {
      text: summary + companiesList,
      structuredContent: { items: companies, count: companies.length },
    };
  },
});
