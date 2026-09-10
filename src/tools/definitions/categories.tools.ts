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
        '1-based page number for pagination (default 1). Use 2 for the next page.'
      ),
    count: z
      .number()
      .int()
      .positive()
      .max(300)
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

export const deleteServiceCategoryTool = defineTool({
  name: 'delete_service_category',
  category: 'Categories',
  description:
    '[Categories] Permanently delete one specifically identified service category. AUTHENTICATION REQUIRED. Delete or move its location-owned services first. A 403 for a chain-owned category is an ownership boundary; do not retry it at chain scope.',
  annotations: {
    title: 'Delete Service Category',
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    category_id: z
      .number()
      .int()
      .positive()
      .describe('Exact service category ID to delete'),
  }),
  handler: async ({ input, client }) => {
    await client.deleteServiceCategory(input.location_id, input.category_id);
    return {
      text: `Deleted service category ${input.category_id} from location ${input.location_id}`,
    };
  },
});
