import * as fs from 'fs/promises';
import * as path from 'path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  OnboardingStateSchema,
  OnboardingPhaseSchema,
  ScheduleBatchItemSchema,
  ScheduleSlotInputSchema,
  toAgentPhase,
  type OnboardingState,
  type OnboardingPhase,
  type Checkpoint,
  type CheckpointBatch,
  type ScheduleBatchItem,
} from '../types/onboarding.types.js';
import { requestPrincipalKey } from '../request-context.js';

// Shared by every manager/handler instance in this Node process. A deployment
// must give each process its own state directory; this is not a distributed lock.
const sessionQueues = new Map<string, Promise<void>>();
const schedulesSchema = z.array(
  ScheduleBatchItemSchema.extend({ slots: z.array(ScheduleSlotInputSchema) })
);

function schedulesOf(batch: CheckpointBatch) {
  return schedulesSchema.parse(batch.metadata?.schedules);
}

function refreshCheckpoint(phase: OnboardingPhase, checkpoint: Checkpoint) {
  const batches = checkpoint.batches!;
  checkpoint.entity_ids = [...new Set(batches.flatMap((b) => b.entity_ids))];
  checkpoint.completed = batches.every((b) => b.completed);
  checkpoint.timestamp = batches.at(-1)!.timestamp;
  checkpoint.metadata =
    phase === 'schedules'
      ? { schedules: batches.flatMap(schedulesOf) }
      : batches.at(-1)!.metadata;
}

function validateState(value: unknown, companyId: number): OnboardingState {
  const state = OnboardingStateSchema.parse(value);
  if (state.company_id !== companyId) {
    throw new Error('Onboarding state location does not match its directory');
  }
  for (const phase of OnboardingPhaseSchema.options) {
    const checkpoint = state.checkpoints[phase];
    if (!checkpoint) continue;
    // Old files represent one surviving batch. Earlier overwritten IDs cannot
    // be recovered. Never infer them from an upstream location-wide listing.
    checkpoint.batches ??= [
      {
        id: `legacy-${phase}`,
        completed: checkpoint.completed,
        entity_ids: checkpoint.entity_ids,
        timestamp: checkpoint.timestamp,
        metadata: checkpoint.metadata,
      },
    ];
    const batches = checkpoint.batches;
    const ids = [...new Set(batches.flatMap((b) => b.entity_ids))];
    if (
      batches.length === 0 ||
      new Set(batches.map((b) => b.id)).size !== batches.length ||
      ids.length !== checkpoint.entity_ids.length ||
      ids.some((id) => !checkpoint.entity_ids.includes(id))
    ) {
      throw new Error('Inconsistent onboarding batch history');
    }
    if (phase === 'schedules') {
      for (const batch of batches) {
        const schedules = schedulesOf(batch);
        const staffIds = [...new Set(schedules.map((s) => s.team_member_id))];
        if (
          staffIds.length !== batch.entity_ids.length ||
          staffIds.some((id) => !batch.entity_ids.includes(id))
        ) {
          throw new Error('Incomplete onboarding schedule history');
        }
      }
    }
    refreshCheckpoint(phase, checkpoint);
  }
  state.version = 2;
  return state;
}

/** A session held exclusively until the callback returns, including API work. */
export class OnboardingSession {
  constructor(
    readonly state: OnboardingState,
    private readonly persist: () => Promise<void>
  ) {}

  async beginBatch(phase: OnboardingPhase, metadata?: Record<string, unknown>) {
    const batch: CheckpointBatch = {
      id: randomUUID(),
      completed: false,
      entity_ids: [],
      timestamp: new Date().toISOString(),
      metadata,
    };
    const checkpoint = (this.state.checkpoints[phase] ??= {
      completed: false,
      entity_ids: [],
      timestamp: batch.timestamp,
      batches: [],
    });
    checkpoint.batches!.push(batch);
    refreshCheckpoint(phase, checkpoint);
    this.state.phase = phase;
    // Prove the state can be persisted before the first upstream mutation.
    await this.commit();
    return batch;
  }

