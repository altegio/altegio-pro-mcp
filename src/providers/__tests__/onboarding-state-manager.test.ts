import { OnboardingStateManager } from '../onboarding-state-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { runWithContext } from '../../request-context';

describe('OnboardingStateManager', () => {
  let manager: OnboardingStateManager;
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-test-'));
    manager = new OnboardingStateManager(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should initialize new onboarding session', async () => {
    const state = await manager.start(123);

    expect(state.company_id).toBe(123);
    expect(state.phase).toBe('init');
    expect(state.checkpoints).toEqual({});
    expect(state.started_at).toBeDefined();
  });

  it('should save and load state', async () => {
    const state = await manager.start(123);
    const loaded = await manager.load(123);

    expect(loaded).toEqual(state);
  });

  it('should create checkpoint with entity IDs', async () => {
    await manager.start(123);
    await manager.checkpoint(123, 'staff', [1, 2, 3]);

    const state = await manager.load(123);
    expect(state?.checkpoints['staff']).toBeDefined();
    expect(state?.checkpoints['staff']?.entity_ids).toEqual([1, 2, 3]);
    expect(state?.checkpoints['staff']?.completed).toBe(true);
  });

  it('should update phase', async () => {
    await manager.start(123);
    await manager.updatePhase(123, 'staff');

    const state = await manager.load(123);
    expect(state?.phase).toBe('staff');
  });

  it('isolates HTTP state by direct user token for the same company', async () => {
    const first = { identity: null, userToken: 'token-one' } as const;
    const second = { identity: null, userToken: 'token-two' } as const;

    await runWithContext(first, () => manager.start(123));
    await runWithContext(first, () => manager.checkpoint(123, 'staff', [1]));
    await runWithContext(second, () => manager.start(123));
    await runWithContext(second, () =>
      manager.checkpoint(123, 'services', [2])
    );

    expect(
      (await runWithContext(first, () => manager.load(123)))?.checkpoints
    ).toHaveProperty('staff');
    expect(
      (await runWithContext(first, () => manager.load(123)))?.checkpoints
    ).not.toHaveProperty('services');
    expect(
      (await runWithContext(second, () => manager.load(123)))?.checkpoints
    ).toHaveProperty('services');
  });

  it('isolates HTTP state by delegated identity when no direct token is present', async () => {
    const first = { identity: { kind: 'user' as const, sub: 'user-one' } };
    const second = { identity: { kind: 'user' as const, sub: 'user-two' } };

    await runWithContext(first, () => manager.start(123));
    expect(await runWithContext(second, () => manager.load(123))).toBeNull();
  });
});
