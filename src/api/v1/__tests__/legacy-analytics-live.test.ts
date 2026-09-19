/**
 * Opt-in, read-only verification of the five temporary authenticated ERP
 * reports. Skipped unless ALTEGIO_E2E=1; credentials stay in the environment
 * and no response containing client data is written to disk or printed.
 *
 *   ALTEGIO_E2E=1 CREDENTIALS_DIR=/tmp/altegio-mcp-live \
 *     ALTEGIO_PARTNER_TOKEN=… ALTEGIO_USER_TOKEN=… \
 *     npx jest legacy-analytics-live
 */
import { AltegioClient } from '../../../providers/altegio-client.js';
import { V1LegacyAnalyticsAdapter } from '../legacy-analytics-adapter.js';

const LIVE = process.env.ALTEGIO_E2E === '1';
const DEMO_LOCATION_ID = 4564;
const CREDENTIALS_DIR = process.env.CREDENTIALS_DIR ?? '/tmp/altegio-mcp-live';
const describeLive = LIVE ? describe : describe.skip;

function recentPeriod(): { date_from: string; date_to: string } {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 6);
  return {
    date_from: start.toISOString().slice(0, 10),
    date_to: end.toISOString().slice(0, 10),
  };
}

describeLive(
  'temporary legacy analytics reports against the demo location',
  () => {
    let adapter: V1LegacyAnalyticsAdapter;

    beforeAll(async () => {
      const login = process.env.ALTEGIO_TEST_LOGIN;
      const password = process.env.ALTEGIO_TEST_PASSWORD;
      const userToken = process.env.ALTEGIO_USER_TOKEN;
      const partnerToken =
        process.env.ALTEGIO_PARTNER_TOKEN ?? process.env.ALTEGIO_LIVE_API_TOKEN;
      if (!partnerToken || (!userToken && (!login || !password))) {
        throw new Error(
          'The live suite needs ALTEGIO_PARTNER_TOKEN (or ALTEGIO_LIVE_API_TOKEN) and either ALTEGIO_USER_TOKEN or ALTEGIO_TEST_LOGIN plus ALTEGIO_TEST_PASSWORD.'
        );
      }
      const client = new AltegioClient(
        { partnerToken, userToken },
        CREDENTIALS_DIR
      );
      if (!client.isAuthenticated()) {
        const result = await client.login(login!, password!);
        expect(result.success).toBe(true);
      }
      adapter = new V1LegacyAnalyticsAdapter(client);
    }, 60_000);

    it('parses every report into its canonical bounded contract', async () => {
      const period = recentPeriod();
      const [clients, retention, forecast, services, team] = await Promise.all([
        adapter.getClientSales({
          location_id: DEMO_LOCATION_ID,
          ...period,
          page: 1,
          page_size: 50,
          include_contacts: false,
        }),
        adapter.getClientRetention({
          location_id: DEMO_LOCATION_ID,
          ...period,
        }),
        adapter.getClientForecast({
          location_id: DEMO_LOCATION_ID,
          page: 1,
          page_size: 50,
          include_contacts: false,
        }),
        adapter.getServiceProfitability({
          location_id: DEMO_LOCATION_ID,
          ...period,
          page: 1,
          page_size: 100,
          group_by: 'service',
        }),
        adapter.getTeamMemberSales({
          location_id: DEMO_LOCATION_ID,
          ...period,
        }),
      ]);

      expect(clients.rows.length).toBeLessThanOrEqual(50);
      expect(clients.rows.every((row) => !('phone' in row))).toBe(true);
      expect(retention.rows.every((row) => row.team_member_id > 0)).toBe(true);
      expect(forecast.rows.length).toBeLessThanOrEqual(50);
      expect(forecast.rows.every((row) => row.client_id === null)).toBe(true);
      expect(forecast.rows.every((row) => !('phone' in row))).toBe(true);
      expect(services.rows.length).toBeLessThanOrEqual(100);
      expect(team.rows.every((row) => row.team_member_id > 0)).toBe(true);
    }, 120_000);
  }
);