  async recordCreated(
    phase: OnboardingPhase,
    batch: CheckpointBatch,
    id: number
  ) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error(
        `Invalid created ${toAgentPhase(phase)} ID; stop and reconcile upstream state`
      );
    }
    batch.entity_ids = [...new Set([...batch.entity_ids, id])];
    refreshCheckpoint(phase, this.state.checkpoints[phase]!);
    try {
      await this.commit();
    } catch (cause) {
      throw new Error(
        `Created ${toAgentPhase(phase)} ID ${id}, but could not persist rollback progress. Stop and reconcile this ID before retrying.`,
        { cause }
      );
    }
  }

  async finishBatch(
    phase: OnboardingPhase,
    batch: CheckpointBatch,
    nextPhase: OnboardingPhase,
    failedRows = 0
  ) {
    batch.completed = true;
    batch.timestamp = new Date().toISOString();
    batch.metadata = { ...batch.metadata, failed_rows: failedRows };
    refreshCheckpoint(phase, this.state.checkpoints[phase]!);
    this.state.phase = nextPhase;
    await this.commit();
  }

  async recordSchedules(
    batch: CheckpointBatch,
    schedules: ScheduleBatchItem[]
  ) {
    batch.metadata = { ...batch.metadata, schedules };
    batch.entity_ids = [...new Set(schedules.map((s) => s.team_member_id))];
    refreshCheckpoint('schedules', this.state.checkpoints.schedules!);
    try {
      await this.commit();
    } catch (cause) {
      const day = schedules.at(-1)!;
      throw new Error(
        `Set schedule for team member ${day.team_member_id} on ${day.dates.join(', ')}, but could not persist rollback progress. Stop and reconcile this workday before retrying.`,
        { cause }
      );
    }
  }

  async checkpoint(
    phase: OnboardingPhase,
    entityIds: number[],
    metadata?: Record<string, unknown>
  ) {
    const batch: CheckpointBatch = {
      id: randomUUID(),
      completed: true,
      entity_ids: [...new Set(entityIds)],
      timestamp: new Date().toISOString(),
      metadata,
    };
    const checkpoint = (this.state.checkpoints[phase] ??= {
      completed: true,
      entity_ids: [],
      timestamp: batch.timestamp,
      batches: [],
    });
    checkpoint.batches!.push(batch);
    refreshCheckpoint(phase, checkpoint);
    this.state.phase = phase;
    await this.commit();
  }

  /** Persist each confirmed deletion before attempting the next one. */
  async removeCreated(phase: OnboardingPhase, id: number, date?: string) {
    const checkpoint = this.state.checkpoints[phase]!;
    for (const batch of checkpoint.batches!) {
      if (phase === 'schedules') {
        const schedules = schedulesOf(batch).flatMap((s) => {
          if (s.team_member_id !== id) return [s];
          const dates = s.dates.filter((d) => d !== date);
          return dates.length ? [{ ...s, dates }] : [];
        });
        batch.metadata = { ...batch.metadata, schedules };
        batch.entity_ids = [...new Set(schedules.map((s) => s.team_member_id))];
      } else
        batch.entity_ids = batch.entity_ids.filter((entry) => entry !== id);
    }
    refreshCheckpoint(phase, checkpoint);
    if (checkpoint.entity_ids.length === 0 && checkpoint.completed)
      delete this.state.checkpoints[phase];
    if (
      OnboardingPhaseSchema.options.indexOf(phase) <
      OnboardingPhaseSchema.options.indexOf(this.state.phase)
    )
      this.state.phase = phase;
    await this.commit();
  }

  async updatePhase(phase: OnboardingPhase) {
    this.state.phase = phase;
    await this.commit();
  }

  async clearEmptyCheckpoint(phase: OnboardingPhase) {
    const checkpoint = this.state.checkpoints[phase];
    if (checkpoint?.entity_ids.length === 0 && checkpoint.completed) {
      delete this.state.checkpoints[phase];
      await this.commit();
    }
  }

  private async commit() {
    this.state.updated_at = new Date().toISOString();
    await this.persist();
  }
}

