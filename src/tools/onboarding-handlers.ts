import { AltegioClient } from '../providers/altegio-client.js';
import { OnboardingStateManager } from '../providers/onboarding-state-manager.js';
import { z } from 'zod';
import { parseCSV } from '../utils/csv-parser.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from './tool-result.js';
import { AuthenticationError } from '../utils/errors.js';
import {
  StaffBatchSchema,
  ServiceBatchSchema,
  ClientBatchSchema,
  CategoryBatchSchema,
  PositionBatchSchema,
  ScheduleBatchSchema,
} from '../types/onboarding.types.js';
import type {
  CreateStaffRequest,
  CreateServiceRequest,
  CreateClientRequest,
  CreateCategoryRequest,
  CreatePositionRequest,
  SetScheduleRequest,
} from '../types/altegio.types.js';

/**
 * Map an internal persisted phase key to its agent-facing name so no legacy
 * terminology leaks into tool output. The persisted state keeps the original key.
 */
function toAgentPhase(phase: string): string {
  return phase === 'test_bookings' ? 'test_appointments' : phase;
}

const LocationIdSchema = z.object({
  location_id: z.number(),
});

const StaffBatchArgsSchema = z.object({
  location_id: z.number(),
  staff_data: z.union([StaffBatchSchema, z.string()]),
});

const ServiceBatchArgsSchema = z.object({
  location_id: z.number(),
  services_data: z.union([ServiceBatchSchema, z.string()]),
});

const CategoryArgsSchema = z.object({
  location_id: z.number(),
  categories: CategoryBatchSchema,
});

const PositionBatchArgsSchema = z.object({
  location_id: z.number(),
  positions: z.union([PositionBatchSchema, z.string()]),
});

const ScheduleBatchArgsSchema = z.object({
  location_id: z.number(),
  schedules: ScheduleBatchSchema,
});

const ClientImportArgsSchema = z.object({
  location_id: z.number(),
  clients_csv: z.string(),
});

const TestBookingsArgsSchema = z.object({
  location_id: z.number(),
  count: z.number().min(1).max(10).default(5),
});

const PreviewArgsSchema = z.object({
  data_type: z.enum(['staff', 'services', 'clients', 'categories']),
  raw_input: z.string(),
});

const RollbackArgsSchema = z.object({
  location_id: z.number(),
  phase_name: z.string(),
});

export class OnboardingHandlers {
  constructor(
    private client: AltegioClient,
    private stateManager: OnboardingStateManager
  ) {}

  private requireAuth(): void {
    if (!this.client.isAuthenticated()) {
      throw new AuthenticationError(
        'Not authenticated. Call altegio_login first.'
      );
    }
  }

