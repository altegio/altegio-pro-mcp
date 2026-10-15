/**
 * Data-model cross-check — every id and field the model is told to join on
 * must exist in the result of the tool that is said to carry it.
 *
 * A model writing code over these results reads the field names literally; a
 * renamed field in a tool's output schema has to fail here, not in a script.
 */
import { allToolEntries } from '../../../tools/inventory.js';
import { JOIN_KEYS, SOURCE_FACTS } from '../data-model.js';
import { renderDataModel } from '../../../resources/analytics.resources.js';

type Schema = Record<string, unknown>;

const served = new Map(
  allToolEntries()
    .filter((entry) => !entry.disabled)
    .map((entry) => [entry.name, entry.spec] as const)
);

/** Every field path of an output schema: `items[].services[].cost`, `totals.revenue`. */
function fieldPaths(schema: unknown, prefix = '', out: string[] = []) {
  if (!schema || typeof schema !== 'object') return out;
  const node = schema as Schema;
  for (const variant of [
    ...((node.anyOf as unknown[]) ?? []),
    ...((node.oneOf as unknown[]) ?? []),
  ]) {
    fieldPaths(variant, prefix, out);
  }
  if (node.items) fieldPaths(node.items, `${prefix}[]`, out);
  for (const [key, value] of Object.entries(
    (node.properties as Schema | undefined) ?? {}
  )) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(path);
    fieldPaths(value, path, out);
  }
  return out;
}

function outputPaths(tool: string): string[] {
  return fieldPaths(served.get(tool)?.outputSchema);
}

describe('analytics data model', () => {
  it.each(
    JOIN_KEYS.flatMap((key) =>
      key.fields.map((field) => [key.object, field.tool, field.field] as const)
    )
  )('%s id: %s returns %s', (_object, tool, field) => {
    expect(served.has(tool)).toBe(true);
    expect(outputPaths(tool)).toContain(field);
  });

  it('describes only served tools', () => {
    for (const fact of SOURCE_FACTS) expect(served.has(fact.tool)).toBe(true);
  });

  it('names only fields some served tool returns', () => {
    const known = [...served.keys()].flatMap((tool) => outputPaths(tool));
    const dotted = [
      ...SOURCE_FACTS.map((fact) => fact.text),
      ...JOIN_KEYS.map((key) => key.note ?? ''),
    ].flatMap((text) => [
      ...text.matchAll(/\b[a-z_]+(?:\[\])?(?:\.[a-z_]+(?:\[\])?)+/g),
    ]);
    const unknown = dotted
      .map((match) => match[0])
      .filter(
        (path) =>
          !known.some((full) => full === path || full.endsWith(`.${path}`))
      );
    expect(unknown).toEqual([]);
  });

  it('renders the keys, the row meanings and the paging rule', () => {
    const text = renderDataModel();
    expect(text).toContain('## Combining tool results');
    expect(text).toContain(
      '`items[].client_id` in appointments_list, analytics_get_client_sales'
    );
    expect(text).toContain('`items[].id` in clients_get_segment_report');
    expect(text).toContain('first_visit_date');
    expect(text).toContain('services[].cost');
    expect(text).toContain('pagination.next_page');
  });
});
