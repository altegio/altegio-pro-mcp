import { paginationInput, paginateCollection } from '../pagination.js';
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { categoriesOutput } from '../output-schemas.js';
import { withUntrustedBlock, type UntrustedField } from '../tool-result.js';
import type { AltegioClient } from '../../providers/altegio-client.js';
import {
  ConfirmationRefusal,
  stateVersion,
  type ConfirmedCall,
} from '../confirmation.js';

export const getServiceCategoriesTool = defineTool({
  name: 'service_categories_list',
  category: 'Service categories',
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
  category: 'Service categories',
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

/** A change the call cannot make; nothing was sent. */
class CategoryChangeError extends Error {}

/** The same refusal, worded for the confirmation that shows it. */
function refusalOf(error: CategoryChangeError): ConfirmationRefusal {
  return new ConfirmationRefusal(
    error.message.replace(/^Nothing was (changed|created): /, '')
  );
}

// ========== creating a service category ==========

interface CategoryCreateInput {
  location_id: number;
  title: string;
  sort_weight?: number;
}

/**
 * A category with the same title refuses the create, so a repeated confirmed
 * call creates nothing twice.
 */
async function refuseTwin(
  client: AltegioClient,
  input: CategoryCreateInput
): Promise<void> {
  const title = input.title.trim().toLocaleLowerCase();
  const twin = (await client.getServiceCategories(input.location_id)).find(
    (c) => (c.title ?? '').trim().toLocaleLowerCase() === title
  );
  if (twin) {
    throw new CategoryChangeError(
      `Nothing was created: service category ${twin.id} already has this title. Use it, or give the new category another title.`
    );
  }
}

export const createServiceCategoryTool = defineTool({
  name: 'service_categories_create',
  category: 'Service categories',
  description:
    'Create a service category; file services under it with services_create or services_update. Refused when the location already has a category with this title. Asks for confirmation first.',
  annotations: {
    title: 'Create Service Category',
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    title: z.string().trim().min(1).max(100).describe('Category title.'),
    sort_weight: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Sort weight that orders the categories (the API’s weight). Default: Altegio picks one.'
      ),
  }),
  confirm: {
    action: 'Create service category',
    target: (input) => `a service category at location ${input.location_id}`,
    consequence:
      'A new, empty service category is added to the location’s service list. Delete it with service_categories_delete while it holds no services.',
    detail: async (input, client) => {
      try {
        await refuseTwin(client, input);
      } catch (error) {
        if (error instanceof CategoryChangeError) throw refusalOf(error);
        throw error;
      }
      return input.sort_weight === undefined
        ? 'Sort weight: Altegio picks one.'
        : `Sort weight: ${input.sort_weight}.`;
    },
  },
  handler: async ({ input, client }) => {
    await refuseTwin(client, input);
    const created = await client.createServiceCategory(input.location_id, {
      title: input.title,
      ...(input.sort_weight !== undefined ? { weight: input.sort_weight } : {}),
    });
    const weight = typeof created.weight === 'number' ? created.weight : null;
    return {
      text: withUntrustedBlock(
        `Created service category ${created.id} at location ${input.location_id}, sort weight ${weight ?? 'not reported'}. File services under it with category_id ${created.id} (services_create, services_update).`,
        [{ label: `category ${created.id} title`, value: created.title }],
        { maxChars: 200 }
      ),
      structuredContent: {
        location_id: input.location_id,
        category: { id: created.id, title: created.title, sort_weight: weight },
      },
    };
  },
});

// ========== changing a service category ==========

interface CategoryUpdateInput {
  location_id: number;
  category_id: number;
  title?: string;
  sort_weight?: number;
}

interface CategoryPlan {
  version: string;
  before: { id: number; title: string; weight: number | null };
  after: { title: string; weight?: number };
}

/** V1 needs the title on every call; the weight and team members stay. */
async function planCategoryUpdate(
  client: AltegioClient,
  input: CategoryUpdateInput
): Promise<CategoryPlan> {
  if (input.title === undefined && input.sort_weight === undefined) {
    throw new CategoryChangeError(
      'Nothing was changed: pass a title, a sort_weight or both.'
    );
  }
  const read = await client.getServiceCategory(
    input.location_id,
    input.category_id
  );
  const before = {
    id: read.id,
    title: read.title,
    weight: typeof read.weight === 'number' ? read.weight : null,
  };
  const after = {
    title: input.title ?? before.title,
    ...(input.sort_weight !== undefined ? { weight: input.sort_weight } : {}),
  };
  if (
    after.title === before.title &&
    (after.weight === undefined || after.weight === before.weight)
  ) {
    throw new CategoryChangeError(
      `Nothing was changed: service category ${before.id} already has that title and sort weight.`
    );
  }
  return { version: stateVersion(before), before, after };
}

function categoryChangeText(plan: CategoryPlan, lead: string): string {
  const { before, after } = plan;
  const lines = [
    lead,
    ...(after.title !== before.title ? ['- title: changed'] : []),
    ...(after.weight !== undefined && after.weight !== before.weight
      ? [`- sort weight: ${before.weight ?? 'not reported'} → ${after.weight}`]
      : []),
  ];
  return withUntrustedBlock(
    lines.join('\n'),
    [
      { label: `category ${before.id} title before`, value: before.title },
      { label: `category ${before.id} title after`, value: after.title },
    ],
    { maxChars: 200 }
  );
}

function refuseMoved(
  plan: CategoryPlan,
  confirmation: ConfirmedCall | undefined
): void {
  if (
    confirmation?.version !== undefined &&
    confirmation.version !== plan.version
  ) {
    throw new CategoryChangeError(
      'Nothing was changed: the category changed after the confirmation was shown. Read it again with service_categories_list and confirm the change again.'
    );
  }
}

export const updateServiceCategoryTool = defineTool({
  name: 'service_categories_update',
  category: 'Service categories',
  description:
    'Rename a service category or change its sort weight; its services and team members stay. Create one with service_categories_create. Asks for confirmation first, showing before → after; refused if the category changes after that. A 403 on a chain-owned category is an ownership boundary — do not retry.',
  annotations: {
    title: 'Update Service Category',
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    category_id: z
      .number()
      .int()
      .positive()
      .describe('Service category ID (service_categories_list).'),
    title: z.string().trim().min(1).max(100).optional().describe('New title.'),
    sort_weight: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Sort weight that orders the categories (the API’s weight).'),
  }),
  confirm: {
    action: 'Update service category',
    target: (input) =>
      `service category ${input.category_id} at location ${input.location_id}`,
    consequence:
      'Online booking and the service list show the category under its new title and order.',
    detail: async (input, client) => {
      try {
        const plan = await planCategoryUpdate(client, input);
        return {
          text: categoryChangeText(plan, `Service category ${plan.before.id}:`),
          version: plan.version,
        };
      } catch (error) {
        if (error instanceof CategoryChangeError) throw refusalOf(error);
        throw error;
      }
    },
  },
  handler: async ({ input, client, confirmation }) => {
    const plan = await planCategoryUpdate(client, input);
    refuseMoved(plan, confirmation);
    const stored = await client.updateServiceCategory(
      input.location_id,
      input.category_id,
      plan.after
    );
    return {
      text: categoryChangeText(
        plan,
        `Updated service category ${plan.before.id} at location ${input.location_id}:`
      ),
      structuredContent: {
        location_id: input.location_id,
        category: {
          id: stored.id,
          title: stored.title,
          sort_weight: typeof stored.weight === 'number' ? stored.weight : null,
        },
      },
    };
  },
});
