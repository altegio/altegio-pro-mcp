import { z } from 'zod';
import { defineTool } from '../factory.js';
import { categoriesOutput } from '../output-schemas.js';

export const getServiceCategoriesTool = defineTool({
  name: 'get_service_categories',
  category: 'Categories',
  description:
    '[Categories] Get list of service categories at a location. PUBLIC API - NO AUTHENTICATION REQUIRED. Use this for online booking - shows how services are organized. PAGINATION STRATEGY: May return many categories (20+). RECOMMENDED: Start with count=20-30. Categories help organize services, so showing initial set is usually sufficient.',
  annotations: {
    title: 'Get Service Categories',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z
      .number()
      .int()
      .positive()
      .describe('ID of the location to get service categories for'),
    category_id: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe(
        'Parent category ID to get subcategories for. Use 0 (default) to get root-level categories.'
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
        'Results per page. Default may be large. RECOMMENDED: Use 20-30 for initial display. Max 300.'
      ),
  }),
  outputSchema: categoriesOutput,
  handler: async ({ input, client }) => {
    const { location_id, category_id, ...listParams } = input;
    const categories = await client.getServiceCategories(
      location_id,
      category_id,
      Object.keys(listParams).length > 0 ? listParams : undefined
    );

    const summary = `Found ${categories.length} service ${categories.length === 1 ? 'category' : 'categories'} for location ${location_id}:\n\n`;
    const categoriesList = categories
      .map(
        (c, idx) =>
          `${idx + 1}. ID: ${c.id} - "${c.title}"${c.services ? `\n   Services count: ${c.services.length}` : ''}`
      )
      .join('\n\n');

    return {
      text: summary + categoriesList,
      structuredContent: {
        items: categories.map((c) => ({ id: c.id, title: c.title })),
        count: categories.length,
      },
    };
  },
});
