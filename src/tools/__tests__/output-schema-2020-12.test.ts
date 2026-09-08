/**
 * Regression guard: every tool's `inputSchema` and `outputSchema` must be a
 * valid JSON Schema 2020-12 document.
 *
 * MCP tool schemas are validated by strict clients — the mcp Python SDK's
 * `_validate_tool_result`, MCP Inspector, and by extension Cursor / Claude.ai —
 * against the draft 2020-12 meta-schema *before any data is handed back*. A
 * schema that is only valid under an older draft (for example the draft-2019
 * tuple form `items: [ … ]`, where `items` is an array of schemas) fails that
 * meta-schema check, and the client rejects the whole tool call with
 * "Invalid schema for tool …" instead of returning the result.
 *
 * This test compiles each schema exactly as those clients do, so the class of
 * bug that hit `analytics_get_daily_series` (and every series built on the
 * shared `dailyPoints` schema) can never ship again.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import { orderedToolEntries } from '../registry.js';

/** Canonical URI of the meta-schema Ajv2020 registers for the 2020-12 dialect. */
const META_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

/** A validator for "is this object a valid 2020-12 schema document?". */
function metaSchemaValidator() {
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.getSchema(META_2020_12);
  if (!validate) {
    throw new Error('Ajv2020 did not register the 2020-12 meta-schema');
  }
  return validate;
}

const entries = orderedToolEntries();

describe('every tool schema is valid JSON Schema 2020-12', () => {
  const validate = metaSchemaValidator();

  it('there is a tool surface to check', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  for (const { spec } of entries) {
    for (const kind of ['inputSchema', 'outputSchema'] as const) {
      const schema = spec[kind];
      if (!schema) continue;
      it(`${spec.name}: ${kind} passes the 2020-12 meta-schema`, () => {
        const ok = validate(schema);
        if (!ok) {
          throw new Error(
            `${spec.name}.${kind} is not a valid 2020-12 schema:\n` +
              JSON.stringify(validate.errors, null, 2)
          );
        }
        expect(ok).toBe(true);
      });
    }
  }
});

describe('analytics_get_daily_series output schema (the dailyPoints regression)', () => {
  const spec = entries.find(
    (e) => e.spec.name === 'analytics_get_daily_series'
  )?.spec;

  it('exposes an output schema', () => {
    expect(spec?.outputSchema).toBeDefined();
  });

  it('compiles under 2020-12 and validates real [date, value] pairs', () => {
    const ajv = new Ajv2020({ strict: false });
    // Before the fix this call threw:
    //   "schema is invalid: data/items/items must be object,boolean"
    // because the inner point used the draft-2019 tuple form `items: [ … ]`.
    const validate = ajv.compile(spec!.outputSchema!);

    const result = {
      period: {},
      previous_period: {},
      metric: 'revenue',
      unit: 'money',
      currency: 'EUR',
      series: [
        {
          key: 'total',
          label: 'Total revenue',
          points: [
            ['2026-09-01', 1234.5],
            ['2026-09-02', 0],
          ],
        },
      ],
    };
    expect(validate(result)).toBe(true);
  });

  it('keeps each point a strict [string, number] 2-tuple', () => {
    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(spec!.outputSchema!);

    const withThreeElementPoint = {
      series: [
        { key: 'total', label: 'Total', points: [['2026-09-01', 1, 2]] },
      ],
    };
    const withWrongTypes = {
      series: [{ key: 'total', label: 'Total', points: [[1, 'oops']] }],
    };

    expect(validate(withThreeElementPoint)).toBe(false);
    expect(validate(withWrongTypes)).toBe(false);
  });
});
