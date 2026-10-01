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
  type ElicitRequestFormParams,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js';
import { registerTools } from '../tools/registry.js';
import { CONFIRMATION_TOKEN_ARG } from '../tools/confirmation.js';
import type { AltegioClient } from '../providers/altegio-client.js';

const LOCATION = 4564;
const TEAM_MEMBER = 123;
const SERVICE = 789;

type ElicitAnswer = 'accept' | 'decline' | 'cancel';

interface Harness {
  client: Client;
  deleteStaff: jest.Mock;
  removeServiceFromStaff: jest.Mock;
  elicitations: Array<{
    message: string;
    requestedSchema: ElicitRequestFormParams['requestedSchema'];
  }>;
  close: () => Promise<void>;
}

/** Stub the target reads and writes without touching real business data. */
function altegioStub(
  deleteStaff: jest.Mock,
  removeServiceFromStaff: jest.Mock
): AltegioClient {
  return {
    isAuthenticated: () => true,
    getStaff: jest.fn(async () => [
      {
        id: TEAM_MEMBER,
        name: 'Ivan Petrov',
        position: { id: 7, title: 'Stylist' },
      },
    ]),
    getService: jest.fn(async () => ({ id: SERVICE, title: 'Test service' })),
    deleteStaff,
    removeServiceFromStaff,
  } as unknown as AltegioClient;
}

async function connect(options: {
  elicitation: boolean | 'form' | 'url';
  answer?: ElicitAnswer;
  content?: ElicitResult['content'];
  /** Reply with an error instead of an answer, like a host with a broken UI. */
  broken?: boolean;
}): Promise<Harness> {
  const deleteStaff = jest.fn(async () => undefined);
  const removeServiceFromStaff = jest.fn(async () => undefined);
  const elicitations: Harness['elicitations'] = [];

  const server = new Server(
    { name: 'test-server', version: '0.0.0' },
    { capabilities: { tools: {} } }
  );
  registerTools(server, altegioStub(deleteStaff, removeServiceFromStaff));

  const client = new Client(
    { name: 'test-host', version: '0.0.0' },
    {
      capabilities: options.elicitation
        ? {
            elicitation:
              options.elicitation === 'form'
                ? { form: {} }
                : options.elicitation === 'url'
                  ? { url: {} }
                  : {},
          }
        : {},
    }
  );

  if (options.elicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const params = request.params;
      if (params.mode === 'url') throw new Error('Unexpected URL elicitation');
      elicitations.push({
        message: params.message,
        requestedSchema: params.requestedSchema,
      });
      if (options.broken) throw new Error('confirmation UI unavailable');

      const answer = options.answer ?? 'accept';
      return answer === 'accept'
        ? {
            action: 'accept',
            ...(options.content !== undefined
              ? { content: options.content }
              : {}),
          }
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
    removeServiceFromStaff,
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
    name: 'team_members_delete',
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
      expect(h.elicitations[0]!.requestedSchema).toEqual({
        type: 'object',
        properties: {},
      });

      expect(h.deleteStaff).toHaveBeenCalledWith(LOCATION, TEAM_MEMBER);
      expect(firstText(result)).toContain('Deleted team member');
    } finally {
      await h.close();
    }
  });

  it.each([
    [true, 'accept'],
    ['form', 'accept'],
    [true, 'decline'],
    [true, 'cancel'],
  ] as const)(
    'handles service unlink with capability %s and action %s',
    async (elicitation, answer) => {
      const h = await connect({ elicitation, answer });
      try {
        const result = await h.client.callTool({
          name: 'services_unlink_team_member',
          arguments: {
            location_id: LOCATION,
            service_id: SERVICE,
            team_member_id: TEAM_MEMBER,
          },
        });
        if (answer === 'accept') {
          expect(result.isError).not.toBe(true);
          expect(h.removeServiceFromStaff).toHaveBeenCalledTimes(1);
          expect(h.removeServiceFromStaff).toHaveBeenCalledWith(
            LOCATION,
            SERVICE,
            TEAM_MEMBER
          );
        } else {
          expect(result.isError).toBe(true);
          expect(h.removeServiceFromStaff).not.toHaveBeenCalled();
        }
        expect(h.elicitations[0]!.message).toContain('Test service');
      } finally {
        await h.close();
      }
    }
  );

  it.each<NonNullable<ElicitResult['content']>>([{}, { decision: 'confirm' }])(
    'accepts submitted content %j without a second confirmation field',
    async (content) => {
      const h = await connect({ elicitation: true, content });
      try {
        const result = await callDeleteStaff(h.client);
        expect(result.isError).not.toBe(true);
        expect(h.deleteStaff).toHaveBeenCalledTimes(1);
      } finally {
        await h.close();
      }
    }
  );

  it.each([
    ['decline', 'Confirmation declined'],
    ['cancel', 'Confirmation dismissed by the host'],
  ] as const)(
    'does not delete when the host answers %s',
    async (answer, message) => {
      const h = await connect({ elicitation: true, answer });
      try {
        const result = await callDeleteStaff(h.client);
        expect(h.elicitations).toHaveLength(1);
        expect(h.deleteStaff).not.toHaveBeenCalled();
        expect(result.isError).toBe(true);
        expect(firstText(result)).toContain(message);
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
        name: 'team_members_list',
        arguments: { location_id: LOCATION },
      });
      expect(h.elicitations).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
});

describe('destructive confirmation — host WITHOUT form elicitation', () => {
  it.each([false, 'url'] as const)(
    'performs nothing and explains the consequence with capability %s',
    async (elicitation) => {
      const h = await connect({ elicitation });
      try {
        const result = await callDeleteStaff(h.client);

        expect(h.deleteStaff).not.toHaveBeenCalled();
        expect(h.elicitations).toHaveLength(0);
        expect(result.isError).toBe(true);
        const text = firstText(result);
        expect(text).toContain('nothing was changed yet');
        expect(text).toContain('Ivan Petrov');
        expect(text).toContain('can no longer be booked');
        expect(text).toContain(`${CONFIRMATION_TOKEN_ARG}="`);
      } finally {
        await h.close();
      }
    }
  );

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
      expect(firstText(second)).toContain('Deleted team member');
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

      const deleteStaff = a.tools.find(
        (tool) => tool.name === 'team_members_delete'
      );
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
