#!/usr/bin/env node
import './config/env.js';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.js';
import { DEFAULT_FACET, FACET_NAMES, type FacetKey } from './tools/facets.js';
import { createLogger } from './utils/logger.js';
import {
  requestContextFromHeaders,
  runWithContext,
} from './request-context.js';

const logger = createLogger('http-server');

type TransportRegistry = Record<string, StreamableHTTPServerTransport>;

/** Every path this app serves MCP on, and the facet each one exposes. */
const FACET_ROUTES: ReadonlyArray<{ path: string; facet: FacetKey }> = [
  { path: '/mcp', facet: DEFAULT_FACET },
  ...FACET_NAMES.map((facet) => ({ path: `/mcp/${facet}`, facet })),
];

/**
 * Build the Express app and the per-session transport registries.
 *
 * MCP is served on `/mcp` (every tool) and on `/mcp/<facet>` (a fixed subset —
 * ADR-001 D3). Each facet keeps its own session registry, so a session always
 * talks to the server instance whose tool list it was initialized against. The
 * platform proxy forwards `/pro/*` with the prefix stripped, so these paths
 * need no proxy change.
 *
 * Every request's proxy-verified identity (`x-mcp-auth-*` headers) is bound to
 * the async context for the duration of the SDK message handling, so tool
 * handlers running on a shared server/client instance resolve the correct
 * per-request identity. The identity wrapping is intentionally localized here
 * so a future transport change can move it in one place.
 */
export function createApp(): {
  app: express.Express;
  /** The default `/mcp` session registry. */
  transports: TransportRegistry;
  transportsByFacet: Record<FacetKey, TransportRegistry>;
} {
  const app = express();

  // Middleware
  app.use(express.json());

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  const transportsByFacet = Object.fromEntries(
    FACET_ROUTES.map((route) => [route.facet, {} as TransportRegistry] as const)
  ) as Record<FacetKey, TransportRegistry>;

  for (const { path, facet } of FACET_ROUTES) {
    const transports = transportsByFacet[facet];

    // POST — client sends JSON-RPC messages
    app.post(path, async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const requestContext = requestContextFromHeaders(req.headers);

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
              logger.info(`Session initialized on ${path}: ${id}`);
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

          const server = createServer({ facet });
          await server.connect(transport);
          await runWithContext(requestContext, () =>
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

        await runWithContext(requestContext, () =>
          transport.handleRequest(req, res, req.body)
        );
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to handle POST ${path}: ${errMsg}`);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
    });

    // GET — client opens SSE stream for server-initiated messages
    app.get(path, async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId ? transports[sessionId] : undefined;

      if (!transport) {
        res.status(400).json({ error: 'Invalid or missing session ID' });
        return;
      }

      try {
        await runWithContext(requestContextFromHeaders(req.headers), () =>
          transport.handleRequest(req, res)
        );
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to handle GET SSE ${path}: ${errMsg}`);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to establish SSE stream' });
        }
      }
    });

    // DELETE — client terminates session
    app.delete(path, async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = sessionId ? transports[sessionId] : undefined;

      if (!transport) {
        res.status(400).json({ error: 'Invalid or missing session ID' });
        return;
      }

      try {
        await runWithContext(requestContextFromHeaders(req.headers), () =>
          transport.handleRequest(req, res)
        );
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to handle DELETE ${path}: ${errMsg}`);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to terminate session' });
        }
      }
    });
  }

  // Any other /mcp/<something> — registered after the known facets, so it only
  // ever sees a facet name this build does not serve.
  app.all('/mcp/:facet', (req, res) => {
    res.status(404).json({
      jsonrpc: '2.0',
      error: {
        code: -32601,
        message: `Unknown facet: ${req.params.facet}. Available facets: ${FACET_NAMES.join(', ')}. Use /mcp for every tool.`,
      },
      id: null,
    });
  });

  return {
    app,
    transports: transportsByFacet[DEFAULT_FACET],
    transportsByFacet,
  };
}

async function startHTTPServer(): Promise<void> {
  const port = parseInt(process.env.PORT || '3000', 10);
  const { app } = createApp();

  // Start Express server
  app.listen(port, () => {
    logger.info(`Streamable HTTP server listening on port ${port}`);
    for (const { path } of FACET_ROUTES) {
      logger.info(`MCP endpoint: http://localhost:${port}${path}`);
    }
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

export { startHTTPServer, FACET_ROUTES };
