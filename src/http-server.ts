#!/usr/bin/env node
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
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
 * so a future transport change can move it in one place.
 */
export function createApp(): {
  app: express.Express;
  transports: Record<string, StreamableHTTPServerTransport>;
} {
  const app = express();

  // Middleware
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Store transports by session ID
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // POST /mcp — client sends JSON-RPC messages
  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const identity = parseIdentityHeaders(req.headers);

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request — create transport + server
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            logger.info(`Session initialized: ${id}`);
            transports[id] = transport;
          },
        });

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            logger.info(`Transport closed for session ${sid}`);
            delete transports[sid];
          }
        };

        const server = createServer();
        await server.connect(transport);
        await runWithIdentity(identity, () =>
          transport.handleRequest(req, res, req.body)
        );
        return;
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      await runWithIdentity(identity, () =>
        transport.handleRequest(req, res, req.body)
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to handle POST: ${errMsg}`);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    }
  });

  // GET /mcp — client opens SSE stream for server-initiated messages
  app.get('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;

    if (!transport) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }

    try {
      await runWithIdentity(parseIdentityHeaders(req.headers), () =>
        transport.handleRequest(req, res)
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to handle GET SSE: ${errMsg}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to establish SSE stream' });
      }
    }
  });

  // DELETE /mcp — client terminates session
  app.delete('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    const transport = sessionId ? transports[sessionId] : undefined;

    if (!transport) {
      res.status(400).json({ error: 'Invalid or missing session ID' });
      return;
    }

    try {
      await runWithIdentity(parseIdentityHeaders(req.headers), () =>
        transport.handleRequest(req, res)
      );
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to handle DELETE: ${errMsg}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to terminate session' });
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
    logger.info(`Streamable HTTP server listening on port ${port}`);
    logger.info(`MCP endpoint: http://localhost:${port}/mcp`);
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
