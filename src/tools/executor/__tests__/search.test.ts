import { MAX_SEARCH_RESULTS, queryTerms, searchOperations } from '../search.js';

/**
 * Relevance is asserted on a handful of fixed business questions. The ranking
 * is deterministic by design (ADR-001 D9), so these are real regression tests:
 * a change to the weights that breaks a question fails here.
 */
describe('altegio_search_operations ranking', () => {
  const cases: Array<{ query: string; expect: string }> = [
    { query: 'team member schedule', expect: 'get_team_member_schedule' },
    { query: 'staff list', expect: 'get_team_member_list' },
    { query: 'list of services', expect: 'get_service_list' },
    {
      query: 'cash register transactions',
      expect: 'get_fiscal_transaction_list',
    },
    { query: 'appointments for a day', expect: 'get_appointment_list' },
  ];

  for (const { query, expect: expected } of cases) {
    it(`"${query}" ranks ${expected} first`, () => {
      const { hits } = searchOperations(query);
      expect(hits[0]?.operationId).toBe(expected);
    });
  }

  it('finds an operation by its exact operationId', () => {
    const { hits } = searchOperations('get_resource_list');
    expect(hits[0]?.operationId).toBe('get_resource_list');
  });

  it('matches the canonical glossary against the legacy spec vocabulary', () => {
    // The path and some summaries still say "staff"; the query says the
    // canonical thing and must still reach the operation.
    const { hits } = searchOperations('team members of a location');
    expect(hits.map((h) => h.operationId)).toContain('get_team_member_list');
  });

  it('matches the legacy vocabulary against canonical summaries', () => {
    const { hits } = searchOperations('master schedule');
    expect(hits.map((h) => h.operationId)).toContain(
      'get_team_member_schedule'
    );
  });

  it('names the curated tool when one already covers the operation', () => {
    const { hits } = searchOperations('staff list');
    expect(hits[0]?.tool).toBe('get_staff');
  });

  it('shows the canonical path, not the legacy spelling', () => {
    const { hits } = searchOperations('get_appointment');
    const hit = hits.find((h) => h.operationId === 'get_appointment');
    expect(hit?.path).toBe('/record/{location_id}/{appointment_id}');
  });

  it('is deterministic — the same query twice gives the same ranking', () => {
    const first = searchOperations('client visit history');
    const second = searchOperations('client visit history');
    expect(second.hits).toEqual(first.hits);
  });

  it('never returns more than the result cap', () => {
    const { hits } = searchOperations('location');
    expect(hits.length).toBeLessThanOrEqual(MAX_SEARCH_RESULTS);
  });

  it('honours the limit', () => {
    const { hits } = searchOperations('client', { limit: 3 });
    expect(hits).toHaveLength(3);
  });

  it('excludes V3 preview operations by default and includes them on request', () => {
    const hidden = searchOperations('oauth token', { limit: 10 });
    expect(hidden.hits.every((h) => h.source === 'v1')).toBe(true);

    const shown = searchOperations('oauth token', {
      includePreview: true,
      limit: 10,
    });
    expect(shown.hits.some((h) => h.source === 'v3')).toBe(true);
    expect(shown.hits.find((h) => h.source === 'v3')?.status).toBe('preview');
  });

  it('filters by domain and by method', () => {
    const byDomain = searchOperations('list', { domain: 'positions' });
    expect(byDomain.hits.length).toBeGreaterThan(0);
    expect(byDomain.hits.every((h) => h.domain === 'positions')).toBe(true);

    const byMethod = searchOperations('client', { method: 'DELETE' });
    expect(byMethod.hits.length).toBeGreaterThan(0);
    expect(byMethod.hits.every((h) => h.method === 'DELETE')).toBe(true);
  });

  it('returns nothing for a query with no signal', () => {
    const { hits, totalMatches } = searchOperations('zzzqqqx');
    expect(hits).toEqual([]);
    expect(totalMatches).toBe(0);
  });

  it('drops stopwords and single letters from the query', () => {
    expect(queryTerms('what is the schedule of a team member')).toEqual([
      'schedule',
      'team',
      'member',
    ]);
  });
});
