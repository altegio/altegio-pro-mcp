/**
 * Opt-in live end-to-end suite for the write path that live testing found broken:
 * set a staff schedule, link a team member to a service, then create and delete
 * appointments — the chain behind PRIORITY 1–3 of the schedules/appointments fix.
 *
 * Skipped unless `ALTEGIO_E2E=1`. Needs a partner token in
 * `ALTEGIO_PARTNER_TOKEN` (or `ALTEGIO_LIVE_API_TOKEN`) and demo credentials in
 * `ALTEGIO_TEST_LOGIN` / `ALTEGIO_TEST_PASSWORD` — from the environment, never a
 * file in this public repo. Runs against the Demo Location (4564), where content
 * writes are permitted, and cleans up everything it creates.
 *
 *   ALTEGIO_E2E=1 CREDENTIALS_DIR=/tmp/altegio-mcp-live \
 *     ALTEGIO_PARTNER_TOKEN=… ALTEGIO_TEST_LOGIN=… ALTEGIO_TEST_PASSWORD=… \
 *     npx jest appointments-e2e-live
 */
import { AltegioClient } from '../providers/altegio-client.js';

const LIVE = process.env.ALTEGIO_E2E === '1';
const DEMO_LOCATION_ID = 4564;
const CREDENTIALS_DIR = process.env.CREDENTIALS_DIR ?? '/tmp/altegio-mcp-live';

const describeLive = LIVE ? describe : describe.skip;

/** YYYY-MM-DD for `daysFromNow` (negative = past). */
function isoDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0]!;
}

describeLive('appointments end-to-end against the demo location', () => {
  let client: AltegioClient;

  beforeAll(async () => {
    const login = process.env.ALTEGIO_TEST_LOGIN;
    const password = process.env.ALTEGIO_TEST_PASSWORD;
    const partnerToken =
      process.env.ALTEGIO_PARTNER_TOKEN ?? process.env.ALTEGIO_LIVE_API_TOKEN;
    if (!login || !password || !partnerToken) {
      throw new Error(
        'The live suite needs ALTEGIO_PARTNER_TOKEN (or ALTEGIO_LIVE_API_TOKEN), ALTEGIO_TEST_LOGIN and ALTEGIO_TEST_PASSWORD in the environment.'
      );
    }
    client = new AltegioClient({ partnerToken }, CREDENTIALS_DIR);
    if (!client.isAuthenticated()) {
      const result = await client.login(login, password);
      expect(result.success).toBe(true);
    }
  }, 60_000);

  it('sets a schedule, links a service, creates past + future appointments, then deletes them', async () => {
    const stamp = Date.now();
    const futureDate = isoDate(3);
    const pastDate = isoDate(-3);

    // Cleanup handles registered as we go, run in reverse regardless of outcome.
    const cleanup: Array<() => Promise<unknown>> = [];
    const runCleanup = async () => {
      for (const fn of cleanup.reverse()) {
        try {
          await fn();
        } catch (err) {
          // Best-effort teardown — log and keep going.
          console.warn('cleanup step failed:', err);
        }
      }
    };

    try {
      // --- Test staff (unpaid so it does not consume a license seat) ----------
      const staff = await client.createStaff(DEMO_LOCATION_ID, {
        name: `E2E Staff ${stamp}`,
        specialization: 'E2E Testing',
        position_id: null,
        phone_number: null,
        user_email: `e2e-staff-${stamp}@example.com`,
        user_phone: `1${String(stamp).slice(-10)}`,
        is_user_invite: false,
        is_paid_staff: false,
      });
      expect(staff.id).toBeGreaterThan(0);
      cleanup.push(() => client.deleteStaff(DEMO_LOCATION_ID, staff.id));

      // --- Test service in the first root category ----------------------------
      const categories = await client.getServiceCategories(DEMO_LOCATION_ID, 0);
      expect(categories.length).toBeGreaterThan(0);
      const service = await client.createService(DEMO_LOCATION_ID, {
        title: `E2E Service ${stamp}`,
        category_id: categories[0]!.id,
        price_min: 1000,
        price_max: 1000,
        duration: 3600,
      });
      expect(service.id).toBeGreaterThan(0);
      cleanup.push(() => client.deleteService(DEMO_LOCATION_ID, service.id));

      // --- PRIORITY 2: link the team member to the service --------------------
      await client.assignServiceToStaff(DEMO_LOCATION_ID, service.id, {
        master_id: staff.id,
        seance_length: 3600,
      });
      cleanup.push(() =>
        client.removeServiceFromStaff(DEMO_LOCATION_ID, service.id, staff.id)
      );

      // --- PRIORITY 1: set a schedule and read it back with slots -------------
      await client.setSchedule(DEMO_LOCATION_ID, {
        schedules_to_set: [
          {
            team_member_id: staff.id,
            dates: [futureDate],
            slots: [{ from: '10:00', to: '18:00' }],
          },
        ],
      });
      cleanup.push(() =>
        client.setSchedule(DEMO_LOCATION_ID, {
          schedules_to_delete: [
            { team_member_id: staff.id, dates: [futureDate] },
          ],
        })
      );

      const schedule = await client.getSchedule(
        DEMO_LOCATION_ID,
        staff.id,
        futureDate,
        futureDate
      );
      const workingDay = schedule.find((d) => (d.slots?.length ?? 0) > 0);
      expect(workingDay).toBeDefined();
      expect(workingDay?.slots?.[0]).toMatchObject({ from: '10:00' });

      // --- PRIORITY 3: future appointment on the scheduled slot ---------------
      const future = await client.createBooking(DEMO_LOCATION_ID, {
        staff_id: staff.id,
        services: [{ id: service.id }],
        datetime: `${futureDate} 12:00:00`,
        seance_length: 3600,
        client: {
          name: `E2E Client ${stamp}`,
          phone: `1${String(stamp).slice(-10)}`,
        },
      });
      expect(future.id).toBeGreaterThan(0);
      cleanup.push(() => client.deleteBooking(DEMO_LOCATION_ID, future.id));

      // --- PRIORITY 3: back-dated (attended) appointment ----------------------
      const past = await client.createBooking(DEMO_LOCATION_ID, {
        staff_id: staff.id,
        services: [{ id: service.id }],
        datetime: `${pastDate} 12:00:00`,
        seance_length: 3600,
        attendance: 1,
        // The staff has no schedule in the past; keep it anyway.
        save_if_busy: true,
        client: {
          name: `E2E Client ${stamp}`,
          phone: `1${String(stamp).slice(-10)}`,
        },
      });
      expect(past.id).toBeGreaterThan(0);
      cleanup.push(() => client.deleteBooking(DEMO_LOCATION_ID, past.id));
    } finally {
      await runCleanup();
    }
  }, 180_000);
});
