import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

// The overrides cross majors because upstream Jest/ESLint still request
// vulnerable ranges. Exercise their real named CommonJS APIs and coverage
// selector, as well as the full lint/test/coverage runs on both Node targets.
const requireDependency = createRequire(join(process.cwd(), 'package.json'));
const glob = requireDependency('glob') as typeof import('glob');
const { Minimatch } = requireDependency(
  'minimatch'
) as typeof import('minimatch');
const TestExclude = requireDependency('test-exclude') as new (options: {
  cwd: string;
  include: string[];
  exclude: string[];
  extension: string[];
}) => { globSync(): string[]; glob(): Promise<string[]> };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'altegio-glob-compat-'));
  for (const name of [
    'src/index.ts',
    'src/index.test.ts',
    'src/feature/a.tsx',
    'src/generated/a.ts',
    'src/.hidden.ts',
    'docs/readme.md',
  ]) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, 'synthetic fixture');
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('preserves Jest/coverage glob async and sync APIs, ignore, braces and extglob', async () => {
  const pattern = 'src/**/!(*.test).{ts,tsx}';
  const options = {
    cwd: dir,
    nodir: true,
    dot: true,
    ignore: ['**/generated/**'],
  };
  const expected = ['src/.hidden.ts', 'src/feature/a.tsx', 'src/index.ts'];
  expect(glob.globSync(pattern, options).sort()).toEqual(expected);
  expect((await glob.glob(pattern, options)).sort()).toEqual(expected);
  expect(glob.glob.sync(pattern, options).sort()).toEqual(expected);
});

it('does not traverse after cancellation', async () => {
  const controller = new AbortController();
  controller.abort(new Error('synthetic traversal cancelled'));
  await expect(
    glob.glob('**/*', { cwd: dir, signal: controller.signal })
  ).rejects.toThrow('synthetic traversal cancelled');
});

it('preserves minimatch named API and optimized pattern semantics used by lint and coverage', () => {
  const pattern = new Minimatch('{src,examples}/**/!(*.test).{ts,tsx}', {
    dot: true,
    optimizationLevel: 2,
  });
  expect(pattern.match('src/feature/a.tsx')).toBe(true);
  expect(pattern.match('src/index.test.ts')).toBe(false);
  expect(pattern.match('docs/readme.md')).toBe(false);
  expect(pattern.match('src/.hidden.ts')).toBe(true);
});

it('preserves the real Istanbul test-exclude selector in synchronous and asynchronous modes', async () => {
  const selector = new TestExclude({
    cwd: dir,
    include: ['src/**'],
    exclude: ['**/*.test.ts', '**/generated/**'],
    extension: ['.ts', '.tsx'],
  });
  const expected = ['src/.hidden.ts', 'src/feature/a.tsx', 'src/index.ts'];
  expect(selector.globSync().sort()).toEqual(expected);
  expect((await selector.glob()).sort()).toEqual(expected);
});
