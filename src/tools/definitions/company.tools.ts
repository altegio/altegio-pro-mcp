import { z } from 'zod';
import { defineTool } from '../factory.js';
import { companiesOutput, locationUpdateOutput } from '../output-schemas.js';
import type { AltegioCompany } from '../../types/altegio.types.js';

function sameValue(requested: unknown, observed: unknown): boolean {
  if (Array.isArray(requested) && Array.isArray(observed)) {
    return JSON.stringify(requested) === JSON.stringify(observed);
  }
  return requested === observed;
}

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
        '1-based page number for pagination (default 1). Use 2 for the next page.'
      ),
    count: z
      .number()
      .int()
      .positive()
      .max(300)
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
    '[Location] Update a location — rename it or change documented address, city/country, website, coordinates, description, business type, or phone fields. AUTHENTICATION REQUIRED (admin access to the location). The result verifies requested fields against a documented location read. In particular, the API may accept phones without persisting them; such fields are reported as unconfirmed, never as successfully updated.',
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
      .describe(
        'Location phone numbers (without +). Documented by V1, but some locations accept this field without persisting it; the tool reports the read-back mismatch.'
      ),
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
  outputSchema: locationUpdateOutput,
  handler: async ({ input, client }) => {
    const { location_id, ...updateData } = input;
    const updateResponse = await client.updateLocation(location_id, updateData);
    let location: AltegioCompany = updateResponse;
    let verificationSource = 'update_response';
    let verificationError: string | null = null;
    try {
      location = await client.getLocation(location_id, { my: 1 });
      verificationSource = 'read_back';
    } catch (error) {
      verificationError =
        error instanceof Error ? error.message : 'Location read-back failed';
    }

    const requestedFields = Object.keys(updateData);
    const verifiedFields: string[] = [];
    const unconfirmedFields: string[] = [];
    for (const field of requestedFields) {
      const requested = updateData[field as keyof typeof updateData];
      const observed = location[field];
      if (observed !== undefined && sameValue(requested, observed)) {
        verifiedFields.push(field);
      } else {
        unconfirmedFields.push(field);
      }
    }

    const verificationText =
      unconfirmedFields.length === 0
        ? `Verified by ${verificationSource.replace('_', ' ')}: ${verifiedFields.join(', ') || 'no fields requested'}.`
        : `Not confirmed by ${verificationSource.replace('_', ' ')}: ${unconfirmedFields.join(', ')}. The API accepted the request, but these values were absent or different in the result; do not claim they persisted.`;
    return {
      text:
        `Location ${location_id} update request completed.\n` +
        `Title: ${location.title ?? location.public_title ?? 'not reported'}\n` +
        `${verificationText}` +
        (verificationError
          ? `\nRead-back unavailable: ${verificationError}`
          : ''),
      structuredContent: {
        id: location.id,
        title: location.title ?? location.public_title ?? null,
        city: location.city ?? null,
        address: location.address ?? null,
        phones: Array.isArray(location.phones) ? location.phones : null,
        verification_source: verificationSource,
        requested_fields: requestedFields,
        verified_fields: verifiedFields,
        unconfirmed_fields: unconfirmedFields,
        verification_error: verificationError,
      },
    };
  },
});
