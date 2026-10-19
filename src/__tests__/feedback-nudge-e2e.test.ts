/**
 * The feedback nudge and the report limit over the real SDK transport: a
 * failed call that looks like a defect ends with one sentence pointing at
 * `feedback_submit`, other failures do not, and the report limit holds per
 * signed-in user across stateless requests (one server per request).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../http-server.js';
import { createLogger } from '../utils/logger.js';
import {
  clearFeedbackRateLimit,
  FEEDBACK_NUDGE,
  FEEDBACK_RATE_LIMIT,
} from '../tools/definitions/feedback.tools.js';

const REPORT = {
  kind: 'feature_request',
  summary: 'No way to merge duplicate clients',
  goal: 'Merge two client cards of the same person.',
};

describe('feedback nudge and report limit, end to end', () => {
  const nativeFetch = global.fetch;
  let credentialsDir: string;
  let upstreamStatus = 500;

  beforeAll(() => {
    credentialsDir = mkdtempSync(join(tmpdir(), 'altegio-feedback-'));
    process.env.CREDENTIALS_DIR = credentialsDir;
  });
  beforeEach(() => {
    clearFeedbackRateLimit();
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      if (!url.startsWith('https://api.alteg.io/')) {
        return nativeFetch(input, init);
      }
      return Response.json(
        { success: false, meta: { message: 'Upstream says no' } },
        { status: upstreamStatus }
      );
    });
    jest
      .spyOn(createLogger('agent-feedback'), 'info')
      .mockImplementation(() => {});
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });
  afterAll(() => {
    rmSync(credentialsDir, { recursive: true, force: true });
    delete process.env.CREDENTIALS_DIR;
  });

  /** Run `fn` with a function that POSTs one stateless `tools/call`. */
  async function withServer(
    fn: (
      call: (
        name: string,
        args: Record<string, unknown>,
        token?: string
      ) => Promise<{ isError?: boolean; text: string }>
    ) => Promise<void>
  ): Promise<void> {
    const { app } = createApp();
    const server = app.listen(0);
    let id = 0;
    try {
      const { port } = server.address() as AddressInfo;
      await fn(async (name, args, token = 'user-token-a') => {
        id += 1;
        const res = await nativeFetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            accept: 'application/json, text/event-stream',
            'content-type': 'application/json',
            'x-altegio-user-token': token,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: args },
          }),
        });
        const body = await res.text();
        const data = body
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice('data: '.length);
        const result = JSON.parse(data ?? body).result as {
          isError?: boolean;
          content: Array<{ type: string; text?: string }>;
        };
        return {
          isError: result.isError,
          text: result.content.map((block) => block.text ?? '').join('\n'),
        };
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  }

  it('ends an API 5xx failure with the nudge and logs that it did', async () => {
    upstreamStatus = 500;
    const toolLog = jest.spyOn(createLogger('tool-calls'), 'info');
    await withServer(async (call) => {
      const result = await call('team_members_list', { location_id: 4564 });
      expect(result.isError).toBe(true);
      expect(result.text.endsWith(FEEDBACK_NUDGE)).toBe(true);
    });
    expect(toolLog.mock.calls[0]?.[0]).toMatchObject({
      tool: 'team_members_list',
      error_class: 'upstream_5xx',
      feedback_nudge: true,
    });
  });

  it('adds no nudge to a 4xx answer or to arguments the agent can fix', async () => {
    upstreamStatus = 404;
    const toolLog = jest.spyOn(createLogger('tool-calls'), 'info');
    await withServer(async (call) => {
      const notFound = await call('team_members_list', { location_id: 4564 });
      expect(notFound.isError).toBe(true);
      expect(notFound.text).not.toContain('feedback_submit');
      const invalid = await call('team_members_list', { location_id: 'x' });
      expect(invalid.isError).toBe(true);
      expect(invalid.text).not.toContain('feedback_submit');
    });
    for (const [fields] of toolLog.mock.calls) {
      expect(fields).not.toHaveProperty('feedback_nudge');
    }
  });

  it('limits reports per signed-in user across stateless requests', async () => {
    const toolLog = jest.spyOn(createLogger('tool-calls'), 'info');
    await withServer(async (call) => {
      for (let i = 0; i < FEEDBACK_RATE_LIMIT.reports; i += 1) {
        expect((await call('feedback_submit', REPORT)).isError).toBeFalsy();
      }
      const refused = await call('feedback_submit', REPORT);
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('Report not recorded');
      // A refused report is not itself nudged towards another report.
      expect(refused.text).not.toContain(FEEDBACK_NUDGE);
      const other = await call('feedback_submit', REPORT, 'user-token-b');
      expect(other.isError).toBeFalsy();
    });
    const classes = toolLog.mock.calls.map(
      ([fields]) => (fields as unknown as Record<string, unknown>).error_class
    );
    expect(classes.filter((value) => value === 'rate_limited')).toHaveLength(1);
  });
});
