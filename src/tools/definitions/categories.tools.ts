import { z } from 'zod';
import { defineTool } from '../factory.js';
import { categoriesOutput } from '../output-schemas.js';
import { withUntrustedBlock, type UntrustedField } from '../tool-result.js';

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

    // A category title is named by the staff of the location, so it stays out
    // of our rows and is keyed back to them by id.
    const lines = [
      `Found ${categories.length} service ${categories.length === 1 ? 'category' : 'categories'} for location ${location_id}:`,
      ...categories.map(
        (c) =>
          `- Category ${c.id}${c.services ? ` · ${c.services.length} service(s)` : ''}`
      ),
    ];
    const untrusted: UntrustedField[] = categories.map((c) => ({
      label: `category ${c.id} title`,
      value: c.title,
    }));

    return {
      text: withUntrustedBlock(lines.join('\n'), untrusted, { maxChars: 200 }),
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
  confirm: {
    action: 'Delete service category',
    target: (input) =>
      `service category ${input.category_id} at location ${input.location_id}`,
    resolve: async (input, client) => {
      const category = (
        await client.getServiceCategories(input.location_id)
      ).find((candidate) => candidate.id === input.category_id);
      if (!category) return undefined;
      const services = category.services?.length;
      const holding =
        services === undefined ? '' : ` holding ${services} service(s)`;
      return `service category "${category.title}", id ${category.id}${holding}, at location ${input.location_id}`;
    },
    consequence:
      'The category itself is removed. Services still assigned to it are left without a category and drop out of the online-booking menu until they are reassigned, so move or delete them first.',
  },
  handler: async ({ input, client }) => {
    await client.deleteServiceCategory(input.location_id, input.category_id);
    return {
      text: `Deleted service category ${input.category_id} from location ${input.location_id}`,
    };
  },
});
