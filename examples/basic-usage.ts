/** Inspect a source-built MCP server without credentials or business API calls. */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const temporary = await mkdtemp(path.join(os.tmpdir(), 'altegio-example-'));
const client = new Client({ name: 'altegio-example', version: '1.0.0' });
try {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      cwd: temporary,
      args: [path.resolve(process.argv[2] ?? 'dist/index.js')],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: temporary,
        NODE_ENV: 'test',
        LOG_LEVEL: 'error',
        ALTEGIO_API_TOKEN: 'synthetic-example-partner',
        ALTEGIO_API_BASE: 'http://127.0.0.1:9/api/v1',
        CREDENTIALS_DIR: path.join(temporary, 'credentials'),
      },
    })
  );
  const tools = await client.listTools();
  console.log(
    'Available tools:',
    tools.tools.map((tool) => tool.name)
  );
  const prompts = await client.listPrompts();
  console.log(
    'Workflow prompts:',
    prompts.prompts.map((prompt) => prompt.name)
  );
  const resource = await client.readResource({
    uri: 'altegio://docs/product-logic',
  });
  console.log('Product resource:', resource.contents[0]?.uri);
} finally {
  await client.close();
  await rm(temporary, { recursive: true, force: true });
}
