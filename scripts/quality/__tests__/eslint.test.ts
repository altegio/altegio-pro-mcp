/** Real ESLint probes: configuration regressions must not silently remove rules. */
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
function rules(source: string, filePath: string) {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import { ESLint } from 'eslint';
    const eslint = new ESLint();
    const [result] = await eslint.lintText(${JSON.stringify(source)}, { filePath: ${JSON.stringify(filePath)} });
    console.log(JSON.stringify(result.messages.map(m => m.ruleId)));
  `,
    ],
    { cwd: ROOT, encoding: 'utf8', timeout: 60_000 }
  );
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as string[];
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
