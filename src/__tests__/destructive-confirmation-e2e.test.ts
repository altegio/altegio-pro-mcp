/**
 * The destructive-confirmation gate, end to end over a real MCP session.
 *
 * Everything here goes through `Client` ↔ `Server` on a linked in-memory
 * transport pair, so the client capabilities the server reads are the ones a
 * real host negotiated at `initialize`, and `tools/call` takes the same path a
 * host takes. The two cases the feature exists for are the two hosts below:
 * one that declares `elicitation`, and one that does not.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  ElicitRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../tools/registry.js';
import { CONFIRMATION_TOKEN_ARG } from '../tools/confirmation.js';
import type { AltegioClient } from '../providers/altegio-client.js';

const LOCATION = 4564;
const TEAM_MEMBER = 123;

type ElicitAnswer = 'accept' | 'decline' | 'cancel';

interface Harness {
  client: Client;
  deleteStaff: jest.Mock;
  elicitations: Array<{ message: string; title?: string }>;
  close: () => Promise<void>;
}

/** An `AltegioClient` stub: the two reads the gate makes, plus the write. */
function altegioStub(deleteStaff: jest.Mock): AltegioClient {
  return {
    isAuthenticated: () => true,
    getStaff: jest.fn(async () => [
      {
        id: TEAM_MEMBER,
        name: 'Ivan Petrov',
        position: { id: 7, title: 'Stylist' },
      },
    ]),
    deleteStaff,
  } as unknown as AltegioClient;
}

async function connect(options: {
  elicitation: boolean;
  answer?: ElicitAnswer;
  /** Reply with an error instead of an answer, like a host with a broken UI. */
  broken?: boolean;
}): Promise<Harness> {
  const deleteStaff = jest.fn(async () => undefined);
  const elicitations: Array<{ message: string; title?: string }> = [];

  const server = new Server(
    { name: 'test-server', version: '0.0.0' },
    { capabilities: { tools: {} } }
  );
  registerTools(server, altegioStub(deleteStaff));

  const client = new Client(
    { name: 'test-host', version: '0.0.0' },
    {
      capabilities: options.elicitation ? { elicitation: {} } : {},
    }
  );

  if (options.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const params = request.params as {
        message: string;
        requestedSchema?: {
          properties?: Record<string, { title?: string }>;
        };
      };
      elicitations.push({
        message: params.message,
        title: params.requestedSchema?.properties?.decision?.title,
      });
      if (options.broken) throw new Error('confirmation UI unavailable');

      const answer = options.answer ?? 'accept';
      return answer === 'accept'
        ? { action: 'accept', content: { decision: 'confirm' } }
        : { action: answer };
    });
  }

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    client,
    deleteStaff,
    elicitations,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function firstText(result: CallToolResult): string {
  const block = result.content[0];
  return block && block.type === 'text' ? block.text : '';
}

async function callDeleteStaff(
  client: Client,
  args: Record<string, unknown> = {}
): Promise<CallToolResult> {
  return (await client.callTool({
    name: 'delete_staff',
    arguments: {
      location_id: LOCATION,
      team_member_id: TEAM_MEMBER,
      ...args,
    },
  })) as CallToolResult;
}

