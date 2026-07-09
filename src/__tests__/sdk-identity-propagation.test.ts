import { describe, it, expect } from '@jest/globals';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { runWithIdentity, getRequestIdentity } from '../request-context.js';

/**
 * End-to-end proof that the delegated identity bound with runWithIdentity in the
 * HTTP layer actually reaches a tool handler THROUGH the real MCP SDK dispatch
 * (Protocol._onrequest → handler), not just through our Express wrapper.
 *
 * InMemoryTransport.send() invokes the peer's onmessage synchronously, exactly
 * like StreamableHTTPServerTransport.handleRequest() does for tool-call POSTs in
 * production — so this test exercises the same AsyncLocalStorage propagation
 * path the real transport uses.
 */
describe('SDK identity propagation', () => {
  async function connectedPair(): Promise<{
    client: Client;
    // Maps each call's `tag` argument to the identity email the handler saw.
    seenByTag: Map<string, string | null | undefined>;
  }> {
    const seenByTag = new Map<string, string | null | undefined>();

    const server = new Server(
      { name: 'test', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        { name: 'probe', description: 'echo identity', inputSchema: { type: 'object' } },
      ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Yield first, so concurrent calls interleave and a leaked context shows.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const identity = getRequestIdentity();
      const tag = String(request.params.arguments?.tag ?? '');
      seenByTag.set(
        tag,
        identity === undefined ? undefined : identity === null ? null : identity.email
      );
      return { content: [{ type: 'text', text: 'ok' }] };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '1.0.0' }, { capabilities: {} });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    return { client, seenByTag };
  }

  it('delivers the bound user identity to the tool handler', async () => {
    const { client, seenByTag } = await connectedPair();

    await runWithIdentity({ kind: 'user', email: 'a@example.com' }, () =>
      client.callTool({ name: 'probe', arguments: { tag: 'solo' } })
    );

    expect(seenByTag.get('solo')).toBe('a@example.com');
  });

  it('delivers an anonymous (null) context to the tool handler', async () => {
    const { client, seenByTag } = await connectedPair();

    await runWithIdentity(null, () =>
      client.callTool({ name: 'probe', arguments: { tag: 'anon' } })
    );

    expect(seenByTag.get('anon')).toBeNull();
  });

  it('keeps two interleaved calls on their own identities', async () => {
    const { client, seenByTag } = await connectedPair();

    // Fire both without awaiting between them; the handler yields, so they
    // interleave. Each must still observe its own identity.
    await Promise.all([
      runWithIdentity({ kind: 'user', email: 'a@example.com' }, () =>
        client.callTool({ name: 'probe', arguments: { tag: 'A' } })
      ),
      runWithIdentity({ kind: 'user', email: 'b@example.com' }, () =>
        client.callTool({ name: 'probe', arguments: { tag: 'B' } })
      ),
    ]);

    expect(seenByTag.get('A')).toBe('a@example.com');
    expect(seenByTag.get('B')).toBe('b@example.com');
  });
});
