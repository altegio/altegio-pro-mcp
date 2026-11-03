/** Real ESLint probes: configuration regressions must not silently remove rules. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
function rules(source: string, filePath: string) {
  // CI uses TypeScript's immutable program cache. lintText against an existing
  // path can then receive that file's on-disk types instead of the probe's.
  const directory = mkdtempSync(
    path.join(ROOT, path.dirname(filePath), 'eslint-probe-')
  );
  const probe = path.join(directory, `probe${path.extname(filePath)}`);
  try {
    writeFileSync(probe, source);
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import { ESLint } from 'eslint';
    const eslint = new ESLint();
    const [result] = await eslint.lintFiles([${JSON.stringify(probe)}]);
    console.log(JSON.stringify(result.messages.map(m => m.ruleId)));
  `,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: { ...process.env, TSESTREE_SINGLE_RUN: 'true' },
      }
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as string[];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('lint correctness configuration', () => {
  it('rejects unhandled promises, async void callbacks and awaiting plain values', () => {
    expect(
      rules(
        `
      Promise.resolve();
      [1].forEach(async () => { await Promise.resolve(); });
      async function probe() { await 42; }
      void probe();
    `,
        'src/server.ts'
      )
    ).toEqual(
      expect.arrayContaining([
        '@typescript-eslint/no-floating-promises',
        '@typescript-eslint/no-misused-promises',
        '@typescript-eslint/await-thenable',
      ])
    );
  });
  it('applies recommended correctness rules to JavaScript scripts too', () => {
    expect(
      rules(
        'const values = { duplicate: 1, duplicate: 2 }; console.log(values);',
        'scripts/catalog/probe.mjs'
      )
    ).toContain('no-dupe-keys');
  });
});
