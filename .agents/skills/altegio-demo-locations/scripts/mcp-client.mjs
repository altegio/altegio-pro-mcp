#!/usr/bin/env node

const DEFAULT_ENDPOINT = 'https://mcp.alteg.io/pro';

function parseSse(text) {
  const messages = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)));

  if (messages.length === 0) {
    throw new Error(
      `Hosted MCP returned no JSON-RPC message: ${text.slice(0, 300)}`
    );
  }

  return messages.at(-1);
}

export class HostedMcpSession {
  constructor({ token, companyId, endpoint = DEFAULT_ENDPOINT }) {
    if (!token) throw new Error('ALTEGIO_USER_TOKEN is required');
    this.token = token;
    this.companyId = companyId;
    this.endpoint = endpoint;
    this.sessionId = null;
    this.nextId = 1;
  }

  headers() {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    if (this.companyId)
      headers['X-Altegio-Company-Id'] = String(this.companyId);
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  async request(method, params, { notification = false } = {}) {
    const payload = { jsonrpc: '2.0', method };
    if (!notification) payload.id = this.nextId++;
    if (params !== undefined) payload.params = params;

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(
        `Hosted MCP HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`
      );
    }

    const returnedSessionId = response.headers.get('mcp-session-id');
    if (returnedSessionId) this.sessionId = returnedSessionId;
    if (notification) return null;

    const message = parseSse(await response.text());
    if (message.error) {
      throw new Error(`MCP ${message.error.code}: ${message.error.message}`);
    }
    return message.result;
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'codex-demo-curator', version: '1.0' },
    });
    await this.request('notifications/initialized', undefined, {
      notification: true,
    });
    return this;
  }

  async callTool(name, args = {}) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await this.request('tools/call', {
        name,
        arguments: args,
      });
      const text = result.content
        ?.filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');
      if (!result.isError) return { ...result, text };
      if (!/rate limit|HTTP 429/i.test(text || '') || attempt === 5) {
        throw new Error(`${name}: ${text || 'tool call failed'}`);
      }
      const retrySeconds = Number(
        text.match(/try again in (\d+) second/i)?.[1] || 0
      );
      const waitMs = Math.max(
        1_200,
        retrySeconds * 1_000 + 250,
        400 * 2 ** attempt
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    throw new Error(`${name}: retry budget exhausted`);
  }

  async close() {
    if (!this.sessionId) return;
    await fetch(this.endpoint, { method: 'DELETE', headers: this.headers() });
    this.sessionId = null;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [companyIdRaw, toolName, argsRaw = '{}'] = process.argv.slice(2);
  if (!companyIdRaw || !toolName) {
    throw new Error(
      'Usage: mcp-client.mjs <company-id|unscoped> <tool-name> [json-args]'
    );
  }

  const session = await new HostedMcpSession({
    token: process.env.ALTEGIO_USER_TOKEN,
    companyId: companyIdRaw === 'unscoped' ? undefined : Number(companyIdRaw),
  }).initialize();
  try {
    const result = await session.callTool(toolName, JSON.parse(argsRaw));
    process.stdout.write(
      `${JSON.stringify(result.structuredContent ?? { text: result.text }, null, 2)}\n`
    );
  } finally {
    await session.close();
  }
}
