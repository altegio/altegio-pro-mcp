/**
 * The byte budget of every HTTP view's `tools/list` (ADR-001 D3).
 *
 * The sizes come from `../listing.ts`, the module the registry answers
 * `tools/list` with; the last block proves that over a real connection, so the
 * budget measures what a host receives and not an approximation of it.
 */
import { describe, it, expect } from '@jest/globals';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  LATEST_PROTOCOL_VERSION,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../server.js';
import { loadConfig } from '../../config/schema.js';
import { ALL_TOOLS_FACET, DEFAULT_FACET, VIEW_KEYS } from '../facets.js';
import { orderedToolEntries } from '../inventory.js';
import { listView, listingBytes } from '../listing.js';
import {
  budgetViolations,
  DEFAULT_VIEW_TARGET_BYTES,
  LISTING_BUDGETS,
  viewSizes,
  type HttpViewKey,
} from '../listing-budget.js';

const HTTP_VIEWS = VIEW_KEYS.filter(
  (view): view is HttpViewKey => view !== ALL_TOOLS_FACET
);

/** The raw `tools/list` result a server instance sends for one view. */
async function servedListResult(view: HttpViewKey): Promise<unknown> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = createServer({ facet: view });
  await server.connect(serverTransport);
  const replies = new Map<number, (message: JSONRPCMessage) => void>();
  clientTransport.onmessage = (message) => {
    if ('id' in message && typeof message.id === 'number') {
      replies.get(message.id)?.(message);
    }
  };
  await clientTransport.start();
  const request = (
    id: number,
    method: string,
    params?: Record<string, unknown>
  ) =>
    new Promise<JSONRPCMessage>((resolve) => {
      replies.set(id, resolve);
      void clientTransport.send({ jsonrpc: '2.0', id, method, params });
    });

  await request(1, 'initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'listing-budget-test', version: '1.0.0' },
  });
  await clientTransport.send({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  });
  const reply = await request(2, 'tools/list');
  await server.close();
  return (reply as { result: unknown }).result;
}

describe('tools/list byte budget', () => {
  const sizes = viewSizes();

  it('gives every HTTP view a budget, and stdio none', () => {
    expect(Object.keys(LISTING_BUDGETS).sort()).toEqual([...HTTP_VIEWS].sort());
    expect(sizes.find((size) => size.view === ALL_TOOLS_FACET)?.budget).toBe(
      undefined
    );
  });

  it.each(HTTP_VIEWS)('keeps %s within its budget', (view) => {
    const size = sizes.find((entry) => entry.view === view)!;
    expect(budgetViolations([size])).toEqual([]);
  });

  it('keeps the default view’s target below its budget', () => {
    expect(DEFAULT_VIEW_TARGET_BYTES).toBeLessThan(
      LISTING_BUDGETS[DEFAULT_FACET]
    );
  });

  it('names the view, the overrun and the way out when a view is over', () => {
    const [line] = budgetViolations([
      { view: 'ops', tools: 1, bytes: 120, budget: 100 },
    ]);
    expect(line).toContain('ops: tools/list is 120 bytes');
    expect(line).toContain('20 bytes over');
    expect(line).toContain('src/tools/listing-budget.ts');
  });
});

describe('the measured listing is the served listing', () => {
  const env = loadConfig().env;
  const entries = orderedToolEntries();

  it.each(HTTP_VIEWS)('%s', async (view) => {
    const expected = listView(
      view,
      {
        excludeOnboardingFromDefault: env.MCP_DEFAULT_FACET_EXCLUDE_ONBOARDING,
        exposePasswordLogin: env.ALTEGIO_EXPOSE_PASSWORD_LOGIN,
        publicBaseUrl: env.MCP_PUBLIC_BASE_URL,
      },
      entries
    ).tools;
    const served = await servedListResult(view);
    expect(served).toEqual({ tools: expected });
    expect(Buffer.byteLength(JSON.stringify(served), 'utf8')).toBe(
      listingBytes(expected)
    );
  });
});
