import { ConfirmationRefusal } from '../../tools/confirmation.js';
import { FinanceInputError } from '../finance/errors.js';
import { planConfirmed, planForConfirmation } from '../guarded-change.js';

const plan = (version: string) => async () => ({ version, change: 'x' });

describe('planForConfirmation', () => {
  it('returns the plan the confirmation shows', async () => {
    await expect(
      planForConfirmation(plan('v1'), FinanceInputError)
    ).resolves.toEqual({ version: 'v1', change: 'x' });
  });

  it('turns a refused plan into a refusal, said once', async () => {
    const error = await planForConfirmation(async () => {
      throw new FinanceInputError('Nothing was sold: the visit is closed.');
    }, FinanceInputError).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfirmationRefusal);
    expect((error as Error).message).toBe('the visit is closed.');
  });

  it('lets any other failure through', async () => {
    const failure = new Error('network');
    await expect(
      planForConfirmation(async () => {
        throw failure;
      }, FinanceInputError)
    ).rejects.toBe(failure);
  });
});

describe('planConfirmed', () => {
  const moved = () => new FinanceInputError('Nothing was changed: moved.');

  it('runs on the version the confirmation showed', async () => {
    await expect(
      planConfirmed(plan('v1'), { idempotency_key: 'k', version: 'v1' }, moved)
    ).resolves.toMatchObject({ version: 'v1' });
  });

  it('refuses when the state moved after the confirmation', async () => {
    await expect(
      planConfirmed(plan('v2'), { idempotency_key: 'k', version: 'v1' }, moved)
    ).rejects.toThrow('Nothing was changed: moved.');
  });

  it('does not check a call confirmed without a version', async () => {
    await expect(
      planConfirmed(plan('v2'), { idempotency_key: 'k' }, moved)
    ).resolves.toMatchObject({ version: 'v2' });
    await expect(
      planConfirmed(plan('v2'), undefined, moved)
    ).resolves.toBeTruthy();
  });
});
