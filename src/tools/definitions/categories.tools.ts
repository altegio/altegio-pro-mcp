import { paginationInput, paginateCollection } from '../pagination.js';
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { categoriesOutput } from '../output-schemas.js';
import { withUntrustedBlock, type UntrustedField } from '../tool-result.js';

export const getServiceCategoriesTool = defineTool({
  name: 'service_categories_list',
  category: 'Categories',
  description:
    'Service categories of a location (how services are grouped). Paged by id with total.',
  annotations: {
    title: 'Get Service Categories',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('From locations_list.'),
    category_id: z
      .number()
      .int()
      .min(0)
      .optional()
      .default(0)
      .describe('Parent category id; 0 (default) for root categories.'),
    ...paginationInput,
  }),
  outputSchema: categoriesOutput,
  handler: async ({ input, client }) => {
    const { location_id, category_id } = input;
    const { items: categories, pagination } = paginateCollection(
      await client.getServiceCategories(location_id, category_id),
      input
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
        pagination,
      },
    };
  },
});

export const deleteServiceCategoryTool = defineTool({
  name: 'service_categories_delete',
  category: 'Categories',
  description:
    'Delete a service category; delete or move its services first. A 403 on a chain-owned category is an ownership boundary — do not retry.',
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
