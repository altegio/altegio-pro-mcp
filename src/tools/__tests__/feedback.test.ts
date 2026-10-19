import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  requestContextFromHeaders,
  runWithContext,
} from '../../request-context.js';
import { createServer } from '../../server.js';
import { createLogger } from '../../utils/logger.js';
import {
  createToolCallObservation,
  runObservingToolCall,
} from '../../utils/tool-call-observation.js';
import { AltegioApiError } from '../../utils/errors.js';
import {
  clearFeedbackRateLimit,
  FEEDBACK_RATE_LIMIT,
  FEEDBACK_TEXT_LIMITS,
  maskFeedbackText,
  submitFeedbackTool,
} from '../definitions/feedback.tools.js';
import { withErrorHandling } from '../tool-result.js';
import { searchOperationsTool } from '../definitions/executor.tools.js';
import { VIEW_KEYS, type FacetKey } from '../facets.js';

const feedbackLog = createLogger('agent-feedback');
const toolLog = createLogger('tool-calls');

const REPORT = {
  kind: 'bug',
  summary: 'appointments_list ignores team_member_id',
  goal: 'List tomorrow’s appointments of one team member for the owner.',
  tool: 'appointments_list',
  operation_id: 'get_account_list',
  location_id: '4564',
  observed: 'Every team member’s appointments came back.',
  expected: 'Only team member 101’s appointments.',
  impact: 'workaround',
};

const call = (args: unknown) =>
  submitFeedbackTool.createHandler({} as never)(args);

/** The same call, made by the signed-in user whose Altegio token is `token`. */
const callAs = (token: string, args: unknown) =>
  runWithContext(
    requestContextFromHeaders({ 'x-altegio-user-token': token }),
    () => call(args)
  );

