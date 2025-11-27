import { OnboardingStateSchema, OnboardingPhase, StaffBatchSchema, ClientBatchSchema } from '../onboarding.types';

describe('Onboarding Types', () => {
  it('should validate valid onboarding state', () => {
    const validState = {
      company_id: 123,
      phase: 'init' as OnboardingPhase,
      started_at: '2025-01-29T10:00:00Z',
      updated_at: '2025-01-29T10:00:00Z',
      checkpoints: {},
      conversation_context: {}
    };

    const result = OnboardingStateSchema.safeParse(validState);
    expect(result.success).toBe(true);
  });

  it('should reject invalid phase', () => {
    const invalidState = {
      company_id: 123,
      phase: 'invalid_phase',
      started_at: '2025-01-29T10:00:00Z',
      updated_at: '2025-01-29T10:00:00Z',
      checkpoints: {},
      conversation_context: {}
    };

    const result = OnboardingStateSchema.safeParse(invalidState);
    expect(result.success).toBe(false);
  });
});

describe('Batch Schemas', () => {
  it('should validate staff batch', () => {
    const validBatch = [
      { name: 'Alice', specialization: 'Hairdresser' },
      { name: 'Bob', phone: '+1234567890' }
    ];

    const result = StaffBatchSchema.safeParse(validBatch);
    expect(result.success).toBe(true);
  });

  it('should reject client without phone or email', () => {
    const invalidBatch = [{ name: 'Alice' }];

    const result = ClientBatchSchema.safeParse(invalidBatch);
    expect(result.success).toBe(false);
  });
});
