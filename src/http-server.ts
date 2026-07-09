#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createServer } from './server.js';
import { createLogger } from './utils/logger.js';
import { parseIdentityHeaders, runWithIdentity } from './request-context.js';

const logger = createLogger('http-server');

/**
 * Build the Express app and the per-session transport registry.
 *
 * Every request's proxy-verified identity (`x-mcp-auth-*` headers) is bound to
 * the async context for the duration of the SDK message handling, so tool
 * handlers running on a shared server/client instance resolve the correct
 * per-request identity. The identity wrapping is intentionally localized here
 * so a future transport migration (PRO-3) can move it in one place.
 */
export function createApp(): {
  app: express.Express;
  transports: Record<string, SSEServerTransport>;
} {
  const app = express();

  // Middleware
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Store transports by session ID
  const transports: Record<string, SSEServerTransport> = {};

  // SSE endpoint - GET to establish connection
  app.get('/mcp', async (req, res) => {
    logger.info('New SSE connection request');

    try {
      const transport = new SSEServerTransport('/mcp', res);
      const sessionId = transport.sessionId;

      transports[sessionId] = transport;

      res.on('close', () => {
        logger.info(`SSE connection closed: ${sessionId}`);
        delete transports[sessionId];
      });

      // Create new server instance for this connection
      const server = createServer();
      await runWithIdentity(parseIdentityHeaders(req.headers), () =>
        server.connect(transport)
      );

      logger.info(`SSE connection established: ${sessionId}`);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to establish SSE connection: ${errMsg}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to establish connection' });
      }
    }
  });

  // POST endpoint for messages
  app.post('/mcp', async (req, res) => {
    try {
      const sessionId = req.query.sessionId as string;
      const transport = transports[sessionId];

      if (!transport) {
        logger.warn(`Session not found: ${sessionId}`);
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      await runWithIdentity(parseIdentityHeaders(req.headers), () =>
        transport.handlePostMessage(req, res, req.body)
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to handle POST message: ${errMsg}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to handle message' });
      }
    }
  });

  return { app, transports };
}

async function startHTTPServer(): Promise<void> {
  const port = parseInt(process.env.PORT || '3000', 10);
  const { app } = createApp();

  // Start Express server
  app.listen(port, () => {
    logger.info(`HTTP server listening on port ${port}`);
    logger.info(`SSE endpoint available at http://localhost:${port}/mcp`);
  });
}

// Handle process signals
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down...');
  process.exit(0);
});

// Run if executed directly (not when imported by tests)
if (process.argv[1] && !process.argv[1].includes('jest')) {
  startHTTPServer().catch((error) => {
    logger.error('Failed to start HTTP server', error);
    process.exit(1);
  });
}

export { startHTTPServer };
