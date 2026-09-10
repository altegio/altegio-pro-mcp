import { z } from 'zod';
import { defineTool } from '../factory.js';
import { companiesOutput, companyEntityOutput } from '../output-schemas.js';

export const listLocationsTool = defineTool({
  name: 'list_locations',
  category: 'Location',
  description:
    '[Location] Get list of locations. AUTHENTICATION REQUIRED when my=1 (to get locations user manages). PUBLIC when my=0 or omitted (all locations). If user asks about "their" or "my" locations, use my=1 and ensure user is logged in first. After getting user locations, ask which location they want to work with if not specified. PAGINATION STRATEGY: Default returns 200 locations (can overwhelm context). RECOMMENDED: Start with count=20-50 for initial results. Show user first batch, ask if they need more or can identify their location. Only increase count if user explicitly needs full list. Maximum count=300. Use page parameter to fetch next batches. This approach saves context and computation.',
  annotations: {
    title: 'List Locations',
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
        'Set to 1 to get only locations user has admin access to (REQUIRES LOGIN). Omit or set to 0 for public list of all locations (no login needed).'
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
        'Results per page. Default 200 (overwhelming). RECOMMENDED: Use 20-50 for user locations (my=1), 50-100 for public searches. Only use 200+ if user explicitly requests complete list. Max 300.'
      ),
  }),
  outputSchema: companiesOutput,
  handler: async ({ input, client }) => {
    const locations = await client.getCompanies(input);

    const summary = `Found ${locations.length} ${locations.length === 1 ? 'location' : 'locations'}${input.my === 1 ? ' (user locations)' : ''}:\n\n`;
    const locationsList = locations
      .map(
        (c, idx) =>
          `${idx + 1}. ID: ${c.id} - "${c.title || c.public_title}"\n   Address: ${c.address || 'N/A'}\n   Phone: ${c.phone || 'N/A'}`
      )
      .join('\n\n');

    return {
      text: summary + locationsList,
      structuredContent: {
        items: locations.map((c) => ({
          id: c.id,
          title: c.title,
          address: c.address,
          phone: c.phone,
        })),
        count: locations.length,
      },
    };
  },
});

export const updateLocationTool = defineTool({
  name: 'update_location',
  category: 'Location',
  description:
    '[Location] Update a location (salon) — rename it, change address/city/country, phones, website, coordinates, description, or business type. AUTHENTICATION REQUIRED (admin access to the location). Provide only the fields to change.',
  annotations: {
    title: 'Update Location',
    openWorldHint: true,
    idempotentHint: true,
  },
  input: z.object({
    location_id: z.number().int().positive().describe('Location ID'),
    title: z.string().min(1).optional().describe('Location name'),
    country: z.string().optional().describe('Country name'),
    country_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Country ID (takes priority over country)'),
    city: z.string().optional().describe('City name'),
    city_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('City ID (takes priority over city)'),
    address: z.string().optional().describe('Street address'),
    zip: z.string().optional().describe('ZIP / postal code'),
    phones: z
      .array(z.string())
      .optional()
      .describe('Location phone numbers (without +)'),
    site: z.string().optional().describe('Website URL'),
    coordinate_lat: z.number().optional().describe('Latitude'),
    coordinate_lon: z.number().optional().describe('Longitude'),
    description: z.string().optional().describe('Description (HTML allowed)'),
    business_type_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Business type ID'),
    short_descr: z.string().optional().describe('Business category / tagline'),
  }),
  outputSchema: companyEntityOutput,
  handler: async ({ input, client }) => {
    const { location_id, ...updateData } = input;
    const location = await client.updateLocation(location_id, updateData);
    return {
      text: `Successfully updated location ${location_id}:\nTitle: ${location.title ?? location.public_title ?? '(unchanged)'}`,
      structuredContent: {
        id: location.id,
        title: location.title,
        city: location.city,
        address: location.address,
      },
    };
  },
});
