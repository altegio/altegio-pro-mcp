import { z } from 'zod';

// Phase enum
export const OnboardingPhaseSchema = z.enum([
  'init',
  'staff',
  'categories',
  'services',
  'schedules',
  'clients',
  'test_bookings',
  'complete'
]);

export type OnboardingPhase = z.infer<typeof OnboardingPhaseSchema>;

// Checkpoint structure
export const CheckpointSchema = z.object({
  completed: z.boolean(),
  entity_ids: z.array(z.number()),
  timestamp: z.string(),
  metadata: z.record(z.unknown()).optional()
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

// Main state structure
export const OnboardingStateSchema = z.object({
  company_id: z.number(),
  phase: OnboardingPhaseSchema,
  started_at: z.string(),
  updated_at: z.string(),
  checkpoints: z.record(CheckpointSchema),
  conversation_context: z.record(z.unknown())
});

export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

// Batch input schemas
export const StaffBatchItemSchema = z.object({
  name: z.string().min(1),
  specialization: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  position_id: z.coerce.number().optional(),
  api_id: z.string().optional()
});

export const ServiceBatchItemSchema = z.object({
  title: z.string().min(1),
  price_min: z.coerce.number(),
  price_max: z.coerce.number().optional(),
  duration: z.coerce.number(),
  category_id: z.coerce.number().optional(),
  api_id: z.string().optional()
});

export const ClientBatchItemSchema = z.object({
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  surname: z.string().optional(),
  comment: z.string().optional()
}).refine(data => data.phone || data.email, {
  message: 'Either phone or email is required'
});

export const CategoryBatchItemSchema = z.object({
  title: z.string().min(1),
  api_id: z.string().optional(),
  weight: z.number().optional()
});

export const StaffBatchSchema = z.array(StaffBatchItemSchema);
export const ServiceBatchSchema = z.array(ServiceBatchItemSchema);
export const ClientBatchSchema = z.array(ClientBatchItemSchema);
export const CategoryBatchSchema = z.array(CategoryBatchItemSchema);

export type StaffBatchItem = z.infer<typeof StaffBatchItemSchema>;
export type ServiceBatchItem = z.infer<typeof ServiceBatchItemSchema>;
export type ClientBatchItem = z.infer<typeof ClientBatchItemSchema>;
export type CategoryBatchItem = z.infer<typeof CategoryBatchItemSchema>;
