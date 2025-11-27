import { OnboardingStateManager } from '../onboarding-state-manager';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
});
