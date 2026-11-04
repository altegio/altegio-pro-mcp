#!/usr/bin/env node
import './config/env.js';
import { createServer, startServer } from './server.js';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { RequestActivity } from './utils/request-lifecycle.js';
import { ALL_TOOLS_FACET } from './tools/facets.js';
import { loadConfig } from './config/schema.js';
import { createLogger, flushLogs } from './utils/logger.js';
import { isEntrypoint, installShutdownSignals } from './utils/entrypoint.js';

const logger = createLogger('main');

export interface StdioRuntime {
  activity: RequestActivity;
  close(): Promise<void>;
}

export async function main(
  options: { handleSignals?: boolean } = {}
): Promise<StdioRuntime> {
  let server: StdioRuntime;
  if (loadConfig().env.MCP_PROTOCOL_MODE === 'dual') {
    const activity = new RequestActivity();
    const handle = serveStdio(() =>
      createServer({ facet: ALL_TOOLS_FACET, activity })
    );
    server = { activity, close: () => handle.close() };
  } else {
    const legacy = createServer({ facet: ALL_TOOLS_FACET });
    await startServer(legacy);
    server = legacy;
  }
  if (options.handleSignals) {
    installShutdownSignals(async () => {
      server.activity.stop();
      process.stdin.pause();
      await server.activity.drain(loadConfig().env.MCP_SHUTDOWN_TIMEOUT_MS);
      server.activity.abort();
      await server.close();
      await flushLogs();
    });
  }
  logger.info('MCP server running');
  return server;
}

if (isEntrypoint()) {
  main({ handleSignals: true }).catch(async (error) => {
    logger.error(
      { error_type: error instanceof Error ? error.name : 'unknown' },
      'Failed to start server'
    );
    await flushLogs();
    process.exit(1);
  });
}
