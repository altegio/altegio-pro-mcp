import { OnboardingHandlers } from '../onboarding-handlers';
import { OnboardingStateManager } from '../../providers/onboarding-state-manager';
import type { AltegioClient } from '../../providers/altegio-client';
import { AltegioApiError } from '../../utils/errors';
import * as fs from 'node:fs';
import fsPromises from 'fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const LOCATION = 123;
const batchCases = [
  {
    phase: 'positions',
    method: 'addPositions',
    create: 'createPosition',
    remove: 'deletePosition',
    args: { positions: [{ title: 'First' }, { title: 'Retry' }] },
    retry: { positions: [{ title: 'Retry' }] },
  },
  {
    phase: 'staff',
    method: 'addStaffBatch',
    create: 'createStaff',
    remove: 'deleteStaff',
    args: {
      team_members: [{ name: 'First' }, { name: 'Retry' }],
      has_paid_seat: false,
      has_schedule_access: true,
    },
    retry: {
      team_members: [{ name: 'Retry' }],
      has_paid_seat: false,
      has_schedule_access: true,
    },
  },
  {
    phase: 'categories',
    method: 'addCategories',
    create: 'createServiceCategory',
    remove: 'deleteServiceCategory',
    args: { categories: [{ title: 'First' }, { title: 'Retry' }] },
    retry: { categories: [{ title: 'Retry' }] },
  },
  {
    phase: 'services',
    method: 'addServicesBatch',
    create: 'createService',
    remove: 'deleteService',
    args: {
      services: [
        { title: 'First', price_min: 10, duration_seconds: 900 },
        { title: 'Retry', price_min: 10, duration_seconds: 900 },
      ],
    },
    retry: {
      services: [{ title: 'Retry', price_min: 10, duration_seconds: 900 }],
    },
  },
  {
    phase: 'clients',
    method: 'importClients',
    create: 'createClient',
    remove: 'deleteClient',
    args: { clients_csv: 'name,phone\nFirst,+10000000001\nRetry,+10000000002' },
    retry: { clients_csv: 'name,phone\nRetry,+10000000002' },
  },
  {
    phase: 'test_bookings',
    method: 'createTestBookings',
    create: 'createBooking',
    remove: 'deleteBooking',
    args: { count: 2 },
    retry: { count: 1 },
  },
] as const;