describe('destructive confirmation — host WITH elicitation', () => {
  it('asks the operator before deleting, naming the person and the consequence', async () => {
    const h = await connect({ elicitation: true, answer: 'accept' });
    try {
      const result = await callDeleteStaff(h.client);

      expect(h.elicitations).toHaveLength(1);
      // The name comes from the API read, not from the raw ID.
      expect(h.elicitations[0]!.message).toContain('Ivan Petrov');
      expect(h.elicitations[0]!.message).toContain('Stylist');
      expect(h.elicitations[0]!.message).toContain(`id ${TEAM_MEMBER}`);
      expect(h.elicitations[0]!.message).toContain('can no longer be booked');
      expect(h.elicitations[0]!.title).toBe('Delete team member');

      expect(h.deleteStaff).toHaveBeenCalledWith(LOCATION, TEAM_MEMBER);
      expect(firstText(result)).toContain('Successfully deleted staff member');
    } finally {
      await h.close();
    }
  });

  it.each(['decline', 'cancel'] as const)(
    'does not delete when the operator answers %s',
    async (answer) => {
      const h = await connect({ elicitation: true, answer });
      try {
        const result = await callDeleteStaff(h.client);
        expect(h.elicitations).toHaveLength(1);
        expect(h.deleteStaff).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect(firstText(result)).toContain('Cancelled by the operator');
      } finally {
        await h.close();
      }
    }
  );

  it('does not delete when the host fails to deliver the prompt', async () => {
    const h = await connect({ elicitation: true, broken: true });
    try {
      const result = await callDeleteStaff(h.client);
      expect(h.deleteStaff).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('could not obtain confirmation');
    } finally {
      await h.close();
    }
  });

  it('leaves non-destructive tools alone', async () => {
    const h = await connect({ elicitation: true });
    try {
      await h.client.callTool({
        name: 'get_staff',
        arguments: { location_id: LOCATION },
      });
      expect(h.elicitations).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
});

describe('destructive confirmation — host WITHOUT elicitation', () => {
  it('does not hang: the first call performs nothing and explains the consequence', async () => {
    const h = await connect({ elicitation: false });
    try {
      const result = await callDeleteStaff(h.client);

      expect(h.deleteStaff).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      const text = firstText(result);
      expect(text).toContain('nothing was changed yet');
      expect(text).toContain('Ivan Petrov');
      expect(text).toContain('can no longer be booked');
      expect(text).toContain(`${CONFIRMATION_TOKEN_ARG}="`);
    } finally {
      await h.close();
    }
  });

  it('performs the deletion on the repeated call that carries the token', async () => {
    const h = await connect({ elicitation: false });
    try {
      const first = await callDeleteStaff(h.client);
      const token = new RegExp(`${CONFIRMATION_TOKEN_ARG}="([^"]+)"`).exec(
        firstText(first)
      )![1]!;

      const second = await callDeleteStaff(h.client, {
        [CONFIRMATION_TOKEN_ARG]: token,
      });

      expect(h.deleteStaff).toHaveBeenCalledTimes(1);
      expect(h.deleteStaff).toHaveBeenCalledWith(LOCATION, TEAM_MEMBER);
      expect(firstText(second)).toContain('Successfully deleted staff member');
    } finally {
      await h.close();
    }
  });

  it('refuses a token minted for a different team member', async () => {
    const h = await connect({ elicitation: false });
    try {
      const first = await callDeleteStaff(h.client);
      const token = new RegExp(`${CONFIRMATION_TOKEN_ARG}="([^"]+)"`).exec(
        firstText(first)
      )![1]!;

      const result = await callDeleteStaff(h.client, {
        team_member_id: 999,
        [CONFIRMATION_TOKEN_ARG]: token,
      });

      expect(h.deleteStaff).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
      expect(firstText(result)).toContain('is not valid for these arguments');
    } finally {
      await h.close();
    }
  });

  it('refuses a made-up token', async () => {
    const h = await connect({ elicitation: false });
    try {
      const result = await callDeleteStaff(h.client, {
        [CONFIRMATION_TOKEN_ARG]: 'confirmed',
      });
      expect(h.deleteStaff).not.toHaveBeenCalled();
      expect(result.isError).toBe(true);
    } finally {
      await h.close();
    }
  });
});

describe('tools/list stays identical for both hosts (ADR-001 D7)', () => {
  it('serves the same list and the same schemas either way', async () => {
    const withElicitation = await connect({ elicitation: true });
    const without = await connect({ elicitation: false });
    try {
      const a = await withElicitation.client.listTools();
      const b = await without.client.listTools();
      expect(a.tools).toEqual(b.tools);

      const deleteStaff = a.tools.find((tool) => tool.name === 'delete_staff');
      const properties = deleteStaff?.inputSchema.properties as
        Record<string, unknown> | undefined;
      // Present on every connection, never negotiated per client.
      expect(properties).toHaveProperty(CONFIRMATION_TOKEN_ARG);
      expect(deleteStaff?.inputSchema.required).not.toContain(
        CONFIRMATION_TOKEN_ARG
      );
    } finally {
      await withElicitation.close();
      await without.close();
    }
  });
});
