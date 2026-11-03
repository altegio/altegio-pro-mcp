/** Structural contracts for the public, generated catalog. No private spec required. */
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const COMMITTED = path.resolve(
  __dirname,
  '../../../src/generated/catalog.json'
);

describe('committed catalog', () => {
  it('validates the real overlay and its curation against the public catalog', () => {
    const result = spawnSync(
      process.execPath,
      [path.resolve(__dirname, '../validate-overlay.mjs')],
      { encoding: 'utf8' }
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Public overlay check OK');
  });

  const catalog = JSON.parse(fs.readFileSync(COMMITTED, 'utf8')) as {
    catalogVersion: number;
    operationCount: number;
    curatedCount: number;
    supersededCount: number;
    canonicalAliases: Record<string, string>;
    sources: Array<{ source: string; operations: number }>;
    superseded: Array<{
      operationId: string;
      source: string;
      supersededBy: string;
      reason: string;
    }>;
    operations: Array<{
      operationId: string;
      method: string;
      path: string;
      displayPath: string;
      source: string;
      specOperationId?: string;
      status?: string;
      curation?: { tool_name?: string; projection?: string[] };
    }>;
  };

  it('has one entry per operation with a unique operationId', () => {
    expect(catalog.operations).toHaveLength(catalog.operationCount);
    const ids = new Set(catalog.operations.map((o) => o.operationId));
    expect(ids.size).toBe(catalog.operations.length);
  });

  it('carries every spec source and marks V3 entries with a status', () => {
    expect(catalog.sources.map((s) => s.source)).toEqual(['v1', 'v2', 'v3']);
    const v3 = catalog.operations.filter((o) => o.source === 'v3');
    expect(v3.length).toBeGreaterThan(0);
    for (const op of v3) expect(op.status).toBeDefined();
  });

  it('keeps V2 canonical: a same-id V1 twin leaves the catalog', () => {
    const events = catalog.operations.filter(
      (o) => o.operationId === 'get_event'
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.source).toBe('v2');
    expect(events[0]?.path).toBe('/locations/{location_id}/events/{event_id}');
    expect(catalog.superseded).toContainEqual(
      expect.objectContaining({
        operationId: 'get_event',
        source: 'v1',
        supersededBy: 'get_event',
        reason: 'same-id',
      })
    );
    expect(catalog.superseded).toHaveLength(catalog.supersededCount);
  });

  it('retires the V1 twins the overlay declares under supersedes', () => {
    expect(catalog.superseded).toContainEqual(
      expect.objectContaining({
        operationId: 'search_events',
        supersededBy: 'list_events',
        reason: 'declared',
      })
    );
    const ids = new Set(catalog.operations.map((o) => o.operationId));
    for (const retired of catalog.superseded) {
      expect(ids.has(retired.supersededBy)).toBe(true);
      if (retired.operationId !== retired.supersededBy) {
        expect(ids.has(retired.operationId)).toBe(false);
      }
    }
  });

  it('retires a V1 operation a V2 one serves at the same method and path', () => {
    const survivors = catalog.operations.filter(
      (o) =>
        o.method === 'GET' &&
        o.displayPath === '/locations/{location_id}/appointments' &&
        o.source !== 'v3'
    );
    expect(survivors.map((o) => o.operationId)).toEqual(['list_appointments']);
    const twin = catalog.superseded.find(
      (s) => s.operationId === 'get_appointment_list'
    ) as
      | {
          supersededBy: string;
          reason: string;
          parameters?: Array<{ name: string }>;
        }
      | undefined;
    expect(twin).toMatchObject({
      supersededBy: 'list_appointments',
      reason: 'same-path',
    });
    // The twin keeps its filters as the fallback route for what V2 lacks.
    expect(twin?.parameters?.map((p) => p.name)).toContain('team_member_id');

    // No live method + path is served twice.
    const routes = catalog.operations
      .filter((o) => o.source !== 'v3')
      .map((o) => `${o.method} ${o.displayPath.replace(/\{[^}]+\}/g, '{}')}`);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('drops the spec’s _v2 suffix and keeps the spec id internally', () => {
    const strategies = catalog.operations.find(
      (o) => o.operationId === 'list_event_duplication_strategies'
    );
    expect(strategies?.source).toBe('v2');
    expect(strategies?.specOperationId).toBe(
      'list_event_duplication_strategies_v2'
    );
    expect(
      catalog.operations.filter((o) => o.operationId.endsWith('_v2'))
    ).toEqual([]);
  });

  it('renames legacy path segments only in displayPath', () => {
    const appointment = catalog.operations.find(
      (o) => o.operationId === 'get_appointment'
    );
    expect(appointment?.path).toBe(
      '/locations/{location_id}/appointments/{record_id}'
    );
    expect(appointment?.displayPath).toBe(
      '/locations/{location_id}/appointments/{appointment_id}'
    );
  });

  it('exposes the canonical alias table', () => {
    expect(catalog.canonicalAliases).toMatchObject({
      company_id: 'location_id',
      staff_id: 'team_member_id',
      record_id: 'appointment_id',
      good_id: 'product_id',
    });
  });

  it('merges the overlay into curation for the hand-written tools', () => {
    const services = catalog.operations.find(
      (o) => o.operationId === 'list_services'
    );
    expect(services?.curation?.tool_name).toBe('services_list');
    expect(services?.curation?.projection).toContain('company_links.price_min');
    // A curated tool moves to the V2 survivor with its twin.
    const staff = catalog.operations.find(
      (o) => o.operationId === 'list_team_members'
    );
    expect(staff?.curation?.tool_name).toBe('team_members_list');

    // An entry that only names the twins it retires is not curation.
    const curated = catalog.operations.filter(
      (o) =>
        o.curation &&
        Object.keys(o.curation).some((field) => field !== 'supersedes')
    ).length;
    expect(curated).toBe(catalog.curatedCount);
  });
});
