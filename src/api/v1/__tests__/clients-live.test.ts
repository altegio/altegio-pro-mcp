/**
 * Opt-in live suite: calls the real client endpoints against the configured or
 * first accessible location
 * and records sanitized reference payloads under `fixtures/live/`.
 *
 * Skipped unless `ALTEGIO_E2E=1`. It needs `ALTEGIO_API_TOKEN` (or a live-test
 * alias) and either `ALTEGIO_USER_TOKEN` or the demo login/password — from the
 * environment, never from a file in this public repository.
 *
 *   ALTEGIO_E2E=1 CREDENTIALS_DIR=/tmp/altegio-mcp-live npx jest clients-live
 *
 * Read-only: every call is a search or a read. Recorded payloads pass through the
 * shared `sanitize` first, so no names, phone numbers or e-mail addresses reach
 * the fixtures.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AltegioClient } from '../../../providers/altegio-client.js';
import { httpFromClient } from '../../altegio-http.js';
import { callClients } from '../clients-http.js';
import { V1ClientsAdapter } from '../clients-adapter.js';

const LIVE = process.env.ALTEGIO_E2E === '1';
let liveLocationId = 4564;
const FIXTURES = path.join(__dirname, 'fixtures', 'live');
const CREDENTIALS_DIR = process.env.CREDENTIALS_DIR ?? '/tmp/altegio-mcp-live';

/** Keys whose string values are personal and must be blanked before recording. */
const PERSONAL_KEYS = [
  'name',
  'fullname',
  'surname',
  'patronymic',
  'phone',
  'email',
  'comment',
  'additional_phone',
  'title',
];

/**
 * Replace personal string values in place, keeping the shape intact, so no
 * name, phone number or e-mail address reaches a fixture. `title` is blanked too
 * because a client tag's title can be a person's name in the wild.
 */
function sanitize(value: unknown, seen = new Map<string, string>()): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      PERSONAL_KEYS.includes(key) &&
      typeof item === 'string' &&
      item !== ''
    ) {
      const known = seen.get(item);
      if (known !== undefined) {
        out[key] = known;
      } else {
        const placeholder = /phone|email/.test(key)
          ? ''
          : `Person ${seen.size + 1}`;
        seen.set(item, placeholder);
        out[key] = placeholder;
      }
    } else {
      out[key] = sanitize(item, seen);
    }
  }
  return out;
}

function record(name: string, payload: unknown): void {
  fs.mkdirSync(FIXTURES, { recursive: true });
  fs.writeFileSync(
    path.join(FIXTURES, `${name}.json`),
    `${JSON.stringify(sanitize(payload), null, 2)}\n`
  );
}

const describeLive = LIVE ? describe : describe.skip;

describeLive('client endpoints against an accessible location', () => {
  let client: AltegioClient;

  beforeAll(async () => {
    const login = process.env.ALTEGIO_TEST_LOGIN;
    const password = process.env.ALTEGIO_TEST_PASSWORD;
    const userToken = process.env.ALTEGIO_USER_TOKEN;
    const partnerToken =
      process.env.ALTEGIO_API_TOKEN ??
      process.env.ALTEGIO_PARTNER_TOKEN ??
      process.env.ALTEGIO_LIVE_API_TOKEN;
    if (!partnerToken || (!userToken && (!login || !password))) {
      throw new Error(
        'The live suite needs ALTEGIO_API_TOKEN (or a live-test alias) and either ALTEGIO_USER_TOKEN or ALTEGIO_TEST_LOGIN plus ALTEGIO_TEST_PASSWORD.'
      );
    }
    client = new AltegioClient({ partnerToken, userToken }, CREDENTIALS_DIR);
    if (!client.isAuthenticated()) {
      const result = await client.login(login!, password!);
      expect(result.success).toBe(true);
    }
    const configured = process.env.ALTEGIO_COMPANY_ID;
    if (configured && /^\d+$/.test(configured) && Number(configured) > 0) {
      liveLocationId = Number(configured);
    } else {
      const locations = await client.getCompanies({ my: 1 });
      if (!locations[0]?.id) {
        throw new Error(
          'The live token has no accessible location and ALTEGIO_COMPANY_ID is not a positive integer.'
        );
      }
      liveLocationId = locations[0].id;
    }
  }, 60_000);

  afterAll(() => undefined);

  it('records a segmentation search and reads it through the adapter', async () => {
    // A raw recording of the endpoint's own shape…
    const raw = await callClients(
      httpFromClient(client),
      `/company/${liveLocationId}/clients/search`,
      {
        method: 'POST',
        body: { page: 1, page_size: 5, operation: 'AND', filters: [] },
        context: 'record the client search',
      }
    );
    record('clients-search', raw);

    // …and the canonical DTO the adapter derives from it.
    const api = new V1ClientsAdapter(httpFromClient(client));
    const segment = await api.searchClients({
      location_id: liveLocationId,
      filters: {},
      match: 'all',
      page: 1,
      page_size: 5,
      order_by: 'total_spent',
      order_direction: 'desc',
    });
    expect(typeof segment.total_count).toBe('number');

    if (segment.rows.length > 0) {
      const clientId = segment.rows[0]!.id;

      const card = await callClients(
        httpFromClient(client),
        `/client/${liveLocationId}/${clientId}`,
        { context: 'record the client card' }
      );
      record('client-card', card);

      const visits = await callClients(
        httpFromClient(client),
        `/company/${liveLocationId}/clients/visits/search`,
        {
          method: 'POST',
          body: {
            client_id: clientId,
            client_phone: null,
            from: null,
            to: null,
            payment_statuses: [],
            attendance: null,
          },
          context: 'record the visit history',
        }
      );
      record('client-visits', visits);

      const cardDto = await api.getClientCard({
        location_id: liveLocationId,
        client_id: clientId,
      });
      expect(cardDto.id).toBe(clientId);
    }
  }, 120_000);

  it('records the autocomplete lookup', async () => {
    const raw = await callClients(
      httpFromClient(client),
      `/company/${liveLocationId}/clients/autocomplete?name=a&limit=5`,
      { context: 'record the autocomplete lookup' }
    );
    record('clients-autocomplete', raw);
    const rows = Array.isArray(raw)
      ? raw
      : (raw as { data?: unknown } | null)?.data;
    expect(Array.isArray(rows)).toBe(true);
  }, 60_000);

  it('reads a universal reactivation audience without a loyalty program', async () => {
    const cutoff = new Date();
    cutoff.setUTCDate(cutoff.getUTCDate() - 90);
    const threshold = cutoff.toISOString().slice(0, 10);
    const inactiveFrom = new Date(cutoff.getTime() + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const api = new V1ClientsAdapter(httpFromClient(client));
    const segment = await api.searchReactivationCandidates({
      location_id: liveLocationId,
      last_visit_on_or_before: threshold,
      inactive_from: inactiveFrom,
      minimum_historical_visits: 1,
      filters: {},
      page: 1,
      page_size: 5,
      include_contacts: false,
    });

    expect(typeof segment.total_count).toBe('number');
    expect(segment.candidates.length).toBeLessThanOrEqual(5);
    expect(segment.candidates.every((row) => row.client_id > 0)).toBe(true);
    expect(
      segment.candidates.every(
        (row) =>
          row.last_visit_date !== null &&
          row.last_visit_date <= threshold &&
          row.visit_count !== null &&
          row.visit_count >= 1
      )
    ).toBe(true);
    expect(
      segment.candidates.every((row) => !('phone' in row) && !('email' in row))
    ).toBe(true);
  }, 60_000);
});
