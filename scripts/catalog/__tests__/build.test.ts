/**
 * Catalog build tests (ADR-001 D4).
 *
 * These run the real script against the real spec repository, so they are
 * skipped with a notice when `biz.erp.api.docs` is not checked out — the same
 * contract as `npm run catalog:check` in CI.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const BUILD_SCRIPT = path.join(REPO_ROOT, 'scripts/catalog/build.mjs');
const COMMITTED = path.join(REPO_ROOT, 'src/generated/catalog.json');

function findDocsRoot(): string | null {
  const explicit = process.env.ALTEGIO_API_DOCS;
  if (explicit) {
    return fs.existsSync(path.join(explicit, 'docs/en/b2b-v1/openapi.yaml'))
      ? explicit
      : null;
  }
  let dir = REPO_ROOT;
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, '..', 'biz.erp.api.docs');
    if (fs.existsSync(path.join(candidate, 'docs/en/b2b-v1/openapi.yaml'))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const docsRoot = findDocsRoot();
const specAvailable = docsRoot !== null;

if (!specAvailable) {
  console.warn(
    'OpenAPI spec repository not found next to this repo — skipping catalog ' +
      'build tests. See OPENAPI.md.'
  );
}

/** Run the build script, returning stdout/stderr and the exit status. */
function runBuild(args: string[]): {
  status: number;
  stdout: string;
  stderr: string;
} {
  try {
    const stdout = execFileSync('node', [BUILD_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: err.status ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

describe('catalog build', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-build-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is deterministic — two builds produce byte-identical output', () => {
    if (!specAvailable) return;

    const a = path.join(tmpDir, 'a.json');
    const b = path.join(tmpDir, 'b.json');

    expect(runBuild(['--out', a, '--quiet']).status).toBe(0);
    expect(runBuild(['--out', b, '--quiet']).status).toBe(0);

    expect(fs.readFileSync(a, 'utf8')).toBe(fs.readFileSync(b, 'utf8'));
  });

  it('the committed catalog is up to date (this is what CI checks)', () => {
    if (!specAvailable) return;

    const result = runBuild(['--check']);
    expect(`${result.stdout}${result.stderr}`).toContain('catalog:check OK');
    expect(result.status).toBe(0);
  });

  it('skips with a notice, not a failure, when the spec repo is absent', () => {
    // An empty directory is a valid "no spec here" answer.
    const empty = path.join(tmpDir, 'no-spec');
    fs.mkdirSync(empty, { recursive: true });

    const result = runBuild(['--docs', empty, '--check']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('spec repository not found');
  });

  describe('committed catalog', () => {
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
      expect(events[0]?.path).toBe(
        '/locations/{location_id}/events/{event_id}'
      );
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
        (o) => o.operationId === 'get_service_list'
      );
      expect(services?.curation?.tool_name).toBe('services_list');
      expect(services?.curation?.projection).toContain('price_min');
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

  describe('overlay merge', () => {
    it('merges a custom overlay directory and validates its fields', () => {
      if (!specAvailable) return;

      const overlayDir = path.join(tmpDir, 'overlay');
      fs.mkdirSync(overlayDir, { recursive: true });
      fs.writeFileSync(
        path.join(overlayDir, 'probe.yaml'),
        [
          'version: 1',
          'operations:',
          '  get_team_member_list:',
          '    domain: probe_domain',
          '    tier: pack',
          '    tool_name: probe_tool',
          '    projection: [id, name]',
          '',
        ].join('\n')
      );

      const out = path.join(tmpDir, 'overlaid.json');
      expect(
        runBuild(['--overlay', overlayDir, '--out', out, '--quiet']).status
      ).toBe(0);

      const built = JSON.parse(fs.readFileSync(out, 'utf8')) as {
        curatedCount: number;
        operations: Array<{
          operationId: string;
          domain: string;
          curation?: { tool_name?: string; tier?: string };
        }>;
      };
      const staff = built.operations.find(
        (o) => o.operationId === 'get_team_member_list'
      );
      expect(staff?.curation?.tool_name).toBe('probe_tool');
      expect(staff?.curation?.tier).toBe('pack');
      // `domain` in the overlay overrides the domain inferred from the tag.
      expect(staff?.domain).toBe('probe_domain');
      expect(built.curatedCount).toBe(1);
    });

    it('fails the build on an unknown overlay field', () => {
      if (!specAvailable) return;

      const overlayDir = path.join(tmpDir, 'bad-overlay');
      fs.mkdirSync(overlayDir, { recursive: true });
      fs.writeFileSync(
        path.join(overlayDir, 'bad.yaml'),
        'version: 1\noperations:\n  get_team_member_list:\n    nonsense: true\n'
      );

      const result = runBuild([
        '--overlay',
        overlayDir,
        '--out',
        path.join(tmpDir, 'bad.json'),
        '--quiet',
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('unknown overlay field');
    });

    it('fails the build on an invalid tier', () => {
      if (!specAvailable) return;

      const overlayDir = path.join(tmpDir, 'bad-tier');
      fs.mkdirSync(overlayDir, { recursive: true });
      fs.writeFileSync(
        path.join(overlayDir, 'bad.yaml'),
        'version: 1\noperations:\n  get_team_member_list:\n    tier: whatever\n'
      );

      const result = runBuild([
        '--overlay',
        overlayDir,
        '--out',
        path.join(tmpDir, 'bad-tier.json'),
        '--quiet',
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('invalid tier');
    });

    /** Build with one overlay file and return the result. */
    function buildWith(name: string, overlay: string[]) {
      const overlayDir = path.join(tmpDir, name);
      fs.mkdirSync(overlayDir, { recursive: true });
      fs.writeFileSync(
        path.join(overlayDir, 'probe.yaml'),
        ['version: 1', 'operations:', ...overlay, ''].join('\n')
      );
      const out = path.join(tmpDir, `${name}.json`);
      return {
        out,
        ...runBuild(['--overlay', overlayDir, '--out', out, '--quiet']),
      };
    }

    it('retires a declared twin and records it under superseded', () => {
      if (!specAvailable) return;
      const result = buildWith('supersedes-ok', [
        '  list_team_members:',
        '    supersedes: [get_team_member_list]',
      ]);
      expect(result.status).toBe(0);
      const built = JSON.parse(fs.readFileSync(result.out, 'utf8')) as {
        curatedCount: number;
        operations: Array<{ operationId: string }>;
        superseded: Array<{ operationId: string; supersededBy: string }>;
      };
      expect(
        built.operations.some((o) => o.operationId === 'get_team_member_list')
      ).toBe(false);
      expect(built.superseded).toContainEqual(
        expect.objectContaining({
          operationId: 'get_team_member_list',
          supersededBy: 'list_team_members',
        })
      );
      expect(built.curatedCount).toBe(0);
    });

    it.each([
      [
        'a survivor from a spec that supersedes nothing',
        ['  get_service_list:', '    supersedes: [get_resource_list]'],
        'not an operation of a spec that supersedes another',
      ],
      [
        'a twin that is not a V1 operation',
        ['  list_events:', '    supersedes: [no_such_operation]'],
        'which is not a v1 operation',
      ],
      [
        'a twin already retired by its shared id',
        ['  list_events:', '    supersedes: [get_event]'],
        'already supersedes by the same id',
      ],
      [
        'one twin claimed by two survivors',
        [
          '  list_events:',
          '    supersedes: [search_events]',
          '  list_event_dates:',
          '    supersedes: [search_events]',
        ],
        'is superseded twice',
      ],
      [
        'curation left on a retired twin',
        [
          '  list_events:',
          '    supersedes: [search_events]',
          '  search_events:',
          '    tool_name: stale_tool',
        ],
        'move its curation to "list_events"',
      ],
      [
        'a malformed supersedes list',
        ['  list_events:', '    supersedes: search_events'],
        'invalid supersedes list',
      ],
    ])('fails the build on %s', (name, overlay, message) => {
      if (!specAvailable) return;
      const result = buildWith(`bad-${name.replace(/\W+/g, '-')}`, overlay);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(message);
    });
  });
});
