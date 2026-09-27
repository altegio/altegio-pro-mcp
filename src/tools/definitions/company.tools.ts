import { paginationInput, pageMetadata } from '../pagination.js';
import { z } from 'zod';
import { defineTool } from '../factory.js';
import { companiesOutput, locationUpdateOutput } from '../output-schemas.js';
import { withUntrustedBlock, type UntrustedField } from '../tool-result.js';
import type {
  AltegioCompany,
  UpdateLocationRequest,
} from '../../types/altegio.types.js';

/** Tool argument -> V1 field, for the few names the product glossary renames. */
const LOCATION_WIRE_FIELDS: Readonly<Record<string, string>> = {
  postal_code: 'zip',
  website: 'site',
  short_description: 'short_descr',
};

function toLocationWire(
  requested: Record<string, unknown>
): UpdateLocationRequest {
  const wire: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(requested)) {
    if (value === undefined) continue;
    wire[LOCATION_WIRE_FIELDS[field] ?? field] = value;
  }
  return wire as UpdateLocationRequest;
}

function sameValue(requested: unknown, observed: unknown): boolean {
  if (Array.isArray(requested) && Array.isArray(observed)) {
    return JSON.stringify(requested) === JSON.stringify(observed);
  }
  return requested === observed;
}

export const listLocationsTool = defineTool({
  name: 'locations_list',
  category: 'Location',
  description:
    'List locations. Pass managed_only=true for the locations the signed-in user administers — the usual first call to find a location_id; when the user means "my locations", that is this. Ask which location to work with when several come back. Paged: 25 per page by default; follow pagination.next_page until it is null (a full last page may need one empty request).',
  annotations: {
    title: 'List Locations',
    readOnlyHint: true,
    openWorldHint: true,
  },
  input: z.object({
    managed_only: z
      .boolean()
      .default(false)
      .describe(
        'true: only locations the signed-in user administers. false (default): the location directory the current credentials can see.'
      ),
    ...paginationInput,
  }),
  outputSchema: companiesOutput,
  handler: async ({ input, client }) => {
    const locations = await client.getCompanies({
      my: input.managed_only ? 1 : 0,
      page: input.page,
      count: input.page_size,
    });

    // Name, address and phone of a location are typed by its owner, and the
    // public list is not even limited to locations this user manages.
    const lines = [
      `Found ${locations.length} ${locations.length === 1 ? 'location' : 'locations'}${input.managed_only ? ' (managed by the user)' : ''}, ids: ${locations.map((c) => c.id).join(', ')}.`,
    ];
    const untrusted: UntrustedField[] = [];
    for (const c of locations) {
      untrusted.push({
        label: `location ${c.id} name`,
        value: c.title || c.public_title,
      });
      untrusted.push({ label: `location ${c.id} address`, value: c.address });
      untrusted.push({ label: `location ${c.id} phone`, value: c.phone });
    }

    return {
      text: withUntrustedBlock(lines.join('\n'), untrusted, { maxChars: 200 }),
      structuredContent: {
        items: locations.map((c) => ({
          id: c.id,
          title: c.title,
          address: c.address,
          phone: c.phone,
        })),
        pagination: pageMetadata(input, locations.length),
      },
    };
  },
});

export const updateLocationTool = defineTool({
  name: 'locations_update',
  category: 'Location',
  description:
    'Update a location: rename it or change its address, city or country, postal code, website, coordinates, description, business type or phones. Needs administrator access to the location. The result verifies every requested field against a fresh read of the location; a field the API accepted but did not persist (phones sometimes) is reported as unconfirmed, never as updated.',
  annotations: {
    title: 'Update Location',
    destructiveHint: false,
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
    postal_code: z.string().optional().describe('Postal code'),
    phones: z
      .array(z.string())
      .optional()
      .describe(
        'Location phone numbers (without +). Documented by V1, but some locations accept this field without persisting it; the tool reports the read-back mismatch.'
      ),
    website: z.string().optional().describe('Website URL'),
    coordinate_lat: z.number().optional().describe('Latitude'),
    coordinate_lon: z.number().optional().describe('Longitude'),
    description: z.string().optional().describe('Description (HTML allowed)'),
    business_type_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Business type ID'),
    short_description: z
      .string()
      .optional()
      .describe('Business category or tagline shown under the name'),
  }),
  outputSchema: locationUpdateOutput,
  handler: async ({ input, client }) => {
    const { location_id, ...requested } = input;
    // Canonical argument names at the tool boundary, V1 field names on the wire.
    const updateData = toLocationWire(requested);
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

    const requestedFields = Object.keys(requested);
    const verifiedFields: string[] = [];
    const unconfirmedFields: string[] = [];
    for (const field of requestedFields) {
      const wireField = LOCATION_WIRE_FIELDS[field] ?? field;
      const observed = location[wireField];
      if (
        observed !== undefined &&
        sameValue(requested[field as keyof typeof requested], observed)
      ) {
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
      text: withUntrustedBlock(
        `Location ${location_id} update request completed.\n` +
          `${verificationText}` +
          (verificationError
            ? `\nRead-back unavailable: ${verificationError}`
            : ''),
        // The name read back is whatever the location now stores, which is not
        // necessarily what this call sent.
        [
          {
            label: 'location name as stored',
            value: location.title ?? location.public_title,
          },
        ],
        { maxChars: 200 }
      ),
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
