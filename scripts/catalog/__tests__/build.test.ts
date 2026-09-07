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
      canonicalAliases: Record<string, string>;
      sources: Array<{ source: string; operations: number }>;
      operations: Array<{
        operationId: string;
        method: string;
        path: string;
        displayPath: string;
        source: string;
        status?: string;
        curation?: { tool_name?: string; projection?: string[] };
      }>;
    };

    it('has one entry per operation with a unique operationId', () => {
      expect(catalog.operations).toHaveLength(catalog.operationCount);
      const ids = new Set(catalog.operations.map((o) => o.operationId));
      expect(ids.size).toBe(catalog.operations.length);
    });

    it('carries both spec sources and marks V3 entries with a status', () => {
      expect(catalog.sources.map((s) => s.source)).toEqual(['v1', 'v3']);
      const v3 = catalog.operations.filter((o) => o.source === 'v3');
      expect(v3.length).toBeGreaterThan(0);
      for (const op of v3) expect(op.status).toBeDefined();
    });

    it('renames legacy path segments only in displayPath', () => {
      const appointment = catalog.operations.find(
        (o) => o.operationId === 'get_appointment'
      );
      expect(appointment?.path).toBe('/record/{location_id}/{record_id}');
      expect(appointment?.displayPath).toBe(
        '/record/{location_id}/{appointment_id}'
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
      const staff = catalog.operations.find(
        (o) => o.operationId === 'get_team_member_list'
      );
      expect(staff?.curation?.tool_name).toBe('get_staff');
      expect(staff?.curation?.projection).toContain('specialization');

      const curated = catalog.operations.filter((o) => o.curation).length;
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
  });
});
