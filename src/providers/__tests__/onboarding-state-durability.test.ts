import { OnboardingStateManager } from '../onboarding-state-manager';
import { runWithContext } from '../../request-context';
import * as fs from 'node:fs';
import fsPromises from 'fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

describe('onboarding state durability', () => {
  let testDir: string;
  let first: OnboardingStateManager;
  let second: OnboardingStateManager;
  const statePath = () => path.join(testDir, '123', 'state.json');
  const diskState = () => JSON.parse(fs.readFileSync(statePath(), 'utf8'));

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-durability-'));
    first = new OnboardingStateManager(testDir);
    second = new OnboardingStateManager(path.join(testDir, '.'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('preserves all concurrent updates across manager instances with private, valid files', async () => {
    await first.start(123);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        Promise.all([
          first.checkpoint(123, 'positions', [i + 1], { batch: i }),
          second.checkpoint(123, 'staff', [i + 101]),
        ])
      )
    );
    const state = diskState();
    expect(state.checkpoints.positions.entity_ids).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1)
    );
    expect(state.checkpoints.staff.entity_ids).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 101)
    );
    expect(
      state.checkpoints.positions.batches.map(
        (b: { metadata: unknown }) => b.metadata
      )
    ).toEqual(Array.from({ length: 20 }, (_, batch) => ({ batch })));
    expect(fs.statSync(statePath()).mode & 0o777).toBe(0o600);
    expect(fs.statSync(testDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(statePath())).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(statePath()))).toEqual(['state.json']);
  });

  it('serializes phase transitions and repeated starts without losing checkpoints', async () => {
    await first.start(123);
    await Promise.all([
      first.checkpoint(123, 'positions', [1]),
      second.updatePhase(123, 'complete'),
      second.start(123),
    ]);
    expect(await first.load(123)).toMatchObject({
      phase: 'complete',
      checkpoints: { positions: { entity_ids: [1] } },
    });
    const state = await first.load(123);
    expect(await second.start(123)).toEqual(state);
  });

  it('keeps principal and location locks independent', async () => {
    const one = { identity: null, userToken: 'synthetic-one' } as const;
    const two = { identity: null, userToken: 'synthetic-two' } as const;
    await Promise.all([
      runWithContext(one, () => first.start(123)),
      runWithContext(two, () => second.start(123)),
      first.start(456),
    ]);
    await Promise.all([
      runWithContext(one, () => first.checkpoint(123, 'staff', [1])),
      runWithContext(two, () => second.checkpoint(123, 'staff', [2])),
      first.checkpoint(456, 'staff', [3]),
    ]);
    expect(
      (await runWithContext(one, () => second.load(123)))?.checkpoints.staff
        ?.entity_ids
    ).toEqual([1]);
    expect(
      (await runWithContext(two, () => first.load(123)))?.checkpoints.staff
        ?.entity_ids
    ).toEqual([2]);
    expect((await first.load(456))?.checkpoints.staff?.entity_ids).toEqual([3]);
  });

  it('leaves the previous JSON intact on failed replacement and releases its queue', async () => {
    await first.start(123);
    await first.checkpoint(123, 'positions', [1]);
    jest
      .spyOn(fsPromises, 'rename')
      .mockRejectedValueOnce(
        Object.assign(new Error('disk failure'), { code: 'EIO' })
      );
    await expect(second.checkpoint(123, 'positions', [2])).rejects.toThrow(
      'disk failure'
    );
    expect(diskState().checkpoints.positions.entity_ids).toEqual([1]);
    expect(fs.readdirSync(path.dirname(statePath()))).toEqual(['state.json']);
    await first.checkpoint(123, 'positions', [3]);
    expect(diskState().checkpoints.positions.entity_ids).toEqual([1, 3]);
  });

  it('migrates surviving legacy IDs as one batch without inventing missing history', async () => {
    const legacy = {
      company_id: 123,
      phase: 'positions',
      started_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      checkpoints: {
        positions: {
          completed: true,
          entity_ids: [7],
          timestamp: '2026-01-01T00:00:00Z',
          metadata: { source: 'legacy' },
        },
      },
      conversation_context: {},
    };
    fs.mkdirSync(path.dirname(statePath()));
    fs.writeFileSync(statePath(), JSON.stringify(legacy), { mode: 0o644 });
    expect((await first.load(123))?.checkpoints.positions?.batches).toEqual([
      expect.objectContaining({
        id: 'legacy-positions',
        entity_ids: [7],
        metadata: { source: 'legacy' },
      }),
    ]);
    expect(fs.statSync(statePath()).mode & 0o777).toBe(0o600);
    await second.checkpoint(123, 'positions', [8], { source: 'new' });
    expect(diskState()).toMatchObject({
      version: 2,
      checkpoints: { positions: { entity_ids: [7, 8] } },
    });
    expect(diskState().checkpoints.positions.batches).toHaveLength(2);
  });

  it.each([
    ['invalid JSON', '{'],
    ['wrong location', { company_id: 999 }],
    ['invalid ID', { company_id: -1 }],
    ['unknown version', { version: 3 }],
    ['unknown checkpoint phase', { checkpoints: { unknown: {} } }],
    [
      'invalid entity ID',
      {
        checkpoints: {
          staff: {
            completed: true,
            entity_ids: [0],
            timestamp: '2026-01-01T00:00:00Z',
          },
        },
      },
    ],
    [
      'inconsistent batch IDs',
      {
        checkpoints: {
          staff: {
            completed: true,
            entity_ids: [1],
            timestamp: '2026-01-01T00:00:00Z',
            batches: [
              {
                id: 'batch',
                completed: true,
                entity_ids: [2],
                timestamp: '2026-01-01T00:00:00Z',
              },
            ],
          },
        },
      },
    ],
    [
      'missing legacy schedule dates',
      {
        checkpoints: {
          schedules: {
            completed: true,
            entity_ids: [1],
            timestamp: '2026-01-01T00:00:00Z',
          },
        },
      },
    ],
  ])(
    'fails closed on %s and does not reset the file',
    async (_name, overrides) => {
      const valid = {
        company_id: 123,
        phase: 'init',
        started_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        checkpoints: {},
        conversation_context: {},
      };
      const content =
        typeof overrides === 'string'
          ? overrides
          : JSON.stringify({ ...valid, ...overrides });
      fs.mkdirSync(path.dirname(statePath()));
      fs.writeFileSync(statePath(), content);
      await expect(first.start(123)).rejects.toThrow(
        'Invalid onboarding state'
      );
      await expect(second.checkpoint(123, 'staff', [1])).rejects.toThrow(
        'Invalid onboarding state'
      );
      expect(fs.readFileSync(statePath(), 'utf8')).toBe(content);
    }
  );

  it('retains valid acknowledged progress after a killed writer and a sequential process restart', async () => {
    const moduleUrl = pathToFileURL(
      path.resolve(__dirname, '../onboarding-state-manager.ts')
    ).href;
    const code = `
      import { OnboardingStateManager } from ${JSON.stringify(moduleUrl)};
      const manager = new OnboardingStateManager(${JSON.stringify(testDir)});
      await manager.start(123);
      for (let id = 1; id < 100; id++) {
        await manager.checkpoint(123, 'staff', [id]);
        process.stdout.write(id + '\\n');
      }
    `;
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', code],
      {
        cwd: path.resolve(__dirname, '../../..'),
        env: {
          ...process.env,
          HOME: testDir,
          CREDENTIALS_DIR: path.join(testDir, 'credentials'),
          NODE_ENV: 'test',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let acknowledged = 0;
    let output = '';
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const lines = output.trim().split('\n').map(Number);
      acknowledged = Math.max(...lines);
      if (acknowledged >= 2) child.kill('SIGKILL');
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (_code, signal) =>
        signal === 'SIGKILL'
          ? resolve()
          : reject(new Error(errors || 'Writer exited without interruption'))
      );
    });
    const ids = diskState().checkpoints.staff.entity_ids;
    expect(ids.slice(0, acknowledged)).toEqual(
      Array.from({ length: acknowledged }, (_, i) => i + 1)
    );
    // A new process may resume only after the previous writer has stopped.
    const restart = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
      import { OnboardingStateManager } from ${JSON.stringify(moduleUrl)};
      await new OnboardingStateManager(${JSON.stringify(testDir)}).checkpoint(123, 'staff', [2000]);
    `,
      ],
      {
        cwd: path.resolve(__dirname, '../../..'),
        env: {
          ...process.env,
          HOME: testDir,
          CREDENTIALS_DIR: path.join(testDir, 'credentials'),
          NODE_ENV: 'test',
        },
        stdio: 'ignore',
      }
    );
    await new Promise<void>((resolve, reject) => {
      restart.once('error', reject);
      restart.once('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`Restart failed: ${code}`))
      );
    });
    expect((await first.load(123))?.checkpoints.staff?.entity_ids).toEqual([
      ...ids,
      2000,
    ]);
  }, 20000);
});