  async start(args: unknown) {
    return withErrorHandling('onboarding_start', async () => {
      this.requireAuth();

      const { location_id } = LocationIdSchema.parse(args);
      const state = await this.stateManager.start(location_id);

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Onboarding session started for location ${location_id}.\n\n` +
              `Current phase: ${toAgentPhase(state.phase)}\n` +
              `Started at: ${state.started_at}\n\n` +
              `Recommended steps (in order):\n` +
              `1. Add positions: onboarding_add_positions\n` +
              `2. Add staff: onboarding_add_staff_batch\n` +
              `3. Add service categories: onboarding_add_categories\n` +
              `4. Add services: onboarding_add_services_batch\n` +
              `5. Set work schedules: onboarding_set_schedules\n` +
              `6. Import clients: onboarding_import_clients\n` +
              `7. Create test appointments: onboarding_create_test_appointments`,
          },
        ],
      };
    });
  }

  async resume(args: unknown) {
    return withErrorHandling('onboarding_resume', async () => {
      this.requireAuth();

      const { location_id } = LocationIdSchema.parse(args);
      const state = await this.stateManager.load(location_id);

      if (!state) {
        throw new Error(
          `No onboarding session found for location ${location_id}`
        );
      }

      const completedPhases = Object.entries(state.checkpoints)
        .filter(([, checkpoint]) => checkpoint.completed)
        .map(
          ([phase, checkpoint]) =>
            `  - ${toAgentPhase(phase)}: ${checkpoint.entity_ids.length} entities created`
        )
        .join('\n');

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Onboarding session for location ${location_id}\n\n` +
              `Current phase: ${toAgentPhase(state.phase)}\n` +
              `Started: ${state.started_at}\n\n` +
              `Completed:\n${completedPhases || '  (none yet)'}\n\n` +
              `Continue with next step based on current phase.`,
          },
        ],
      };
    });
  }

  async status(args: unknown) {
    return withErrorHandling('onboarding_status', async () => {
      this.requireAuth();

      const { location_id } = LocationIdSchema.parse(args);
      const state = await this.stateManager.load(location_id);

      if (!state) {
        throw new Error(
          `No onboarding session found for location ${location_id}`
        );
      }

      const totalEntities = Object.values(state.checkpoints).reduce(
        (sum, cp) => sum + cp.entity_ids.length,
        0
      );

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Onboarding Status - Location ${location_id}\n\n` +
              `Phase: ${toAgentPhase(state.phase)}\n` +
              `Total entities created: ${totalEntities}\n` +
              `Phases completed: ${Object.keys(state.checkpoints).length}`,
          },
        ],
      };
    });
  }

  async addPositions(args: unknown) {
    return withErrorHandling('onboarding_add_positions', async () => {
      this.requireAuth();

      const { location_id, positions } = PositionBatchArgsSchema.parse(args);

      // Parse CSV if string
      let positionsArray =
        typeof positions === 'string' ? parseCSV(positions) : positions;

      // Validate with Zod
      positionsArray = PositionBatchSchema.parse(positionsArray);

      const created: number[] = [];
      const errors: string[] = [];

      for (const position of positionsArray) {
        try {
          const positionRequest: CreatePositionRequest = {
            title: position.title,
            api_id: position.api_id,
          };
          const result = await this.client.createPosition(
            location_id,
            positionRequest
          );
          created.push(result.id);
        } catch (error) {
          errors.push(`${position.title}: ${(error as Error).message}`);
        }
      }

      // Checkpoint
      await this.stateManager.checkpoint(location_id, 'positions', created);
      await this.stateManager.updatePhase(location_id, 'staff');

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Positions batch processing complete:\n\n` +
              `✓ ${created.length} positions created\n` +
              (errors.length
                ? `✗ ${errors.length} failed:\n  ${errors.join('\n  ')}\n`
                : '') +
              `\nCreated position IDs: [${created.join(', ')}]\n` +
              `Use these position_id values when adding staff.\n` +
              `\nNext: Add staff with onboarding_add_staff_batch`,
          },
        ],
      };
    });
  }

  async addStaffBatch(args: unknown) {
    return withErrorHandling('onboarding_add_staff_batch', async () => {
      this.requireAuth();

      const { location_id, staff_data } = StaffBatchArgsSchema.parse(args);

      // Parse CSV if string
      let staffArray =
        typeof staff_data === 'string' ? parseCSV(staff_data) : staff_data;

      // Validate with Zod
      staffArray = StaffBatchSchema.parse(staffArray);

      const created: number[] = [];
      const errors: string[] = [];

      for (const staff of staffArray) {
        try {
          const staffRequest: CreateStaffRequest = {
            name: staff.name,
            specialization: staff.specialization || '',
            position_id: staff.position_id || null,
            phone_number: staff.phone || null,
            user_email: staff.email || '',
            user_phone: staff.phone || '',
            is_user_invite: false,
          };
          const result = await this.client.createStaff(
            location_id,
            staffRequest
          );
          created.push(result.id);
        } catch (error) {
          errors.push(`${staff.name}: ${(error as Error).message}`);
        }
      }

      // Checkpoint
      await this.stateManager.checkpoint(location_id, 'staff', created);
      await this.stateManager.updatePhase(location_id, 'categories');

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Staff batch processing complete:\n\n` +
              `✓ ${created.length} staff members created\n` +
              (errors.length
                ? `✗ ${errors.length} failed:\n  ${errors.join('\n  ')}\n`
                : '') +
              `\nNext: Add service categories with onboarding_add_categories`,
          },
        ],
      };
    });
  }

  async addCategories(args: unknown) {
    return withErrorHandling('onboarding_add_categories', async () => {
      this.requireAuth();

      const { location_id, categories } = CategoryArgsSchema.parse(args);

      const created: number[] = [];
      const errors: string[] = [];

      for (const category of categories) {
        try {
          const categoryRequest: CreateCategoryRequest = {
            title: category.title,
            api_id: category.api_id,
            weight: category.weight,
          };
          const result = await this.client.createServiceCategory(
            location_id,
            categoryRequest
          );
          created.push(result.id);
        } catch (error) {
          errors.push(`${category.title}: ${(error as Error).message}`);
        }
      }

      // Checkpoint
      await this.stateManager.checkpoint(location_id, 'categories', created);
      await this.stateManager.updatePhase(location_id, 'services');

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Categories batch processing complete:\n\n` +
              `✓ ${created.length} categories created\n` +
              (errors.length
                ? `✗ ${errors.length} failed:\n  ${errors.join('\n  ')}\n`
                : '') +
              `\nNext: Add services with onboarding_add_services_batch`,
          },
        ],
      };
    });
  }

  async addServicesBatch(args: unknown) {
    return withErrorHandling('onboarding_add_services_batch', async () => {
      this.requireAuth();

      const { location_id, services_data } = ServiceBatchArgsSchema.parse(args);

      // Parse CSV if string
      let servicesArray =
        typeof services_data === 'string'
          ? parseCSV(services_data)
          : services_data;

      // Validate with Zod
      servicesArray = ServiceBatchSchema.parse(servicesArray);

      const created: number[] = [];
      const errors: string[] = [];

      for (const service of servicesArray) {
        try {
          const serviceRequest: CreateServiceRequest = {
            title: service.title,
            category_id: service.category_id || 0,
            price_min: service.price_min,
            price_max: service.price_max,
            duration: service.duration,
          };
          const result = await this.client.createService(
            location_id,
            serviceRequest
          );
          created.push(result.id);
        } catch (error) {
          errors.push(`${service.title}: ${(error as Error).message}`);
        }
      }

      // Checkpoint
      await this.stateManager.checkpoint(location_id, 'services', created);
      await this.stateManager.updatePhase(location_id, 'schedules');

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Services batch processing complete:\n\n` +
              `✓ ${created.length} services created\n` +
              (errors.length
                ? `✗ ${errors.length} failed:\n  ${errors.join('\n  ')}\n`
                : '') +
              `\nNext: Set work schedules with onboarding_set_schedules`,
          },
        ],
      };
    });
  }

  async setSchedules(args: unknown) {
    return withErrorHandling('onboarding_set_schedules', async () => {
      this.requireAuth();

      const { location_id, schedules } = ScheduleBatchArgsSchema.parse(args);

      if (schedules.length === 0) {
        throw new Error('No schedules provided.');
      }

      const request: SetScheduleRequest = {
        schedules_to_set: schedules.map((s) => ({
          team_member_id: s.team_member_id,
          dates: s.dates,
          slots: s.slots,
        })),
      };

      await this.client.setSchedule(location_id, request);

      const staffIds = [...new Set(schedules.map((s) => s.team_member_id))];

      // Checkpoint — store the full set in metadata so rollback can delete it
      await this.stateManager.checkpoint(location_id, 'schedules', staffIds, {
        schedules,
      });
      await this.stateManager.updatePhase(location_id, 'clients');

      const summary = schedules
        .map(
          (s) =>
            `  - team member ${s.team_member_id}: ${s.dates.length} day(s), ${s.slots
              .map((sl) => `${sl.from}-${sl.to}`)
              .join(', ')}`
        )
        .join('\n');

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Work schedules set for ${staffIds.length} staff member(s):\n\n` +
              `${summary}\n\n` +
              `Next: Import clients with onboarding_import_clients`,
          },
        ],
      };
    });
  }

  async importClients(args: unknown) {
    return withErrorHandling('onboarding_import_clients', async () => {
      this.requireAuth();

      const { location_id, clients_csv } = ClientImportArgsSchema.parse(args);

      // Parse CSV
      const parsedClients = parseCSV(clients_csv);

      // Validate with Zod
      const clientsArray = ClientBatchSchema.parse(parsedClients);

      const created: number[] = [];
      const errors: string[] = [];

      for (const client of clientsArray) {
        try {
          const clientRequest: CreateClientRequest = {
            name: client.name,
            phone: client.phone,
            email: client.email,
            surname: client.surname,
            comment: client.comment,
          };
          const result = await this.client.createClient(
            location_id,
            clientRequest
          );
          created.push(result.id);
        } catch (error) {
          errors.push(`${client.name}: ${(error as Error).message}`);
        }
      }

      // Checkpoint
      await this.stateManager.checkpoint(location_id, 'clients', created);
      await this.stateManager.updatePhase(location_id, 'test_bookings');

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Client import complete:\n\n` +
              `✓ ${created.length} clients imported\n` +
              (errors.length
                ? `✗ ${errors.length} failed:\n  ${errors.join('\n  ')}\n`
                : '') +
              `\nNext: Create test appointments with onboarding_create_test_appointments`,
          },
        ],
      };
    });
  }

  async createTestBookings(args: unknown) {
    return withErrorHandling(
      'onboarding_create_test_appointments',
      async () => {
        this.requireAuth();

        const { location_id, count } = TestBookingsArgsSchema.parse(args);
        const state = await this.stateManager.load(location_id);

        if (!state) {
          throw new Error(
            `No onboarding session found for location ${location_id}`
          );
        }

        const staffIds = state.checkpoints['staff']?.entity_ids || [];
        const serviceIds = state.checkpoints['services']?.entity_ids || [];

        if (staffIds.length === 0 || serviceIds.length === 0) {
          throw new Error(
            'No staff or services found. Complete previous steps first.'
          );
        }

        const created: number[] = [];

        for (let i = 0; i < count; i++) {
          const staffId = staffIds[i % staffIds.length]!;
          const serviceId = serviceIds[i % serviceIds.length]!;

          // Generate appointment 1-7 days in future
          const daysAhead = 1 + (i % 7);
          const date = new Date();
          date.setDate(date.getDate() + daysAhead);
          const datetime = date.toISOString().split('T')[0] + ' 10:00:00';

          try {
            const appointment = await this.client.createBooking(location_id, {
              staff_id: staffId,
              services: [{ id: serviceId }],
              datetime,
              client: {
                name: `Test Client ${i + 1}`,
                phone: `+100000000${i}`,
              },
            });
            created.push(appointment.id);
          } catch (error) {
            logger.warn({ error }, 'Failed to create test appointment');
          }
        }

        await this.stateManager.checkpoint(
          location_id,
          'test_bookings',
          created
        );
        await this.stateManager.updatePhase(location_id, 'complete');

        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Test appointments created: ${created.length}\n\n` +
                `Onboarding complete! ✓\n\n` +
                `Summary:\n` +
                `  - Staff: ${staffIds.length}\n` +
                `  - Services: ${serviceIds.length}\n` +
                `  - Test appointments: ${created.length}\n\n` +
                `Your platform is ready to use!`,
            },
          ],
        };
      }
    );
  }

  async previewData(args: unknown) {
    return withErrorHandling('onboarding_preview_data', async () => {
      const { data_type, raw_input } = PreviewArgsSchema.parse(args);

      // Try to parse as JSON first, fall back to CSV
      let parsed;
      try {
        // Attempt JSON parse
        const jsonData = JSON.parse(raw_input);
        parsed = Array.isArray(jsonData) ? jsonData : [jsonData];
      } catch {
        // Fall back to CSV parsing
        parsed = parseCSV(raw_input);
      }

      if (parsed.length === 0 || !parsed[0]) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No data parsed. Check CSV format or JSON structure.',
            },
          ],
        };
      }

      const preview = parsed
        .slice(0, 5)
        .map(
          (row, idx) =>
            `${idx + 1}. ${Object.entries(row)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', ')}`
        )
        .join('\n');

      const fieldCount = Object.keys(parsed[0]).length;

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Preview of ${data_type} data:\n\n` +
              `Total rows: ${parsed.length}\n` +
              `Fields: ${fieldCount} (${Object.keys(parsed[0]).join(', ')})\n\n` +
              `First ${Math.min(5, parsed.length)} rows:\n${preview}\n\n` +
              `Proceed with onboarding_add_${data_type}_batch to create entities.`,
          },
        ],
      };
    });
  }

  async rollbackPhase(args: unknown) {
    return withErrorHandling('onboarding_rollback_phase', async () => {
      this.requireAuth();

      const { location_id, phase_name: requestedPhase } =
        RollbackArgsSchema.parse(args);
      // Agent-facing "test_appointments" maps to the internal persisted phase key.
      const phase_name =
        requestedPhase === 'test_appointments'
          ? 'test_bookings'
          : requestedPhase;
      const state = await this.stateManager.load(location_id);

      if (!state || !state.checkpoints[phase_name]) {
        throw new Error(
          `No checkpoint found for phase: ${toAgentPhase(requestedPhase)}`
        );
      }

      const checkpoint = state.checkpoints[phase_name];
      const entityIds = checkpoint.entity_ids;
      const deletedCount = { success: 0, failed: 0 };
      let servicesNote = '';

      // Delete entities based on phase type
      for (const id of entityIds) {
        try {
          if (phase_name === 'staff') {
            await this.client.deleteStaff(location_id, id);
            deletedCount.success++;
          } else if (phase_name === 'positions') {
            await this.client.deletePosition(location_id, id);
            deletedCount.success++;
          } else if (phase_name === 'schedules') {
            // entity_ids are staff IDs; dates come from checkpoint metadata
            const meta = (checkpoint.metadata?.schedules ?? []) as Array<{
              team_member_id: number;
              dates: string[];
            }>;
            const dates = meta
              .filter((s) => s.team_member_id === id)
              .flatMap((s) => s.dates);
            if (dates.length > 0) {
              await this.client.setSchedule(location_id, {
                schedules_to_delete: [{ team_member_id: id, dates }],
              });
            }
            deletedCount.success++;
          } else if (phase_name === 'test_bookings') {
            await this.client.deleteBooking(location_id, id);
            deletedCount.success++;
          } else if (phase_name === 'services') {
            servicesNote =
              '\nNote: Services cannot be deleted via API. Checkpoint removed but entities remain.';
            deletedCount.success++;
          } else if (phase_name === 'categories') {
            servicesNote =
              '\nNote: Categories cannot be deleted via API. Checkpoint removed but entities remain.';
            deletedCount.success++;
          } else if (phase_name === 'clients') {
            try {
              if (
                'deleteClient' in this.client &&
                typeof this.client.deleteClient === 'function'
              ) {
                await (this.client as any).deleteClient(location_id, id);
                deletedCount.success++;
              } else {
                servicesNote =
                  '\nNote: Client deletion is not implemented in API.';
                deletedCount.success++;
              }
            } catch {
              servicesNote =
                '\nNote: Client deletion may not be supported via API.';
              deletedCount.success++;
            }
          } else {
            deletedCount.success++;
          }
        } catch (error) {
          logger.warn(
            { error, id, phase_name },
            `Failed to delete ${phase_name} entity`
          );
          deletedCount.failed++;
        }
      }

      // Remove checkpoint from state
      delete state.checkpoints[phase_name];
      state.updated_at = new Date().toISOString();
      await this.stateManager.save(state);

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Rolled back ${toAgentPhase(requestedPhase)}: processed ${entityIds.length} entities\n` +
              `✓ Successfully handled: ${deletedCount.success}\n` +
              (deletedCount.failed > 0
                ? `✗ Failed: ${deletedCount.failed}\n`
                : '') +
              servicesNote,
          },
        ],
      };
    });
  }
}
