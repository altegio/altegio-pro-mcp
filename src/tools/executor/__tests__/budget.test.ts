import {
  applyProjection,
  enforceBudget,
  RESULT_BUDGET_CHARS,
} from '../budget.js';

describe('projection (ADR-001 D8)', () => {
  it('keeps only the allowlisted fields of an object', () => {
    const projected = applyProjection(
      { id: 1, title: 'Studio', secret: 'drop me', phone: '+1' },
      ['id', 'title']
    );
    expect(projected).toEqual({ id: 1, title: 'Studio' });
  });

  it('applies per item for a list payload', () => {
    const projected = applyProjection(
      [
        { id: 1, name: 'Ann', rating: 5, internal: 'x' },
        { id: 2, name: 'Bob', rating: 4, internal: 'y' },
      ],
      ['id', 'name']
    );
    expect(projected).toEqual([
      { id: 1, name: 'Ann' },
      { id: 2, name: 'Bob' },
    ]);
  });

  it('follows dot paths into nested objects', () => {
    const projected = applyProjection(
      { id: 7, position: { id: 3, title: 'Stylist', weight: 9 } },
      ['id', 'position.title']
    );
    expect(projected).toEqual({ id: 7, position: { title: 'Stylist' } });
  });

  it('follows dot paths through nested arrays', () => {
    const projected = applyProjection(
      {
        id: 1,
        services: [
          { id: 10, title: 'Cut', cost: 30 },
          { id: 11, title: 'Colour', cost: 90 },
        ],
      },
      ['id', 'services.title']
    );
    expect(projected).toEqual({
      id: 1,
      services: [{ title: 'Cut' }, { title: 'Colour' }],
    });
  });

  it('accepts the documented `data[].` prefix, which addresses each item', () => {
    const projected = applyProjection(
      [{ id: 1, name: 'Ann', extra: 1 }],
      ['data[].id', 'data[].name']
    );
    expect(projected).toEqual([{ id: 1, name: 'Ann' }]);
  });

  it('ignores fields the payload does not have', () => {
    expect(applyProjection({ id: 1 }, ['id', 'nope'])).toEqual({ id: 1 });
  });

  it('passes a scalar payload through untouched', () => {
    expect(applyProjection(42, ['id'])).toBe(42);
  });
});

describe('result size budget (ADR-001 D8)', () => {
  it('leaves a small payload alone', () => {
    const result = enforceBudget([{ id: 1 }, { id: 2 }]);
    expect(result.truncated).toBe(false);
    expect(result.value).toEqual([{ id: 1 }, { id: 2 }]);
    expect(result.returned).toBe(2);
    expect(result.total).toBe(2);
  });

  it('truncates a long list and reports how much it kept', () => {
    const items = Array.from({ length: 5000 }, (_, i) => ({
      id: i,
      name: `Team member ${i}`,
      specialization: 'Stylist',
    }));

    const result = enforceBudget(items);
    expect(result.truncated).toBe(true);
    expect(result.total).toBe(5000);
    expect(result.returned).toBeLessThan(5000);
    expect(result.returned).toBeGreaterThan(0);
    expect(JSON.stringify(result.value).length).toBeLessThanOrEqual(
      RESULT_BUDGET_CHARS
    );
    // Truncation keeps the leading items, so the result is still a usable page.
    expect((result.value as Array<{ id: number }>)[0]?.id).toBe(0);
  });

  it('keeps as many items as fit, not an arbitrary page', () => {
    const items = Array.from({ length: 400 }, (_, i) => ({
      id: i,
      blob: 'x'.repeat(100),
    }));
    const result = enforceBudget(items, 2000);
    const kept = result.returned ?? 0;
    expect(JSON.stringify(items.slice(0, kept)).length).toBeLessThanOrEqual(
      2000
    );
    expect(JSON.stringify(items.slice(0, kept + 1)).length).toBeGreaterThan(
      2000
    );
  });

  it('drops the heaviest fields of an oversized object and names them', () => {
    const payload = {
      id: 1,
      title: 'Studio',
      huge: 'x'.repeat(20000),
      also_big: 'y'.repeat(5000),
    };

    const result = enforceBudget(payload, 1000);
    expect(result.truncated).toBe(true);
    expect(result.omittedFields).toEqual(['huge', 'also_big']);
    expect(result.value).toEqual({ id: 1, title: 'Studio' });
  });

  it('prunes a single oversized list item rather than returning nothing', () => {
    const result = enforceBudget(
      [{ id: 1, blob: 'x'.repeat(5000) }, { id: 2 }],
      500
    );
    expect(result.truncated).toBe(true);
    expect(result.returned).toBe(1);
    expect(result.total).toBe(2);
    expect(result.omittedFields).toEqual(['blob']);
    expect(result.value).toEqual([{ id: 1 }]);
  });
});
