import { z } from 'zod';
import { defineTool } from '../factory.js';
import {
  acceptedKeysAt,
  canonicalInput,
  coerceIdStrings,
  compactJsonSchema,
} from '../input-normalization.js';

const schema = z
  .object({
    location_id: z.number().int().positive(),
    client_ids: z.array(z.number().int().positive()).optional(),
    page: z.number().int().positive().default(1),
    filters: z
      .object({ team_member_id: z.number().int().optional() })
      .optional(),
    title: z.string().optional(),
  })
  .strict();

describe('id coercion', () => {
  it('reads canonical digit strings as ids, at any depth', () => {
    expect(
      coerceIdStrings(schema, {
        location_id: '4564',
        client_ids: ['1', '22'],
        filters: { team_member_id: '7' },
      })
    ).toEqual({
      location_id: 4564,
      client_ids: [1, 22],
      filters: { team_member_id: 7 },
    });
  });

  it('stays strict for everything else', () => {
    expect(
      coerceIdStrings(schema, {
        location_id: '45x',
        page: '2',
        title: '12',
      })
    ).toEqual({ location_id: '45x', page: '2', title: '12' });
    expect(coerceIdStrings(schema, { location_id: '007' })).toEqual({
      location_id: '007',
    });
    expect(coerceIdStrings(schema, { location_id: '1.5' })).toEqual({
      location_id: '1.5',
    });
  });
});

describe('curated tool arguments', () => {
  const tool = defineTool({
    name: 'demo_delete',
    category: 'Demo',
    description: 'demo',
    input: schema,
    confirm: {
      action: 'Delete demo',
      target: (input) => `demo at ${input.location_id}`,
      consequence: 'Gone.',
    },
    handler: async ({ input }) => ({ text: `location ${input.location_id}` }),
  });
  const client = {} as never;

  it('accepts an id as a digit string', async () => {
    const result = await tool.createHandler(client)({ location_id: '4564' });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('location 4564');
  });

  it('names the argument object and the accepted keys for an unknown key', async () => {
    const result = await tool.createHandler(client)({
      location_id: 1,
      path_params: {},
    });
    expect(result.isError).toBe(true);
    const text = result.content[0]?.text ?? '';
    expect(text).toContain(
      'Invalid parameters for demo_delete: (arguments): unrecognized key "path_params"; accepted keys: location_id, client_ids, page, filters, title, confirmation_token'
    );
    expect(text).not.toContain(': :');
  });

  it('keeps a plain message and its path for other issues', async () => {
    const result = await tool.createHandler(client)({ location_id: '45x' });
    expect(result.content[0]?.text).toMatch(
      /^Invalid parameters for demo_delete: location_id: /
    );
  });

  it('binds a confirmation to the parsed input, not the spelling', () => {
    const a = tool.prepareConfirmation!({ location_id: 4564 });
    const b = tool.prepareConfirmation!({
      location_id: '4564',
      title: undefined,
    });
    expect(a?.binding).toEqual(b?.binding);
    expect(a?.binding).toEqual({ location_id: 4564, page: 1 });
  });
});

describe('helpers', () => {
  it('lists the keys an object accepts at a path', () => {
    expect(acceptedKeysAt(schema, [])).toEqual([
      'location_id',
      'client_ids',
      'page',
      'filters',
      'title',
    ]);
    expect(acceptedKeysAt(schema, ['filters'])).toEqual(['team_member_id']);
    expect(acceptedKeysAt(schema, ['title'])).toBeUndefined();
  });

  it('drops null and undefined from the canonical input', () => {
    expect(
      canonicalInput({ a: 1, b: null, c: undefined, d: { e: null, f: [1] } })
    ).toEqual({ a: 1, d: { f: [1] } });
  });

  it('compacts generator noise out of a listed schema', () => {
    expect(
      compactJsonSchema({
        type: 'object',
        properties: {
          location_id: {
            type: 'integer',
            exclusiveMinimum: 0,
            maximum: Number.MAX_SAFE_INTEGER,
            description: 'Location ID',
          },
          age: {
            type: 'integer',
            minimum: Number.MIN_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
            description: 'Age in years.',
          },
          changed_after: {
            type: 'string',
            format: 'date-time',
            pattern: '^long$',
          },
        },
      })
    ).toEqual({
      type: 'object',
      properties: {
        location_id: { type: 'integer', minimum: 1 },
        age: { type: 'integer', description: 'Age in years.' },
        changed_after: { type: 'string', format: 'date-time' },
      },
    });
  });
});
