import { z } from 'zod';
import { defineTool } from '../factory.js';
import { resourcesOutput } from '../output-schemas.js';

export const getResourcesTool = defineTool({
  name: 'get_resources',
  category: 'Resources',
  description:
    '[Resources] Get the list of resources at a location (e.g. cabinets, chairs, equipment). AUTHENTICATION REQUIRED. Read-only: the API does not expose resource creation.',
  annotations: {
    title: 'Get Resources',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
  }),
  outputSchema: resourcesOutput,
  handler: async ({ input, client }) => {
    const resources = await client.getResources(input.location_id);

    if (!resources || resources.length === 0) {
      return {
        text: 'No resources found for this location.',
        structuredContent: { items: [], count: 0 },
      };
    }

    const list = resources
      .map((r, idx) => {
        const instances = r.instances?.length
          ? ` — ${r.instances.length} instance(s)`
          : '';
        return `${idx + 1}. ${r.title} (ID: ${r.id})${instances}`;
      })
      .join('\n');

    return {
      text: `Found ${resources.length} resource(s):\n\n${list}`,
      structuredContent: { items: resources, count: resources.length },
    };
  },
});
