import { AltegioClient } from '../providers/altegio-client.js';
import { OnboardingStateManager } from '../providers/onboarding-state-manager.js';
import { z } from 'zod';
import { parseCSV, parseBooleanCell } from '../utils/csv-parser.js';
import { logger } from '../utils/logger.js';
import {
  withErrorHandling,
  withUntrustedBlock,
  type UntrustedField,
} from './tool-result.js';
import { AuthenticationError } from '../utils/errors.js';
import {
  seatChoiceRefusal,
  type MissingSeatChoice,
} from './staff-seat-choice.js';
import {
  StaffBatchSchema,
  type StaffBatchItem,
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
 * Append the rows a batch import could not create, inside the untrusted fence.
 *
 * A failed row carries two pieces of text nobody on this side wrote: the name
 * or title as it stood in the file the user brought, and the API's own
 * complaint about it. Onboarding is the one flow whose whole input is an
 * imported spreadsheet, so this is where a cell of that file would otherwise
 * land in the middle of our own report.
 */
function withFailedRows(summary: string, errors: readonly string[]): string {
  if (errors.length === 0) return summary;
  const rows: UntrustedField[] = errors.map((error, index) => ({
    label: `failed row ${index + 1}`,
    value: error,
  }));
  return withUntrustedBlock(
    `${summary}\n\n✗ ${errors.length} failed; each row and the reason the API gave are listed below.`,
    rows,
    { maxChars: 300 }
  );
}

/**
 * For a staff preview: how many rows still lack the paid-seat or work-schedule
 * answer, so the owner is asked before the import rather than after it
 * refuses. Blank or missing cells count as unanswered.
 */
function unansweredSeatNote(rows: readonly unknown[]): string {
  const answered = (row: unknown, key: string) =>
    typeof parseBooleanCell(
      row !== null && typeof row === 'object'
        ? (row as Record<string, unknown>)[key]
        : undefined
    ) === 'boolean';
  const unanswered = rows.filter(
    (row) =>
      !answered(row, 'is_paid_staff') || !answered(row, 'has_timetable_access')
  ).length;
  if (unanswered === 0) return '';
  return (
    `${unanswered} of ${rows.length} row(s) have no is_paid_staff or has_timetable_access answer. ` +
    'Before importing, ask the location owner whether each team member takes a paid staff seat (billed on per-seat licensing) ' +
    'and whether they should be in the work schedule to take appointments; never choose for them. ' +
    'Pass the answers per row or once for the whole list with the batch-level is_paid_staff and has_timetable_access.\n\n'
  );
}

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
  // The owner's one answer for every row that carries none of its own.
  is_paid_staff: z.boolean().optional(),
  has_timetable_access: z.boolean().optional(),
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
      // `isAuthenticated` only proves that a credential is present. Resolve
      // the requested location upstream before writing local state so an
      // expired/invalid token, or a valid user without access to this location,
      // cannot create or reset a checkpoint.
      await this.client.getLocation(location_id, { my: 1 });
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
            text: withFailedRows(
              `Positions batch processing complete:\n\n` +
                `✓ ${created.length} positions created\n` +
                `\nCreated position IDs: [${created.join(', ')}]\n` +
                `Use these position_id values when adding staff.\n` +
                `\nNext: Add staff with onboarding_add_staff_batch`,
              errors
            ),
          },
        ],
      };
    });
  }

  async addStaffBatch(args: unknown) {
    return withErrorHandling('onboarding_add_staff_batch', async () => {
      this.requireAuth();

      const {
        location_id,
        staff_data,
        is_paid_staff: batchPaidSeat,
        has_timetable_access: batchScheduleAccess,
      } = StaffBatchArgsSchema.parse(args);

      // Parse CSV if string
      const staffArray = StaffBatchSchema.parse(
        typeof staff_data === 'string' ? parseCSV(staff_data) : staff_data
      );

      // A row's own answer wins over the batch answer. A row with neither
      // refuses the whole batch before anything is created: a paid seat is
      // billed, so this server never picks one (see staff-seat-choice.ts).
      const rows: Array<{
        staff: StaffBatchItem;
        paidSeat: boolean;
        scheduleAccess: boolean;
      }> = [];
      const missing: MissingSeatChoice[] = [];
      staffArray.forEach((staff, index) => {
        const paidSeat = staff.is_paid_staff ?? batchPaidSeat;
        const scheduleAccess =
          staff.has_timetable_access ?? batchScheduleAccess;
        if (paidSeat !== undefined && scheduleAccess !== undefined) {
          rows.push({ staff, paidSeat, scheduleAccess });
          return;
        }
        const fields: MissingSeatChoice['fields'] = [];
        if (paidSeat === undefined) fields.push('is_paid_staff');
        if (scheduleAccess === undefined) fields.push('has_timetable_access');
        missing.push({ row: index + 1, fields });
      });
      if (missing.length > 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: seatChoiceRefusal(missing, staffArray.length),
            },
          ],
          isError: true,
        };
      }

      const created: number[] = [];
      const errors: string[] = [];
      let paidSeats = 0;
      let inSchedule = 0;

      for (const { staff, paidSeat, scheduleAccess } of rows) {
        try {
          const staffRequest: CreateStaffRequest = {
            name: staff.name,
            specialization: staff.specialization || '',
            position_id: staff.position_id || null,
            // Quick-create treats these as a link to an existing user and
            // refuses an unknown one without an invitation (an empty string
            // fails validation), so batch rows create team members only.
            user_email: null,
            user_phone: null,
            is_user_invite: false,
            is_paid_staff: paidSeat,
            has_timetable_access: scheduleAccess,
          };
          const result = await this.client.createStaff(
            location_id,
            staffRequest
          );
          created.push(result.id);
          if (staffRequest.is_paid_staff) paidSeats++;
          if (staffRequest.has_timetable_access) inSchedule++;
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
            text: withFailedRows(
              `Staff batch processing complete:\n\n` +
                `✓ ${created.length} staff members created ` +
                `(${paidSeats} on a paid staff seat, ${inSchedule} in the work schedule)\n` +
                `\nNext: Add service categories with onboarding_add_categories`,
              errors
            ),
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
            text: withFailedRows(
              `Categories batch processing complete:\n\n` +
                `✓ ${created.length} categories created\n` +
                `\nNext: Add services with onboarding_add_services_batch`,
              errors
            ),
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
            text: withFailedRows(
              `Services batch processing complete:\n\n` +
                `✓ ${created.length} services created\n` +
                `\nNext: Set work schedules with onboarding_set_schedules`,
              errors
            ),
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
            text: withFailedRows(
              `Client import complete:\n\n` +
                `✓ ${created.length} clients imported\n` +
                `\nNext: Create test appointments with onboarding_create_test_appointments`,
              errors
            ),
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
              // seance_length is required by the API; save_if_busy lets the
              // sample bookings land even if the test staff has no schedule.
              seance_length: 3600,
              save_if_busy: true,
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

      // This tool exists to show data the user brought from somewhere else:
      // every cell of it is free text written outside this server, and the
      // field names are whatever their file called them. All of it goes in the
      // fenced block, one field per row.
      const preview: UntrustedField[] = parsed.slice(0, 5).map((row, idx) => ({
        label: `row ${idx + 1}`,
        value: Object.entries(row)
          .map(([k, v]) => `${k}: ${v}`)
          .join(', '),
      }));

      const fieldCount = Object.keys(parsed[0]).length;
      const seatNote = data_type === 'staff' ? unansweredSeatNote(parsed) : '';
      const importTool = {
        staff: 'onboarding_add_staff_batch',
        services: 'onboarding_add_services_batch',
        clients: 'onboarding_import_clients',
        categories: 'onboarding_add_categories',
      }[data_type];

      return {
        content: [
          {
            type: 'text' as const,
            text: withUntrustedBlock(
              `Preview of ${data_type} data:\n\n` +
                `Total rows: ${parsed.length}\n` +
                `Fields per row: ${fieldCount}\n` +
                `Showing the first ${Math.min(5, parsed.length)} row(s) below, with the field names as the file spells them.\n\n` +
                seatNote +
                `Proceed with ${importTool} to create entities.`,
              [
                {
                  label: 'field names',
                  value: Object.keys(parsed[0]).join(', '),
                },
                ...preview,
              ],
              { maxChars: 400 }
            ),
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
      const failedIds: number[] = [];

      if (phase_name === 'positions') {
        throw new Error(
          'Positions cannot be rolled back: the supported public V1 API has list and quick-create operations but no position delete operation. The checkpoint was kept so the created IDs remain auditable.'
        );
      }

      // Delete entities based on phase type
      for (const id of entityIds) {
        try {
          if (phase_name === 'staff') {
            await this.client.deleteStaff(location_id, id);
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
            await this.client.deleteService(location_id, id);
            deletedCount.success++;
          } else if (phase_name === 'categories') {
            await this.client.deleteServiceCategory(location_id, id);
            deletedCount.success++;
          } else if (phase_name === 'clients') {
            await this.client.deleteClient(location_id, id);
            deletedCount.success++;
          } else {
            deletedCount.success++;
          }
        } catch (error) {
          logger.warn(
            { error, id, phase_name },
            `Failed to delete ${phase_name} entity`
          );
          deletedCount.failed++;
          failedIds.push(id);
        }
      }

      // Do not discard the only audit trail for entities that the API refused
      // to delete (for example a chain-owned category returning 403).
      if (failedIds.length === 0) {
        delete state.checkpoints[phase_name];
      } else {
        checkpoint.entity_ids = failedIds;
      }
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
                ? `✗ Failed: ${deletedCount.failed}; checkpoint retained for IDs [${failedIds.join(', ')}]\n`
                : ''),
          },
        ],
      };
    });
  }
}