export class OnboardingStateManager {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = path.resolve(
      baseDir ||
        path.join(
          process.env.HOME || process.env.USERPROFILE || '',
          '.altegio-mcp',
          'onboarding'
        )
    );
  }

  private getStatePath(companyId: number): string {
    z.number().int().positive().parse(companyId);
    const principal = requestPrincipalKey();
    return path.join(
      this.baseDir,
      ...(principal ? ['principals', principal] : []),
      companyId.toString(),
      'state.json'
    );
  }

  private async exclusive<T>(
    statePath: string,
    action: () => Promise<T>
  ): Promise<T> {
    const previous = sessionQueues.get(statePath) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    sessionQueues.set(statePath, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (sessionQueues.get(statePath) === current)
        sessionQueues.delete(statePath);
    }
  }

  async start(companyId: number): Promise<OnboardingState> {
    const statePath = this.getStatePath(companyId);
    return this.exclusive(statePath, async () => {
      const existing = await this.read(statePath, companyId);
      if (existing) return existing; // Starting twice must never erase rollback IDs.
      const now = new Date().toISOString();
      const state: OnboardingState = {
        version: 2,
        company_id: companyId,
        phase: 'init',
        started_at: now,
        updated_at: now,
        checkpoints: {},
        conversation_context: {},
      };
      await this.write(statePath, state);
      return state;
    });
  }

  async withSession<T>(
    companyId: number,
    action: (session: OnboardingSession) => Promise<T>
  ): Promise<T> {
    const statePath = this.getStatePath(companyId);
    return this.exclusive(statePath, async () => {
      const state = await this.read(statePath, companyId);
      if (!state)
        throw new Error(
          `No onboarding session found for location ${companyId}`
        );
      return action(
        new OnboardingSession(state, () => this.write(statePath, state))
      );
    });
  }

  private async write(
    statePath: string,
    state: OnboardingState
  ): Promise<void> {
    const content = JSON.stringify(
      validateState(state, Number(path.basename(path.dirname(statePath)))),
      null,
      2
    );
    const dir = path.dirname(statePath);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await this.protectDirectory(dir);
    const tempPath = `${statePath}.${randomUUID()}.tmp`;
    try {
      const file = await fs.open(tempPath, 'wx', 0o600);
      try {
        await file.writeFile(content, 'utf-8');
        await file.sync();
      } finally {
        await file.close();
      }
      await fs.rename(tempPath, statePath);
      const directory = await fs.open(dir, 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }

  private async protectDirectory(dir: string) {
    for (let current = dir; ; current = path.dirname(current)) {
      await fs.chmod(current, 0o700);
      if (current === this.baseDir) break;
    }
  }

  private async read(
    statePath: string,
    companyId: number
  ): Promise<OnboardingState | null> {
    let content: string;
    try {
      content = await fs.readFile(statePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const state = validateState(JSON.parse(content), companyId);
      await this.protectDirectory(path.dirname(statePath));
      await fs.chmod(statePath, 0o600);
      return state;
    } catch (cause) {
      throw new Error(
        `Invalid onboarding state for location ${companyId}; restore or reconcile it before importing`,
        { cause }
      );
    }
  }

  async load(companyId: number): Promise<OnboardingState | null> {
    const statePath = this.getStatePath(companyId);
    return this.exclusive(statePath, () => this.read(statePath, companyId));
  }

  async checkpoint(
    companyId: number,
    phase: OnboardingPhase,
    entityIds: number[],
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.withSession(companyId, (session) =>
      session.checkpoint(phase, entityIds, metadata)
    );
  }

  async updatePhase(companyId: number, phase: OnboardingPhase): Promise<void> {
    await this.withSession(companyId, (session) => session.updatePhase(phase));
  }
}
