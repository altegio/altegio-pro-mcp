import { z } from 'zod';
import { defineTool } from '../factory.js';
import { resourcesOutput } from '../output-schemas.js';
import { withUntrustedBlock, type UntrustedField } from '../tool-result.js';

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

    // A resource title (a cabinet, a chair, a machine) is named by the staff.
    const lines = [
      `Found ${resources.length} resource(s):`,
      ...resources.map(
        (r) =>
          `- Resource ${r.id}${r.instances?.length ? ` · ${r.instances.length} instance(s)` : ''}`
      ),
    ];
    const untrusted: UntrustedField[] = resources.map((r) => ({
      label: `resource ${r.id} title`,
      value: r.title,
    }));

    return {
      text: withUntrustedBlock(lines.join('\n'), untrusted, { maxChars: 200 }),
      structuredContent: {
        items: resources.map((r) => ({ id: r.id, title: r.title })),
        count: resources.length,
      },
    };
  },
});
