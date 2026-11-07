import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type MCPServer } from '../../server.js';
import { AltegioClient } from '../../providers/altegio-client.js';
import { createLogger } from '../../utils/logger.js';
import { ConfigLoader } from '../../config/schema.js';
import { clearTimezoneCache } from '../../capabilities/analytics/location-timezone.js';
import { clearCurrencyCache } from '../../api/v1/location-currency.js';

let credentialsDir: string;
let server: MCPServer;
let client: Client;
let priorDir: string | undefined;
let priorToken: string | undefined;

beforeEach(async () => {
  clearTimezoneCache();
  clearCurrencyCache();
  jest
    .spyOn(global, 'fetch')
    .mockRejectedValue(new Error('Unexpected network request in test'));
  priorDir = process.env.CREDENTIALS_DIR;
  priorToken = process.env.ALTEGIO_USER_TOKEN;
  credentialsDir = mkdtempSync(join(tmpdir(), 'altegio-log-diagnostics-'));
  process.env.CREDENTIALS_DIR = credentialsDir;
  process.env.ALTEGIO_USER_TOKEN = 'synthetic-private-token';
  ConfigLoader.getInstance().reset();
  server = createServer({ facet: 'readonly' });
  client = new Client({ name: 'diagnostics-test', version: '1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  jest.restoreAllMocks();
  if (priorDir === undefined) delete process.env.CREDENTIALS_DIR;
  else process.env.CREDENTIALS_DIR = priorDir;
  if (priorToken === undefined) delete process.env.ALTEGIO_USER_TOKEN;
  else process.env.ALTEGIO_USER_TOKEN = priorToken;
  ConfigLoader.getInstance().reset();
  rmSync(credentialsDir, { recursive: true, force: true });
});

it.each([
  ['TimeoutError', 'timeout'],
  ['AbortError', 'cancelled'],
])(
  'logs native %s with a bounded phase and class',
  async (name, errorClass) => {
    const calls = jest
      .spyOn(createLogger('tool-calls'), 'info')
      .mockImplementation(() => {});
    const upstream = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new DOMException('PRIVATE upstream URL', name));
    const result = await client.callTool({
      name: 'team_members_list',
      arguments: { location_id: 123 },
    });
    expect(result.isError).toBe(true);
    expect(upstream).toHaveBeenCalledTimes(1);
    const line = calls.mock.calls.at(-1)?.[0];
    expect(line).toMatchObject({
      outcome: 'error',
      error_class: errorClass,
      upstream_failure: errorClass,
      upstream_phase: 'headers',
      upstream_method: 'GET',
      upstream_route: 'other',
      upstream_requests: 1,
      upstream_responses: 0,
    });
    expect(JSON.stringify(line)).not.toMatch(
      /PRIVATE|synthetic-private-token|123/
    );
  }
);

it('logs the cash-flow parser branch after a successful report response', async () => {
  jest.spyOn(AltegioClient.prototype, 'getCompanies').mockResolvedValue([]);
  jest.spyOn(AltegioClient.prototype, 'apiRequest').mockResolvedValue(
    new Response(
      JSON.stringify({
        success: true,
        data: { income_total_stats: { currency: { iso: 'USD' } } },
      })
    )
  );
  const calls = jest
    .spyOn(createLogger('tool-calls'), 'info')
    .mockImplementation(() => {});
  jest.spyOn(AltegioClient.prototype, 'getLocation').mockResolvedValue({
    id: 123,
    currency_short_title: 'USD',
    timezone: 'UTC',
  } as never);
  jest
    .spyOn(AltegioClient.prototype, 'requestLegacyWebReport')
    .mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          count: 1,
          content: '<p>PRIVATE customer financial report</p>',
        })
      )
    );
  const result = await client.callTool({
    name: 'analytics_get_cash_flow_breakdown',
    arguments: {
      location_id: 123,
      date_from: '2026-08-01',
      date_to: '2026-08-02',
    },
  });
  expect(result.isError).toBe(true);
  expect(global.fetch).not.toHaveBeenCalled();
  const line = calls.mock.calls.at(-1)?.[0];
  expect(line).toMatchObject({
    outcome: 'error',
    error_class: 'internal',
    cash_flow_parse_reason: 'headers_missing',
  });
  expect(JSON.stringify(line)).not.toMatch(
    /PRIVATE|synthetic-private-token|123/
  );
});
