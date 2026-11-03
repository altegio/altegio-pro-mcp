#!/usr/bin/env node
import './config/env.js';
import { createServer, startServer, type MCPServer } from './server.js';
import { ALL_TOOLS_FACET } from './tools/facets.js';
import { loadConfig } from './config/schema.js';
import { createLogger, flushLogs } from './utils/logger.js';
import { isEntrypoint, installShutdownSignals } from './utils/entrypoint.js';

const logger = createLogger('main');

export async function main(
  options: { handleSignals?: boolean } = {}
): Promise<MCPServer> {
  const server = createServer({ facet: ALL_TOOLS_FACET });
  await startServer(server);
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