beforeEach(() => {
  clearFeedbackRateLimit();
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('maskFeedbackText', () => {
  it.each([
    ['write to anna.k@example.com today', 'write to [email] today'],
    ['call +7 (999) 123-45-67 back', 'call [phone] back'],
    ['call 8 (999) 123-45-67 back', 'call [phone] back'],
    ['phone 79991234567 stored', 'phone [phone] stored'],
    [
      'Authorization: Bearer abcdef0123456789abcd',
      'Authorization: Bearer [secret]',
    ],
    ['sent user_token=deadbeefcafe1234', 'sent user_token=[secret]'],
    ['"password": "hunter2"', '"password": "[secret]"'],
  ])('masks %j', (input, expected) => {
    expect(maskFeedbackText(input, 500)).toEqual({
      text: expected,
      masked: 1,
    });
  });

  it('keeps ids, dates, times and amounts a bug report needs', () => {
    const input =
      'location 4564, appointment 1234567890 on 2026-10-19 10:00, total 1500.50 CZK';
    expect(maskFeedbackText(input, 500)).toEqual({ text: input, masked: 0 });
  });

  it('drops control characters, collapses blank lines and keeps the bound', () => {
    const { text } = maskFeedbackText(
      'a\u0000b\r\n\n\n\nc ' + 'x'.repeat(50),
      20
    );
    expect(text).toBe('a b\n\nc ' + 'x'.repeat(13));
    expect(text).toHaveLength(20);
  });
});

describe('feedback_submit', () => {
  it('records the report as one masked, bounded agent_feedback event', async () => {
    const info = jest.spyOn(feedbackLog, 'info').mockImplementation(() => {});
    const result = await call({
      ...REPORT,
      error_text: 'Client anna.k@example.com not found',
    });

    expect(result.isError).toBeUndefined();
    const receipt = result.structuredContent as Record<string, unknown>;
    expect(receipt).toEqual({
      status: 'recorded',
      report_id: expect.stringMatching(/^fb_[0-9a-f]{12}$/),
      kind: 'bug',
      masked_values: 1,
    });
    // The receipt names the report; it does not echo what the agent wrote.
    const text = result.content.map((block) => block.text).join(' ');
    expect(text).toContain(String(receipt.report_id));
    expect(text).toContain('nothing in the location changed');
    expect(text).not.toContain(REPORT.summary);

    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toEqual({
      event: 'agent_feedback',
      report_id: receipt.report_id,
      kind: 'bug',
      impact: 'workaround',
      reported_tool: 'appointments_list',
      reported_operation_id: 'get_account_list',
      reported_operation_documented: true,
      location_id: 4564,
      summary: REPORT.summary,
      goal: REPORT.goal,
      observed: REPORT.observed,
      expected: REPORT.expected,
      error_text: 'Client [email] not found',
      masked_values: 1,
    });
  });

  it('names the model as a log-safe token and the user by a hash', async () => {
    const info = jest.spyOn(feedbackLog, 'info').mockImplementation(() => {});
    await callAs('user-token-a', { ...REPORT, model: 'Claude Opus 5.5 (1M)' });
    const event = info.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(event.model).toBe('Claude_Opus_5.5_1M');
    expect(event.principal).toMatch(/^token-[0-9a-f]{16}$/);
    expect(JSON.stringify(event)).not.toContain('user-token-a');
  });

  it('records at most the rate limit per caller and window', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-19T12:00:00Z') });
    const info = jest.spyOn(feedbackLog, 'info').mockImplementation(() => {});
    const { reports, windowMs } = FEEDBACK_RATE_LIMIT;
    for (let i = 0; i < reports; i += 1) {
      expect((await callAs('user-token-a', REPORT)).isError).toBeUndefined();
    }
    const refused = await callAs('user-token-a', REPORT);
    expect(refused.isError).toBe(true);
    expect(refused.content[0]?.text).toContain('Report not recorded');
    // Another person is counted apart.
    expect((await callAs('user-token-b', REPORT)).isError).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(reports + 1);

    jest.setSystemTime(Date.now() + windowMs + 1);
    expect((await callAs('user-token-a', REPORT)).isError).toBeUndefined();
  });

  it('says whether a reported operation is in the catalog', async () => {
    const info = jest.spyOn(feedbackLog, 'info').mockImplementation(() => {});
    await call({
      kind: 'feature_request',
      summary: 'No way to merge duplicate clients',
      goal: 'Merge two client cards of the same person.',
      operation_id: 'merge_clients',
    });
    expect(info.mock.calls[0]?.[0]).toMatchObject({
      kind: 'feature_request',
      reported_operation_id: 'merge_clients',
      reported_operation_documented: false,
    });
  });

  it.each([
    ['an unknown kind', { kind: 'complaint' }],
    [
      'a summary over its bound',
      { summary: 'x'.repeat(FEEDBACK_TEXT_LIMITS.summary + 1) },
    ],
    ['a blank goal', { goal: '   ' }],
    ['a tool name that is not a tool name', { tool: 'Drop table; --' }],
    ['an argument the tool does not take', { client_phone: '+79991234567' }],
  ])('refuses %s and records nothing', async (_, override) => {
    const info = jest.spyOn(feedbackLog, 'info').mockImplementation(() => {});
    const result = await call({ ...REPORT, ...override });
    expect(result.isError).toBe(true);
    expect(info).not.toHaveBeenCalled();
  });
});

describe('feedback_submit on the served surface', () => {
  async function connect(facet: FacetKey): Promise<Client> {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createServer({ facet });
    const client = new Client({ name: 'feedback-test', version: '2.1.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    return client;
  }

  it.each(VIEW_KEYS)('is served on the %s view', async (view) => {
    const client = await connect(view);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('feedback_submit');
    await client.close();
  });

  it('writes the event with the correlation fields of its tool_call line', async () => {
    const feedback = jest
      .spyOn(feedbackLog, 'info')
      .mockImplementation(() => {});
    const calls = jest.spyOn(toolLog, 'info').mockImplementation(() => {});
    const client = await connect('readonly');
    const result = (await client.callTool({
      name: 'feedback_submit',
      arguments: REPORT,
    })) as CallToolResult;
    await client.close();

    expect(result.isError).toBeFalsy();
    const event = feedback.mock.calls[0]?.[0] as Record<string, unknown>;
    const line = calls.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(line).toMatchObject({
      event: 'tool_call',
      tool: 'feedback_submit',
      outcome: 'success',
    });
    for (const key of ['route', 'transport', 'client_name', 'client_version']) {
      expect(event[key]).toBeDefined();
      expect(event[key]).toBe(line[key]);
    }
    expect(event).toMatchObject({
      route: '/mcp/readonly',
      client_name: 'feedback-test',
      client_version: '2.1.0',
    });
  });
});

describe('the unexpected-error note behind the feedback nudge', () => {
  const observed = async (thrown: unknown) => {
    const observation = createToolCallObservation();
    const result = await runObservingToolCall(observation, () =>
      withErrorHandling('some_tool', async () => {
        throw thrown;
      })
    );
    return { result, unexpected: observation.unexpectedError === true };
  };

  it('marks an error no typed class describes', async () => {
    const { result, unexpected } = await observed(new TypeError('boom'));
    expect(result.isError).toBe(true);
    expect(unexpected).toBe(true);
  });

  it('leaves a typed API error unmarked', async () => {
    const { unexpected } = await observed(
      new AltegioApiError('Not found', 404)
    );
    expect(unexpected).toBe(false);
  });
});

describe('the missing-operation nudge', () => {
  const search = (args: unknown) =>
    searchOperationsTool.createHandler({} as never)(args);

  it('ends a search that matched nothing with a pointer to feedback_submit', async () => {
    const result = await search({ query: 'zzqx teleport wombat' });
    expect(result.content[0]?.text).toContain('feedback_submit');
  });

  it('adds nothing to a search that found operations', async () => {
    const result = await search({ query: 'appointments' });
    expect(result.content.map((block) => block.text).join(' ')).not.toContain(
      'feedback_submit'
    );
  });
});
