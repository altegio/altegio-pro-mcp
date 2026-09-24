import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { createApp } from '../http-server.js';
import { ConfigLoader } from '../config/schema.js';

const parseSse = async <T = unknown>(response: Response): Promise<T> => {
  const text = await response.text();
  const line = text.split('\n').find((part) => part.startsWith('data:'));
  return JSON.parse((line ?? '').slice(5).trim()) as T;
};

describe('hosted client-file upload over Streamable HTTP', () => {
  const nativeFetch = global.fetch;
  const oldToken = process.env.ALTEGIO_API_TOKEN;
  let server: ReturnType<ReturnType<typeof createApp>['app']['listen']>;
  let url: string;
  const sessions: string[] = [];
  const file = Buffer.alloc(11 * 1024 * 1024);
  for (let index = 0; index < file.length; index++) file[index] = index % 251;
  const upstream: Array<{ url: string; init: RequestInit }> = [];

  beforeAll(async () => {
    process.env.ALTEGIO_API_TOKEN = 'test-partner';
    ConfigLoader.getInstance().reset();
    server = createApp().app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });
  beforeEach(() => {
    upstream.length = 0;
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      if (String(input).startsWith('https://api.alteg.io/')) {
        upstream.push({ url: String(input), init: init! });
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              {
                id: 11,
                name: 'signed.pdf',
                size: '256 KB',
                full_link: 'https://app.alteg.io/client_files/download/7/11/',
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } }
        );
      }
      return nativeFetch(input, init);
    });
  });
  afterEach(async () => {
    await Promise.all(
      sessions.splice(0).map((session) =>
        nativeFetch(url, {
          method: 'DELETE',
          headers: { 'mcp-session-id': session },
        }).catch(() => undefined)
      )
    );
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ConfigLoader.getInstance().reset();
    if (oldToken === undefined) delete process.env.ALTEGIO_API_TOKEN;
    else process.env.ALTEGIO_API_TOKEN = oldToken;
  });

  const open = async (scope: string) => {
    const headers = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'x-altegio-user-token': 'test-user',
      'x-altegio-company-id': '7',
      'x-mcp-auth-scope': scope,
    };
    const start = await nativeFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'upload-e2e', version: '1' },
        },
      }),
    });
    expect(start.status).toBe(200);
    const session = start.headers.get('mcp-session-id')!;
    sessions.push(session);
    await parseSse(start);
    await nativeFetch(url, {
      method: 'POST',
      headers: { ...headers, 'mcp-session-id': session },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });
    return (body: unknown) =>
      nativeFetch(url, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': session },
        body: JSON.stringify(body),
      });
  };

  it('moves exact bytes from a real MCP call through JSON, validation, and multipart', async () => {
    const post = await open('mcp:pro:read mcp:pro:write');
    const response = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'clients_upload_file',
        arguments: {
          location_id: 7,
          client_id: 8,
          filename: 'signed.pdf',
          file_base64: file.toString('base64'),
        },
      },
    });
    expect(response.status).toBe(200);
    const result = await parseSse<{
      result: { isError?: boolean; structuredContent: { total_count: number } };
    }>(response);
    expect(result.result.isError).not.toBe(true);
    expect(result.result.structuredContent.total_count).toBe(1);
    expect(upstream).toHaveLength(1);
    expect(upstream[0]!.url).toContain('/company/7/clients/files/8');
    const part = (upstream[0]!.init.body as FormData).get('file') as File;
    expect(part.name).toBe('signed.pdf');
    const actual = Buffer.from(await part.arrayBuffer());
    expect(actual.length).toBe(file.length);
    expect(createHash('sha256').update(actual).digest('hex')).toBe(
      createHash('sha256').update(file).digest('hex')
    );
  });

  it('refuses a read-only grant before reaching the API', async () => {
    const post = await open('mcp:pro:read');
    const response = await post({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'clients_upload_file',
        arguments: {
          location_id: 7,
          client_id: 8,
          filename: 'signed.pdf',
          file_base64: 'AAEC',
        },
      },
    });
    expect(
      (await parseSse<{ result: { isError?: boolean } }>(response)).result
        .isError
    ).toBe(true);
    expect(upstream).toHaveLength(0);
  });

  it('rejects an oversized hosted JSON body before MCP dispatch', async () => {
    const response = await nativeFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ excess: 'x'.repeat(18 * 1024 * 1024) }),
    });
    expect(response.status).toBe(413);
    expect(
      ((await response.json()) as { error: { message: string } }).error.message
    ).toContain('17 MiB');
  });
});
