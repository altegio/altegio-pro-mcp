/** Exercise the real generator with public synthetic inputs, without credentials. */
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const SCRIPT = path.join(ROOT, 'scripts/catalog/build.mjs');
const FIXTURES = path.join(__dirname, 'fixtures');
const SPEC = path.join(FIXTURES, 'spec');
const OVERLAY = path.join(FIXTURES, 'overlay');

type Operation = {
  operationId: string;
  specOperationId?: string;
  source: string;
  path: string;
  displayPath: string;
  domain: string;
  status?: string;
  parameters?: Array<{ name: string }>;
  response?: { envelope?: string; schema?: unknown };
  security?: { required: boolean };
  curation?: Record<string, unknown>;
};
type Catalog = {
  operations: Operation[];
  superseded: Array<Operation & { reason: string; supersededBy: string }>;
  curatedCount: number;
  sources: Array<{ source: string }>;
};

function run(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

let temp: string;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-fixture-'));
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

function build(overlay = OVERLAY, spec = SPEC) {
  const out = path.join(temp, 'catalog.json');
  const result = run(['--docs', spec, '--overlay', overlay, '--out', out]);
  return { ...result, out };
}
function read(out: string): Catalog {
  return JSON.parse(fs.readFileSync(out, 'utf8')) as Catalog;
}
function overlay(entries: Record<string, unknown>) {
  const dir = path.join(temp, 'overlay');
  fs.mkdirSync(dir, { recursive: true });
  // JSON is valid YAML. These inputs are independent of any private spec.
  fs.writeFileSync(
    path.join(dir, 'test.yaml'),
    JSON.stringify({ version: 1, operations: entries })
  );
  return dir;
}

describe('public catalog generator', () => {
  it.each([
    'hardlink',
    'device',
    'multiple-roots',
    'duplicate',
    'oversize',
    'absolute',
  ])(
    'rejects %s archives even with Python optimization and cleans partial extraction',
    (kind) => {
      const archive = path.join(temp, 'unsafe-extra.tar.gz');
      const destination = path.join(temp, 'extracted');
      const created = spawnSync(
        'python3',
        [
          '-c',
          `
import io, sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    first = tarfile.TarInfo('root/docs/en/first')
    first.size = 1
    archive.addfile(first, io.BytesIO(b'x'))
    kind = sys.argv[2]
    member = tarfile.TarInfo('root/docs/en/second')
    if kind == 'hardlink':
        member.type = tarfile.LNKTYPE
        member.linkname = 'root/docs/en/first'
    elif kind == 'device': member.type = tarfile.CHRTYPE
    elif kind == 'multiple-roots': member.name = 'other/docs/en/second'
    elif kind == 'duplicate': member.name = first.name
    elif kind == 'absolute': member.name = '/absolute/file'
    elif kind == 'oversize': member.size = 257 * 1024 * 1024
    if kind == 'oversize':
        header = member.tobuf()
        archive.fileobj.write(header)
        archive.offset += len(header)
    else: archive.addfile(member)
`,
          archive,
          kind,
        ],
        { encoding: 'utf8' }
      );
      expect(created.status).toBe(0);
      const result = spawnSync(
        'python3',
        [
          path.join(ROOT, 'scripts/catalog/extract-spec.py'),
          archive,
          destination,
        ],
        { encoding: 'utf8', env: { ...process.env, PYTHONOPTIMIZE: '2' } }
      );
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(destination)).toBe(false);
      expect(
        fs.readdirSync(temp).some((name) => name.startsWith('.spec-extract-'))
      ).toBe(false);
    }
  );

  it.each(['success', 'failure', 'exists'])(
    'keeps archive bytes private during packing and preserves cleanup on %s',
    (scenario) => {
      const destination = path.join(temp, 'private.tar.gz');
      const result = spawnSync(
        'python3',
        [
          '-c',
          `
import os, pathlib, runpy, stat, sys, tarfile
script, source, target, scenario = sys.argv[1:]
archive = pathlib.Path(target)
os.umask(0)
if scenario == 'exists': archive.write_bytes(b'preserve-existing')
original = tarfile.open
observed = False
def checked_open(*args, **kwargs):
    global observed
    if stat.S_IMODE(archive.stat().st_mode) != 0o600:
        raise AssertionError('Private bytes are readable during archive creation')
    observed = True
    if scenario == 'failure': raise OSError('synthetic packing failure')
    return original(*args, **kwargs)
tarfile.open = checked_open
sys.argv = [script, source, target]
try:
    runpy.run_path(script, run_name='__main__')
except FileExistsError:
    if scenario != 'exists': raise
except OSError:
    if scenario != 'failure': raise
else:
    if scenario != 'success': raise AssertionError('Expected failure')
if scenario == 'exists':
    if observed or archive.read_bytes() != b'preserve-existing':
        raise AssertionError('Existing archive changed')
elif not observed or (scenario == 'failure' and archive.exists()):
    raise AssertionError('Unsafe archive lifecycle')
`,
          path.join(ROOT, 'scripts/catalog/pack-spec.py'),
          SPEC,
          destination,
          scenario,
        ],
        { encoding: 'utf8' }
      );
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    }
  );

  it('packs reproducibly and exposes only the digest-covered subtree', () => {
    const source = path.join(temp, 'source');
    fs.cpSync(SPEC, source, { recursive: true });
    fs.writeFileSync(
      path.join(source, 'unverified.txt'),
      'not covered by the pin'
    );
    const first = path.join(temp, 'first.tar.gz');
    const second = path.join(temp, 'second.tar.gz');
    for (const archive of [first, second]) {
      const result = spawnSync(
        'python3',
        [path.join(ROOT, 'scripts/catalog/pack-spec.py'), source, archive],
        { encoding: 'utf8' }
      );
      expect(result.status).toBe(0);
    }
    expect(fs.readFileSync(first)).toEqual(fs.readFileSync(second));
    const destination = path.join(temp, 'packed');
    const result = spawnSync(
      'python3',
      [path.join(ROOT, 'scripts/catalog/extract-spec.py'), first, destination],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(destination, 'unverified.txt'))).toBe(false);
    expect(build(OVERLAY, destination).status).toBe(0);
  });

  it.each(['../escape', 'root/../../escape', 'link'])(
    'rejects unsafe private-archive input %s',
    (name) => {
      const archive = path.join(temp, 'unsafe.tar.gz');
      const created = spawnSync(
        'python3',
        [
          '-c',
          `
import sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    member = tarfile.TarInfo(sys.argv[2])
    if sys.argv[2] == 'link':
        member.name = 'root/link'
        member.type = tarfile.SYMTYPE
        member.linkname = '/etc/passwd'
    archive.addfile(member)
`,
          archive,
          name,
        ],
        { encoding: 'utf8' }
      );
      expect(created.status).toBe(0);
      const result = spawnSync(
        'python3',
        [
          path.join(ROOT, 'scripts/catalog/extract-spec.py'),
          archive,
          path.join(temp, 'sandbox/nested/extracted'),
        ],
        { encoding: 'utf8', env: { ...process.env, PYTHONOPTIMIZE: '1' } }
      );
      expect(result.status).not.toBe(0);
      expect(fs.existsSync(path.join(temp, 'sandbox/escape'))).toBe(false);
    }
  );

  it('extracts a normal source archive and verifies its synthetic contents', () => {
    const archive = path.join(temp, 'safe.tar.gz');
    const created = spawnSync(
      'python3',
      [
        '-c',
        `
import sys, tarfile
with tarfile.open(sys.argv[1], 'w:gz') as archive:
    archive.add(sys.argv[2], arcname='snapshot')
`,
        archive,
        SPEC,
      ],
      { encoding: 'utf8' }
    );
    expect(created.status).toBe(0);
    const destination = path.join(temp, 'extracted');
    const extracted = spawnSync(
      'python3',
      [
        path.join(ROOT, 'scripts/catalog/extract-spec.py'),
        archive,
        destination,
      ],
      { encoding: 'utf8' }
    );
    expect(extracted.stderr).toBe('');
    expect(extracted.status).toBe(0);
    const result = build(OVERLAY, destination);
    expect(result.status).toBe(0);
    expect(read(result.out).operations.length).toBeGreaterThan(0);
  });

  it('refuses a snapshot whose content does not match the real-spec pin', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(ROOT, 'scripts/catalog/verify-spec.mjs'), SPEC],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'Private spec content differs from the reviewed pin'
    );
  });

  it('is byte-deterministic, including when the input path order changes', () => {
    const first = build();
    expect(first.stderr).toBe('');
    expect(first.status).toBe(0);
    const bytes = fs.readFileSync(first.out, 'utf8');
    const copy = path.join(temp, 'spec');
    fs.cpSync(SPEC, copy, { recursive: true });
    const file = path.join(copy, 'docs/en/b2b-v1/openapi.yaml');
    // Re-encode with reversed path order; semantic inputs are unchanged.
    const yaml = createRequire(__filename)('js-yaml') as {
      load(text: string): { paths: Record<string, unknown> };
    };
    const doc = yaml.load(fs.readFileSync(file, 'utf8'));
    doc.paths = Object.fromEntries(Object.entries(doc.paths).reverse());
    fs.writeFileSync(file, JSON.stringify(doc));
    expect(build(OVERLAY, copy).status).toBe(0);
    expect(fs.readFileSync(first.out, 'utf8')).toBe(bytes);
  });

  it('resolves external path items, root schema refs, cycles and legacy aliases', () => {
    const result = build();
    expect(result.status).toBe(0);
    const op = read(result.out).operations.find(
      (o) => o.operationId === 'legacy_widgets'
    );
    expect(op?.path).toBe('/legacy/{company_id}/widgets');
    expect(op?.displayPath).toBe('/legacy/{location_id}/widgets');
    expect(op?.parameters?.map((p) => p.name)).toEqual(['company_id']);
    expect(op?.response?.envelope).toBe('v1');
    expect(JSON.stringify(op?.response?.schema)).toContain('x-circular');
    expect(op?.security).toMatchObject({ required: true });
    expect(
      read(result.out).operations.find((o) => o.operationId === 'standalone')
        ?.security
    ).toMatchObject({ required: false });
  });

  it('keeps canonical ids, preview status and curated domain/projection/failures', () => {
    const result = build();
    expect(result.status).toBe(0);
    const catalog = read(result.out);
    expect(catalog.sources.map((s) => s.source)).toEqual(['v1', 'v2', 'v3']);
    expect(
      catalog.operations.find((o) => o.operationId === 'preview_widgets')
        ?.status
    ).toBe('preview');
    expect(
      catalog.operations.find((o) => o.operationId === 'list_widgets')
    ).toMatchObject({
      specOperationId: 'list_widgets_v2',
      domain: 'widgets',
      curation: {
        tool_name: 'widgets_list',
        tier: 'pack',
        projection: ['id', 'title'],
        failures: { '416': 'No matching widget.' },
      },
      response: {
        envelope: 'jsonapi',
        schema: { type: 'array', items: { type: 'string' } },
      },
    });
    expect(catalog.curatedCount).toBe(1);
  });

  it('retires same-id, same-path and declared twins, retaining read filters only', () => {
    const result = build();
    expect(result.status).toBe(0);
    const retired = read(result.out).superseded;
    expect(retired).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operationId: 'get_widget',
          reason: 'same-id',
          supersededBy: 'get_widget',
        }),
        expect.objectContaining({
          operationId: 'old_widget_list',
          reason: 'same-path',
          parameters: [
            {
              name: 'staff_id',
              in: 'query',
              required: false,
              schema: { type: 'integer' },
            },
          ],
        }),
        expect.objectContaining({
          operationId: 'search_widgets',
          reason: 'declared',
          parameters: [
            {
              name: 'category',
              in: 'query',
              required: false,
              schema: { type: 'string' },
            },
          ],
        }),
      ])
    );
    expect(
      retired.find((o) => o.operationId === 'old_update_widget')?.parameters
    ).toBeUndefined();
  });

  it('detects drift instead of rewriting the target in check mode', () => {
    const result = build();
    expect(result.status).toBe(0);
    const args = [
      '--docs',
      SPEC,
      '--overlay',
      OVERLAY,
      '--out',
      result.out,
      '--check',
    ];
    expect(run(args).status).toBe(0);
    fs.writeFileSync(result.out, '{}\n');
    expect(run(args).status).toBe(1);
    expect(fs.readFileSync(result.out, 'utf8')).toBe('{}\n');
  });

  it.each([[[]], [['--check']]])(
    'fails explicitly when a requested spec is unavailable (%j)',
    (args) => {
      const result = run(['--docs', temp, ...args]);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('spec repository not found');
      expect(result.stdout).not.toContain('catalog:check OK');
    }
  );

  it.each([
    [
      'unknown overlay field',
      { list_widgets: { nonsense: true } },
      'unknown overlay field',
    ],
    ['invalid tier', { list_widgets: { tier: 'whatever' } }, 'invalid tier'],
    [
      'malformed supersedes',
      { list_widgets: { supersedes: 'search_widgets' } },
      'invalid supersedes list',
    ],
    [
      'success failure code',
      { list_widgets: { failures: { '200': 'Fine.' } } },
      'invalid failures map',
    ],
    [
      'authentication failure override',
      { list_widgets: { failures: { '401': 'Sign in.' } } },
      'invalid failures map',
    ],
    [
      'empty failure sentence',
      { list_widgets: { failures: { '416': '' } } },
      'invalid failures map',
    ],
    [
      'non-superseding source',
      { standalone: { supersedes: ['legacy_widgets'] } },
      'not an operation of a spec that supersedes',
    ],
    [
      'missing twin',
      { find_widgets: { supersedes: ['absent'] } },
      'not a v1 operation',
    ],
    [
      'already retired twin',
      { find_widgets: { supersedes: ['get_widget'] } },
      'already supersedes by the same id',
    ],
    [
      'twin claimed twice',
      {
        find_widgets: { supersedes: ['search_widgets'] },
        list_widgets: { supersedes: ['search_widgets'] },
      },
      'is superseded twice',
    ],
    [
      'curated declared twin',
      {
        find_widgets: { supersedes: ['search_widgets'] },
        search_widgets: { tool_name: 'stale' },
      },
      'move its curation to "find_widgets"',
    ],
    [
      'curated path twin',
      { old_widget_list: { tool_name: 'stale' } },
      'supersedes by its path',
    ],
  ])('rejects %s', (_name, entries, message) => {
    const result = build(overlay(entries));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(fs.existsSync(result.out)).toBe(false);
  });

  it('rejects duplicate overlay entries across files', () => {
    const dir = overlay({ list_widgets: { tier: 'pack' } });
    fs.copyFileSync(
      path.join(dir, 'test.yaml'),
      path.join(dir, 'duplicate.yaml')
    );
    expect(build(dir).stderr).toContain('duplicate overlay entry');
  });

  it('rejects unrelated operation id clashes instead of silently overriding', () => {
    const copy = path.join(temp, 'duplicate-spec');
    fs.cpSync(SPEC, copy, { recursive: true });
    const file = path.join(copy, 'docs/en/b2b-v3/openapi.yaml');
    fs.writeFileSync(
      file,
      fs.readFileSync(file, 'utf8').replace('preview_widgets', 'standalone')
    );
    const result = build(OVERLAY, copy);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('duplicate operationId');
  });
});

// Real drift is a separate, visibly skipped integration test. Opt in with an
// explicit snapshot; never discover a colleague's mutable checkout implicitly.
const docs = process.env.ALTEGIO_API_DOCS;
const realSpec =
  docs && fs.existsSync(path.join(docs, 'docs/en/b2b-v1/openapi.yaml'));
(realSpec ? describe : describe.skip)('real pinned specification', () => {
  it('matches the committed catalog', () => {
    const result = run(['--docs', docs!, '--check']);
    expect(`${result.stdout}${result.stderr}`).toContain('catalog:check OK');
    expect(result.status).toBe(0);
  });
});
