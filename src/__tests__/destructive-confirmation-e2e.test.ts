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
import { Server } from '@modelcontextprotocol/server';
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
import { createLogger } from '../utils/logger.js';

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
  /**
   * Never answer, like a host that declares elicitation and shows no prompt;
   * the request ends only when the server cancels it.
   */
  silent?: boolean;
  elicitationTimeoutMs?: number;
}): Promise<Harness> {
  const deleteStaff = jest.fn(async () => undefined);
  const removeServiceFromStaff = jest.fn(async () => undefined);
  const elicitations: Harness['elicitations'] = [];

  const server = new Server(
    { name: 'test-server', version: '0.0.0' },
    { capabilities: { tools: {} } }
  );
  registerTools(server, altegioStub(deleteStaff, removeServiceFromStaff), {
    ...(options.elicitationTimeoutMs !== undefined
      ? { elicitationTimeoutMs: options.elicitationTimeoutMs }
      : {}),
  });

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
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      const params = request.params;
      if (params.mode === 'url') throw new Error('Unexpected URL elicitation');
      elicitations.push({
        message: params.message,
        requestedSchema: params.requestedSchema,
      });
      if (options.broken) throw new Error('confirmation UI unavailable');
      if (options.silent) {
        return new Promise<never>((_resolve, reject) => {
          extra.signal.addEventListener('abort', () =>
            reject(new Error('cancelled by the server'))
          );
        });
      }

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

function tokenOf(result: CallToolResult): string {
  return new RegExp(`${CONFIRMATION_TOKEN_ARG}="([^"]+)"`).exec(
    firstText(result)
  )![1]!;
}

/** The `tool_call` lines logged while `run` ran. */
async function toolCallLines(
  run: () => Promise<void>
): Promise<Array<Record<string, unknown>>> {
  const log = createLogger('tool-calls');
  const info = jest.spyOn(log, 'info');
  const error = jest.spyOn(log, 'error');
  try {
    await run();
    return [...info.mock.calls, ...error.mock.calls]
      .map(([fields]) => fields as unknown as Record<string, unknown>)
      .filter((fields) => fields.event === 'tool_call');
  } finally {
    info.mockRestore();
    error.mockRestore();
  }
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

  it('logs a decline as a confirmation error, not as a confirmation request', async () => {
    const h = await connect({ elicitation: true, answer: 'decline' });
    try {
      const lines = await toolCallLines(async () => {
        await callDeleteStaff(h.client);
      });
      expect(lines).toEqual([
        expect.objectContaining({
          tool: 'team_members_delete',
          outcome: 'error',
          error_class: 'confirmation_declined',
          error_type: 'confirmation',
          confirmation: 'declined',
        }),
      ]);
    } finally {
      await h.close();
    }
  });

  it('falls back to the token when the host fails to deliver the prompt', async () => {
    const h = await connect({ elicitation: true, broken: true });
    try {
      let result: CallToolResult | undefined;
      const lines = await toolCallLines(async () => {
        result = await callDeleteStaff(h.client);
      });
      expect(h.deleteStaff).not.toHaveBeenCalled();
      expect(result!.isError).toBeFalsy();
      expect(result!.structuredContent).toMatchObject({
        status: 'confirmation_required',
        changed: false,
      });
      expect(firstText(result!)).toContain(
        'could not show the confirmation prompt'
      );
      expect(lines).toEqual([
        expect.objectContaining({
          outcome: 'error',
          error_class: 'confirmation_failed',
          confirmation: 'elicitation_failed',
        }),
      ]);
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

describe('destructive confirmation — host that declares elicitation and never answers', () => {
  // 2026-11-23: Claude Code and Desktop cloud sessions, Cursor, Codex and
  // claude.ai connectors declared elicitation and showed no prompt. Each write
  // waited out the SDK's 60 s and failed with nothing to continue with, and
  // the log called it `confirmation_required`, out of the error rate.
  it('answers with a token before the host gives up, and logs an error', async () => {
    const h = await connect({
      elicitation: true,
      silent: true,
      elicitationTimeoutMs: 50,
    });
    try {
      let result: CallToolResult | undefined;
      const lines = await toolCallLines(async () => {
        result = await callDeleteStaff(h.client);
      });

      expect(h.elicitations).toHaveLength(1);
      expect(h.deleteStaff).not.toHaveBeenCalled();
      expect(result!.isError).toBeFalsy();
      expect(result!.structuredContent).toMatchObject({
        status: 'confirmation_required',
        changed: false,
      });
      const text = firstText(result!);
      expect(text).toContain('did not answer the confirmation prompt');
      expect(text).toContain('Ask the person in the conversation');
      expect(text).toContain('Ivan Petrov');
      expect(lines).toEqual([
        expect.objectContaining({
          tool: 'team_members_delete',
          outcome: 'error',
          error_class: 'confirmation_failed',
          error_type: 'confirmation',
          confirmation: 'elicitation_timeout',
        }),
      ]);
    } finally {
      await h.close();
    }
  });

  it('performs the deletion only on the repeat that carries the token', async () => {
    const h = await connect({
      elicitation: true,
      silent: true,
      elicitationTimeoutMs: 50,
    });
    try {
      const first = await callDeleteStaff(h.client);
      expect(h.deleteStaff).not.toHaveBeenCalled();

      const second = await callDeleteStaff(h.client, {
        [CONFIRMATION_TOKEN_ARG]: tokenOf(first),
      });
      expect(second.isError).toBeFalsy();
      expect(h.deleteStaff).toHaveBeenCalledTimes(1);
      expect(h.deleteStaff).toHaveBeenCalledWith(LOCATION, TEAM_MEMBER);
      // The repeat does not ask the silent host again.
      expect(h.elicitations).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('still refuses the token for another target', async () => {
    const h = await connect({
      elicitation: true,
      silent: true,
      elicitationTimeoutMs: 50,
    });
    try {
      const first = await callDeleteStaff(h.client);
      let result: CallToolResult | undefined;
      const lines = await toolCallLines(async () => {
        result = await callDeleteStaff(h.client, {
          team_member_id: 999,
          [CONFIRMATION_TOKEN_ARG]: tokenOf(first),
        });
      });
      expect(h.deleteStaff).not.toHaveBeenCalled();
      expect(result!.isError).toBe(true);
      expect(lines).toEqual([
        expect.objectContaining({
          outcome: 'error',
          error_class: 'confirmation_failed',
          confirmation: 'invalid_token',
        }),
      ]);
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
        // Waiting for a person, not a failure; the status says so.
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          status: 'confirmation_required',
          changed: false,
        });
        const text = firstText(result);
        expect(text).toContain('nothing was changed');
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

  it('accepts the repeat when it spells the ids as strings', async () => {
    const h = await connect({ elicitation: false });
    try {
      const first = await callDeleteStaff(h.client);
      const token = new RegExp(`${CONFIRMATION_TOKEN_ARG}="([^"]+)"`).exec(
        firstText(first)
      )![1]!;

      const second = await callDeleteStaff(h.client, {
        location_id: String(LOCATION),
        team_member_id: String(TEAM_MEMBER),
        [CONFIRMATION_TOKEN_ARG]: token,
      });

      expect(second.isError).toBeFalsy();
      expect(h.deleteStaff).toHaveBeenCalledWith(LOCATION, TEAM_MEMBER);
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

      // A destructive tool the default view lists.
      const deleteAppointment = a.tools.find(
        (tool) => tool.name === 'appointments_delete'
      );
      const properties = deleteAppointment?.inputSchema.properties as
        Record<string, unknown> | undefined;
      // Present on every connection, never negotiated per client.
      expect(properties).toHaveProperty(CONFIRMATION_TOKEN_ARG);
      expect(deleteAppointment?.inputSchema.required).not.toContain(
        CONFIRMATION_TOKEN_ARG
      );
    } finally {
      await withElicitation.close();
      await without.close();
    }
  });
});