describe('onboarding batch history and rollback', () => {
  let dir: string;
  let state: OnboardingStateManager;
  let otherState: OnboardingStateManager;
  let handlers: OnboardingHandlers;
  let other: OnboardingHandlers;
  let client: jest.Mocked<AltegioClient>;
  const onDisk = () =>
    JSON.parse(
      fs.readFileSync(path.join(dir, String(LOCATION), 'state.json'), 'utf8')
    );

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onboarding-history-'));
    state = new OnboardingStateManager(dir);
    otherState = new OnboardingStateManager(dir);
    let id = 2000;
    client = {
      isAuthenticated: jest.fn(() => true),
      getLocation: jest.fn(async () => ({ id: LOCATION })),
      getSchedule: jest.fn(async () => []),
      setSchedule: jest.fn(async () => []),
      createClient: jest.fn(async () => ({ id: ++id })),
      deleteClient: jest.fn(async () => undefined),
    } as unknown as jest.Mocked<AltegioClient>;
    handlers = new OnboardingHandlers(client, state);
    other = new OnboardingHandlers(client, otherState);
    await state.start(LOCATION);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(
    batchCases.flatMap((example) => [
      { ...example, partial: false },
      { ...example, partial: true },
    ])
  )(
    'preserves both $phase batches (partial failure: $partial) and retries only failed rollback targets',
    async (example) => {
      if (example.phase === 'test_bookings') {
        await state.checkpoint(LOCATION, 'staff', [1]);
        await state.checkpoint(LOCATION, 'services', [10]);
      }
      const create = jest.fn().mockResolvedValueOnce({ id: 101 });
      if (example.partial)
        create.mockRejectedValueOnce(new Error('row refused'));
      create.mockResolvedValueOnce({ id: 102 });
      client[example.create] = create as never;
      const first = await handlers[example.method]({
        location_id: LOCATION,
        ...(example.partial ? example.args : example.retry),
      });
      expect(first.isError).toBeFalsy();
      expect(first.structuredContent).toMatchObject({
        created: 1,
        failed: example.partial ? 1 : 0,
        created_ids: [101],
      });
      const second = await other[example.method]({
        location_id: LOCATION,
        ...example.retry,
      });
      expect(second.structuredContent).toMatchObject({
        created: 1,
        failed: 0,
        created_ids: [102],
      });
      const checkpoint = (await state.load(LOCATION))?.checkpoints[
        example.phase
      ];
      expect(checkpoint?.entity_ids).toEqual([101, 102]);
      expect(checkpoint?.batches).toEqual([
        expect.objectContaining({
          entity_ids: [101],
          completed: true,
          metadata: { failed_rows: example.partial ? 1 : 0 },
        }),
        expect.objectContaining({
          entity_ids: [102],
          completed: true,
          metadata: { failed_rows: 0 },
        }),
      ]);
      client[example.remove] = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('still in use'))
        .mockResolvedValueOnce(undefined) as never;
      await other.rollbackPhase({
        location_id: LOCATION,
        phase_name:
          example.phase === 'test_bookings'
            ? 'test_appointments'
            : example.phase,
      });
      expect(onDisk().checkpoints[example.phase].entity_ids).toEqual([102]);
      expect(
        onDisk().checkpoints[example.phase].batches.map(
          (b: { entity_ids: number[] }) => b.entity_ids
        )
      ).toEqual([[], [102]]);
      await handlers.rollbackPhase({
        location_id: LOCATION,
        phase_name: example.phase,
      });
      expect(
        (await state.load(LOCATION))?.checkpoints[example.phase]
      ).toBeUndefined();
      expect(client[example.remove].mock.calls.map((call) => call[1])).toEqual([
        101, 102, 102,
      ]);
      if (example.phase === 'test_bookings') {
        // Includes the client belonging to the refused appointment, not just the
        // clients belonging to the two successful appointments.
        const clientIds = (await state.load(LOCATION))!.checkpoints.clients!
          .entity_ids;
        expect(clientIds).toHaveLength(example.partial ? 3 : 2);
        await other.rollbackPhase({
          location_id: LOCATION,
          phase_name: 'clients',
        });
        expect(client.deleteClient.mock.calls.map((call) => call[1])).toEqual(
          clientIds
        );
      }
    }
  );

  it('serializes upstream work, checkpoints and rollback across separate handler instances', async () => {
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    client.createPosition = jest.fn(async () => {
      started();
      await waiting;
      return { id: 1 };
    }) as never;
    client.createStaff = jest.fn(async () => ({ id: 2 })) as never;
    client.deletePosition = jest.fn().mockResolvedValue(undefined);
    const importing = handlers.addPositions({
      location_id: LOCATION,
      positions: [{ title: 'First' }],
    });
    await entered;
    const staff = other.addStaffBatch({
      location_id: LOCATION,
      team_members: [{ name: 'Second' }],
      has_paid_seat: false,
      has_schedule_access: true,
    });
    const rollback = other.rollbackPhase({
      location_id: LOCATION,
      phase_name: 'positions',
    });
    await new Promise(setImmediate);
    expect(client.createStaff).not.toHaveBeenCalled();
    expect(client.deletePosition).not.toHaveBeenCalled();
    expect(onDisk().checkpoints.positions.completed).toBe(false);
    expect(onDisk().phase).toBe('positions');
    release();
    for (const result of await Promise.all([importing, staff, rollback]))
      expect(result.isError).toBeFalsy();
    expect(onDisk().checkpoints.positions).toBeUndefined();
    expect(onDisk().checkpoints.staff.entity_ids).toEqual([2]);
  });

  it('records every successful row before the next creation and aborts if that persistence fails', async () => {
    client.createPosition = jest.fn(async () => ({
      id: 20 + client.createPosition.mock.calls.length,
    })) as never;
    const rename = fsPromises.rename.bind(fsPromises);
    let writes = 0;
    jest.spyOn(fsPromises, 'rename').mockImplementation(async (...args) => {
      // begin batch, first row, then fail the second row's checkpoint.
      if (++writes === 3) throw new Error('disk full');
      return rename(...args);
    });
    const result = await handlers.addPositions({
      location_id: LOCATION,
      positions: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('ID 22');
    expect(client.createPosition).toHaveBeenCalledTimes(2);
    expect(onDisk().checkpoints.positions.entity_ids).toEqual([21]);
    expect(onDisk().checkpoints.positions.completed).toBe(false);
    client.deletePosition = jest.fn().mockResolvedValue(undefined);
    const rollback = await other.rollbackPhase({
      location_id: LOCATION,
      phase_name: 'positions',
    });
    expect(client.deletePosition).toHaveBeenCalledWith(LOCATION, 21);
    expect(onDisk().checkpoints.positions.entity_ids).toEqual([]);
    expect(onDisk().checkpoints.positions.completed).toBe(false);
    expect(rollback.content[0]?.text).toContain('unconfirmed upstream writes');
  });

  it('never starts upstream creation when there is no valid writable session', async () => {
    client.createPosition = jest.fn();
    client.createStaff = jest.fn();
    client.createServiceCategory = jest.fn();
    client.createService = jest.fn();
    client.createBooking = jest.fn();
    for (const example of batchCases) {
      const result = await handlers[example.method]({
        location_id: 999,
        ...example.args,
      });
      expect(result.isError).toBe(true);
      expect(client[example.create]).not.toHaveBeenCalled();
    }
    const result = await handlers.setSchedules({
      location_id: 999,
      schedules: [
        {
          team_member_id: 1,
          dates: ['2026-01-01'],
          slots: [{ from: '09:00', to: '17:00' }],
        },
      ],
    });
    expect(result.isError).toBe(true);
    expect(client.setSchedule).not.toHaveBeenCalled();
    jest
      .spyOn(fsPromises, 'rename')
      .mockRejectedValueOnce(new Error('cannot persist'));
    expect(
      (
        await handlers.addPositions({
          location_id: LOCATION,
          positions: [{ title: 'One' }],
        })
      ).isError
    ).toBe(true);
    expect(client.createPosition).not.toHaveBeenCalled();
  });

  it('persists confirmed rollback progress and retries a crash-interrupted delete safely', async () => {
    await state.checkpoint(LOCATION, 'positions', [1, 2]);
    client.deletePosition = jest.fn().mockResolvedValue(undefined);
    jest
      .spyOn(fsPromises, 'rename')
      .mockRejectedValueOnce(new Error('disk failed'));
    expect(
      (
        await handlers.rollbackPhase({
          location_id: LOCATION,
          phase_name: 'positions',
        })
      ).isError
    ).toBe(true);
    expect(client.deletePosition).toHaveBeenCalledTimes(1);
    expect(onDisk().checkpoints.positions.entity_ids).toEqual([1, 2]);
    client.deletePosition.mockRejectedValueOnce(
      new AltegioApiError('already absent', 404)
    );
    expect(
      (
        await other.rollbackPhase({
          location_id: LOCATION,
          phase_name: 'positions',
        })
      ).isError
    ).toBeFalsy();
    expect(onDisk().checkpoints.positions).toBeUndefined();
    expect(client.deletePosition.mock.calls.map((call) => call[1])).toEqual([
      1, 1, 2,
    ]);
  });

  it('does not substitute an existing client after a test-client creation conflict', async () => {
    await state.checkpoint(LOCATION, 'staff', [1]);
    await state.checkpoint(LOCATION, 'services', [10]);
    client.createClient.mockRejectedValueOnce(
      new AltegioApiError('duplicate phone', 409)
    );
    client.createBooking = jest.fn();
    const result = await handlers.createTestBookings({
      location_id: LOCATION,
      count: 1,
    });
    expect(result.structuredContent).toMatchObject({ created: 0, failed: 1 });
    expect(client.createBooking).not.toHaveBeenCalled();
    expect(onDisk().checkpoints.clients.entity_ids).toEqual([]);
  });

  it('preserves all schedule batches and retries exactly the failed staff/date pairs', async () => {
    await state.checkpoint(LOCATION, 'staff', [1, 2]);
    const slots = [{ from: '09:00', to: '17:00' }];
    const batches = [
      [{ team_member_id: 1, dates: ['2026-01-01', '2026-01-02'], slots }],
      [
        { team_member_id: 1, dates: ['2026-01-02', '2026-01-03'], slots },
        { team_member_id: 2, dates: ['2026-01-01'], slots },
      ],
    ];
    for (const schedules of batches) {
      expect(
        (await handlers.setSchedules({ location_id: LOCATION, schedules }))
          .isError
      ).toBeFalsy();
    }
    expect(onDisk().checkpoints.schedules.entity_ids).toEqual([1, 2]);
    expect(
      onDisk().checkpoints.schedules.batches.map(
        (b: { metadata: { requested_schedules: unknown } }) =>
          b.metadata.requested_schedules
      )
    ).toEqual(batches);
    expect(onDisk().checkpoints.schedules.metadata.schedules).toEqual(
      batches
        .flat()
        .flatMap((schedule) =>
          schedule.dates.map((date) => ({ ...schedule, dates: [date] }))
        )
    );
    client.setSchedule.mockClear();
    client.setSchedule.mockImplementation(async (_location, request) => {
      if (
        request.schedules_to_delete?.[0]?.team_member_id === 1 &&
        request.schedules_to_delete[0].dates[0] === '2026-01-02'
      )
        throw new Error('busy');
      return [];
    });
    await other.rollbackPhase({
      location_id: LOCATION,
      phase_name: 'schedules',
    });
    expect(client.setSchedule).toHaveBeenCalledTimes(4);
    const remaining = onDisk().checkpoints.schedules;
    expect(remaining.entity_ids).toEqual([1]);
    expect(
      remaining.metadata.schedules.flatMap((s: { dates: string[] }) => s.dates)
    ).toEqual(['2026-01-02', '2026-01-02']);
    expect((await state.load(LOCATION))?.phase).toBe('schedules');
    client.setSchedule.mockClear().mockResolvedValue([]);
    await handlers.rollbackPhase({
      location_id: LOCATION,
      phase_name: 'schedules',
    });
    expect(client.setSchedule).toHaveBeenCalledTimes(1);
    expect(client.setSchedule).toHaveBeenCalledWith(LOCATION, {
      schedules_to_delete: [{ team_member_id: 1, dates: ['2026-01-02'] }],
    });
    expect(onDisk().checkpoints.schedules).toBeUndefined();
  });

  it('refuses schedules on existing staff or existing unowned workdays', async () => {
    const schedules = [
      {
        team_member_id: 1,
        dates: ['2026-01-01'],
        slots: [{ from: '09:00', to: '17:00' }],
      },
    ];
    expect(
      (await handlers.setSchedules({ location_id: LOCATION, schedules }))
        .isError
    ).toBe(true);
    expect(client.setSchedule).not.toHaveBeenCalled();
    await state.checkpoint(LOCATION, 'staff', [1]);
    client.getSchedule.mockResolvedValue([
      { date: '2026-01-01', slots: [{ from: '08:00', to: '16:00' }] },
    ]);
    expect(
      (await handlers.setSchedules({ location_id: LOCATION, schedules }))
        .isError
    ).toBe(true);
    expect(client.setSchedule).not.toHaveBeenCalled();
    expect(onDisk().checkpoints.schedules).toBeUndefined();
  });

  it('keeps confirmed schedule workdays through partial failure and a later retry', async () => {
    await state.checkpoint(LOCATION, 'staff', [1]);
    const slots = [{ from: '09:00', to: '17:00' }];
    client.setSchedule
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('day refused'))
      .mockResolvedValueOnce([]);
    const result = await handlers.setSchedules({
      location_id: LOCATION,
      schedules: [
        { team_member_id: 1, dates: ['2026-01-01', '2026-01-02'], slots },
      ],
    });
    expect(result.structuredContent).toMatchObject({
      created_ids: [1],
      failed: 1,
    });
    expect(onDisk().checkpoints.schedules.metadata.schedules).toEqual([
      { team_member_id: 1, dates: ['2026-01-01'], slots },
    ]);
    const retried = await other.setSchedules({
      location_id: LOCATION,
      schedules: [{ team_member_id: 1, dates: ['2026-01-02'], slots }],
    });
    expect(retried.structuredContent).toMatchObject({
      created_ids: [1],
      failed: 0,
    });
    client.setSchedule.mockClear().mockResolvedValue([]);
    await handlers.rollbackPhase({
      location_id: LOCATION,
      phase_name: 'schedules',
    });
    expect(
      client.setSchedule.mock.calls.map((call) => call[1].schedules_to_delete)
    ).toEqual([
      [{ team_member_id: 1, dates: ['2026-01-01'] }],
      [{ team_member_id: 1, dates: ['2026-01-02'] }],
    ]);
    expect(onDisk().checkpoints.schedules).toBeUndefined();
  });
});
