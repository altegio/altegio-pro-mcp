import * as fs from 'fs/promises';
import * as path from 'path';
import { OnboardingState, OnboardingPhase, Checkpoint } from '../types/onboarding.types.js';
import { logger } from '../utils/logger.js';

export class OnboardingStateManager {
  private baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir || path.join(
      process.env.HOME || process.env.USERPROFILE || '',
      '.altegio-mcp',
      'onboarding'
    );
  }

  private getStatePath(companyId: number): string {
    return path.join(this.baseDir, companyId.toString(), 'state.json');
  }

  async start(companyId: number): Promise<OnboardingState> {
    const now = new Date().toISOString();
    const state: OnboardingState = {
      company_id: companyId,
      phase: 'init',
      started_at: now,
      updated_at: now,
      checkpoints: {},
      conversation_context: {}
    };

    await this.save(state);
    logger.info({ company_id: companyId }, 'Onboarding session started');
    return state;
  }

  async save(state: OnboardingState): Promise<void> {
    const statePath = this.getStatePath(state.company_id);
    const dir = path.dirname(statePath);

    await fs.mkdir(dir, { recursive: true });

    // Atomic write: temp file + rename
    const tempPath = `${statePath}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(state, null, 2), 'utf-8');
    await fs.rename(tempPath, statePath);
  }

  async load(companyId: number): Promise<OnboardingState | null> {
    const statePath = this.getStatePath(companyId);

    try {
      const content = await fs.readFile(statePath, 'utf-8');
      return JSON.parse(content) as OnboardingState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async checkpoint(
    companyId: number,
    phase: OnboardingPhase,
    entityIds: number[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const state = await this.load(companyId);
    if (!state) {
      throw new Error(`No onboarding session found for company ${companyId}`);
    }

    const checkpoint: Checkpoint = {
      completed: true,
      entity_ids: entityIds,
      timestamp: new Date().toISOString(),
      metadata
    };

    state.checkpoints[phase] = checkpoint;
    state.updated_at = new Date().toISOString();
    state.phase = phase;

    await this.save(state);
    logger.info({ company_id: companyId, phase }, 'Checkpoint created');
  }

  async updatePhase(companyId: number, phase: OnboardingPhase): Promise<void> {
    const state = await this.load(companyId);
    if (!state) {
      throw new Error(`No onboarding session found for company ${companyId}`);
    }

    state.phase = phase;
    state.updated_at = new Date().toISOString();
    await this.save(state);
  }
}
