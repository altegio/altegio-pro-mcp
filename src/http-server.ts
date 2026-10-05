#!/usr/bin/env node
import './config/env.js';
import { parseProxyKeys, verifyProxyRequest } from './utils/proxy-auth.js';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.js';
import { loadConfig } from './config/schema.js';
import {
  DEFAULT_FACET,
  FACET_NAMES,
  READONLY_VIEW,
  type FacetKey,
} from './tools/facets.js';
import { createLogger, flushLogs } from './utils/logger.js';
import {
  requestContextFromHeaders,
  runWithContext,
} from './request-context.js';
import { COMMIT_SHA, PACKAGE_VERSION } from './package-metadata.js';
import {
  HttpSessionBudget,
  type HttpSessionLease,
} from './utils/http-sessions.js';

const logger = createLogger('http-server');

type TransportRegistry = Record<string, StreamableHTTPServerTransport>;

/**
 * Every path this app serves MCP on, and the view each one exposes.
 *
 * `/mcp/readonly` is listed here, next to the facets, for one reason: these
 * routes are all registered before the catch-all below, and a path that is not
 * in this list falls into it and answers 404. It is still a different kind of
 * view — a policy, not a context budget — which is why it is not a member of
 * `FACET_NAMES`.
 */
const FACET_ROUTES: ReadonlyArray<{ path: string; facet: FacetKey }> = [
  { path: '/mcp', facet: DEFAULT_FACET },
  { path: `/mcp/${READONLY_VIEW}`, facet: READONLY_VIEW },
  ...FACET_NAMES.map((facet) => ({ path: `/mcp/${facet}`, facet })),
];

/** Sub-paths under `/mcp`, for the 404 that lists what this build serves. */
const MCP_SUB_PATHS = FACET_ROUTES.map((route) => route.path).filter(
  (path) => path !== '/mcp'
);

/** The session this view holds for `sessionId`, if any. */
function sessionTransport(
  transports: TransportRegistry,
  sessionId: string | undefined
): StreamableHTTPServerTransport | undefined {
  // Own keys only: a header such as `constructor` is not a session.
  return sessionId && Object.hasOwn(transports, sessionId)
    ? transports[sessionId]
    : undefined;
}

/**
 * Refuse a request this view has no session for, as the Streamable HTTP
 * transport specifies. A session ID the view does not hold — lost when the
 * process restarted, terminated by DELETE, or issued by another view — is 404,
 * which tells the client to start a new session with `initialize`. A missing
 * session ID on anything but `initialize` is 400. Answering 400 for an unknown
 * session left clients retrying a dead session until their own timeout.
 */
function rejectSessionlessRequest(
  res: express.Response,
  sessionId: string | undefined
): void {
  if (sessionId) {
    res.status(404).json({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: null,
    });
    return;
  }
  res.status(400).json({
    jsonrpc: '2.0',
    error: { code: -32000, message: 'Bad Request: Missing session ID' },
    id: null,
  });
}

/**
 * Build the Express app and the per-session transport registries.
 *
 * MCP is served on `/mcp` (every tool), on `/mcp/<facet>` (a fixed subset —
 * ADR-001 D3) and on `/mcp/readonly` (only tools annotated `readOnlyHint`).
 * Each view keeps its own session registry, so a session always talks to the
 * server instance whose tool list it was initialized against. The platform
 * proxy forwards `/pro/*` with the prefix stripped, so these paths need no
 * proxy change.
 *
 * Every request's proxy-verified identity (`x-mcp-auth-*` headers) is bound to
 * the async context for the duration of the SDK message handling, so tool
 * handlers running on a shared server/client instance resolve the correct
 * per-request identity. The identity wrapping is intentionally localized here
 * so a future transport change can move it in one place.
 */
export function createApp(
  options: { maxSessions?: number; idleTimeoutMs?: number } = {}
): {
  app: express.Express;
  /** The default `/mcp` session registry. */
  transports: TransportRegistry;
  transportsByFacet: Record<FacetKey, TransportRegistry>;
} {
  const app = express();
  const budget = new HttpSessionBudget(
    options.maxSessions ?? loadConfig().env.MCP_HTTP_MAX_SESSIONS,
    options.idleTimeoutMs
  );
  const leases = new WeakMap<StreamableHTTPServerTransport, HttpSessionLease>();
  const trackPost = (
    transport: StreamableHTTPServerTransport,
    res: express.Response
  ) => {
    const finish = leases.get(transport)?.beginPost();
    if (finish) {
      res.once('finish', finish);
      res.once('close', finish);
    }
  };

  // Middleware
  // Base64 of a file smaller than 12 MiB is below 16 MiB; leave room for
  // JSON-RPC metadata while bounding every hosted MCP request.
  const proxyKeys = parseProxyKeys(process.env.MCP_PROXY_BACKEND_KEY);
  if (
    (process.env.MCP_PROXY_BACKEND_KEY ||
      process.env.MCP_PROXY_REQUIRE_SIGNATURE === 'true') &&
    proxyKeys.length === 0
  ) {
    throw new Error('MCP_PROXY_BACKEND_KEY contains no usable signing key');
  }
  if (proxyKeys.length === 0) {
    logger.warn(
      { event: 'proxy_trust_unconfigured' },
      'Proxy signatures are not enforced; configure the existing backend key before enabling delegated clients'
    );
  }
  app.use((req, res, next) => {
    if (!req.path.startsWith('/mcp')) return next();
    const localRequestId = randomUUID();
    const delegated = Object.keys(req.headers).some((name) =>
      name.startsWith('x-mcp-auth-')
    );
    const signed = req.headers['x-mcp-proxy-auth'] !== undefined;
    if (proxyKeys.length > 0 && (delegated || signed)) {
      const verification = verifyProxyRequest({
        keys: proxyKeys,
        method: req.method,
        path: req.originalUrl,
        headers: req.headers,
      });
      if (!verification.ok) {
        logger.warn(
          {
            event: 'proxy_auth_rejected',
            request_id: localRequestId,
            latency_ms: 0,
            route: req.path,
            error_type: verification.reason,
            outcome: 'error',
            http_status: 401,
          },
          'Invalid delegated request'
        );
        res.status(401).json({ error: 'proxy_auth_required' });
        return;
      }
    }
    // The SDK copies these headers and later rebinds its asynchronous handler
    // context. Only a verified proxy may supply the correlation identifier.
    const forwarded = req.headers['x-mcp-auth-request-id'];
    const requestId =
      proxyKeys.length > 0 &&
      signed &&
      typeof forwarded === 'string' &&
      /^[a-zA-Z0-9_-]{1,128}$/.test(forwarded)
        ? forwarded
        : randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-Id', requestId);
    const started = performance.now();
    let logged = false;
    const record = () => {
      if (logged) return;
      logged = true;
      logger.info(
        {
          event: 'request',
          request_id: requestId,
          route: req.path,
          rpc_method:
            typeof req.body?.method === 'string'
              ? req.body.method.slice(0, 64)
              : undefined,
          http_status: res.statusCode,
          ...(res.locals.limitedBy
            ? { limited_by: res.locals.limitedBy, error_type: 'admission' }
            : {}),
          outcome: !res.writableFinished
            ? 'cancelled'
            : res.statusCode >= 400
              ? 'error'
              : 'success',
          latency_ms: Math.round(performance.now() - started),
        },
        'MCP request completed'
      );
    };
    res.once('finish', record);
    res.once('close', record);
    next();
  });
  app.use(express.json({ limit: '17mb' }));

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'altegio-pro-mcp',
      version: PACKAGE_VERSION,
      commit: COMMIT_SHA,
      timestamp: new Date().toISOString(),
    });
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
      const requestId: string | number | null = req.body?.id ?? null;

      try {
        let transport: StreamableHTTPServerTransport;
        const existing = sessionTransport(transports, sessionId);

        if (existing) {
          // Reuse existing transport
          transport = existing;
          trackPost(transport, res);
        } else if (!sessionId && isInitializeRequest(req.body)) {
          // New initialization request — create transport + server
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              logger.info(`Session initialized on ${path}`);
              transports[id] = transport;
            },
          });

          // Reserve before the first await: concurrent initializes and views
          // share one process-wide capacity rather than each growing forever.
          const lease = budget.acquire(() => transport.close());
          if (!lease) {
            res.locals.limitedBy = 'pro_session_capacity';
            res.setHeader('Retry-After', '60');
            res.status(503).json({
              jsonrpc: '2.0',
              error: {
                code: -32000,
                message: 'MCP session capacity reached; retry later',
              },
              id: requestId,
            });
            return;
          }
          leases.set(transport, lease);
          trackPost(transport, res);

          transport.onclose = () => {
            lease.release();
            const sid = transport.sessionId;
            if (sid && transports[sid]) {
              logger.info(`Transport closed`);
              delete transports[sid];
            }
          };

          try {
            const server = createServer({ facet });
            await server.connect(transport);
            await runWithContext(requestContext, () =>
              transport.handleRequest(req, res, req.body)
            );
            // SDK validation may answer 400 without throwing or assigning an ID.
            if (!transport.sessionId) {
              lease.release();
              await transport.close();
            }
          } catch (error) {
            lease.release();
            await transport.close();
            throw error;
          }
          return;
        } else {
          rejectSessionlessRequest(res, sessionId);
          return;
        }

        await runWithContext(requestContext, () =>
          transport.handleRequest(req, res, req.body)
        );
      } catch (error) {
        logger.error(
          {
            event: 'request_failed',
            route: path,
            error_type: error instanceof Error ? error.name : 'unknown',
            outcome: 'error',
          },
          'Failed to handle POST'
        );
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
      const transport = sessionTransport(transports, sessionId);

      if (!transport) {
        rejectSessionlessRequest(res, sessionId);
        return;
      }

      leases.get(transport)?.touch();
      try {
        await runWithContext(requestContextFromHeaders(req.headers), () =>
          transport.handleRequest(req, res)
        );
      } catch (error) {
        logger.error(
          {
            event: 'request_failed',
            route: path,
            error_type: error instanceof Error ? error.name : 'unknown',
            outcome: 'error',
          },
          'Failed to handle GET SSE'
        );
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to establish SSE stream' });
        }
      }
    });

    // DELETE — client terminates session
    app.delete(path, async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = sessionTransport(transports, sessionId);

      if (!transport) {
        rejectSessionlessRequest(res, sessionId);
        return;
      }

      leases.get(transport)?.touch();
      try {
        await runWithContext(requestContextFromHeaders(req.headers), () =>
          transport.handleRequest(req, res)
        );
      } catch (error) {
        logger.error(
          {
            event: 'request_failed',
            route: path,
            error_type: error instanceof Error ? error.name : 'unknown',
            outcome: 'error',
          },
          'Failed to handle DELETE'
        );
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to terminate session' });
        }
      }
    });
  }

  // Any other /mcp/<something> — registered after every known view, so it only
  // ever sees a sub-path this build does not serve.
  app.all('/mcp/:facet', (req, res) => {
    res.status(404).json({
      jsonrpc: '2.0',
      error: {
        code: -32601,
        message: `Unknown facet: ${req.params.facet}. This endpoint serves ${MCP_SUB_PATHS.join(', ')}. Use /mcp for every tool, or /mcp/${READONLY_VIEW} for read operations only.`,
      },
      id: null,
    });
  });

  // The parser rejects oversized uploads before MCP dispatch. Return a bounded,
  // useful protocol error without logging or reflecting any request bytes.
  app.use(
    (
      error: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      if (
        error &&
        typeof error === 'object' &&
        'type' in error &&
        error.type === 'entity.too.large'
      ) {
        res.status(413).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message:
              'MCP request exceeds 17 MiB. A client file must be smaller than 12 MiB before base64 encoding.',
          },
          id: null,
        });
        return;
      }
      next(error);
    }
  );

  return {
    app,
    transports: transportsByFacet[DEFAULT_FACET],
    transportsByFacet,
  };
}

async function startHTTPServer(): Promise<void> {
  const port = parseInt(process.env.PORT || '3000', 10);
  // Load once up front so a misconfigured deployment fails at boot rather than
  // on the first request, and so the posture below is read from the same
  // cached config every session will see.
  const config = loadConfig();
  const { app } = createApp();

  // Start Express server
  app.listen(port, () => {
    logger.info(`Streamable HTTP server listening on port ${port}`);
    logger.info(`HTTP session capacity: ${config.env.MCP_HTTP_MAX_SESSIONS}`);
    for (const { path } of FACET_ROUTES) {
      logger.info(`MCP endpoint: http://localhost:${port}${path}`);
    }
    // The tool surface an HTTP deployment hands out is a security posture, so
    // state it in the boot log instead of leaving it to be inferred.
    logger.info(
      config.env.ALTEGIO_EXPOSE_PASSWORD_LOGIN
        ? 'Password login (auth_login/auth_logout) is SERVED on the HTTP views — intended only for the closed staff deployment (ALTEGIO_EXPOSE_PASSWORD_LOGIN=true)'
        : 'Password login (auth_login/auth_logout) is withheld from the HTTP views; callers authenticate through the proxy'
    );
    logger.info(
      `Read-only view on /mcp/${READONLY_VIEW}: serves only tools annotated readOnlyHint, and refuses every other tool by name. Addresses named to callers are based on ${config.env.MCP_PUBLIC_BASE_URL}`
    );
  });
}

// Handle process signals
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down...');
  await flushLogs();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...');
  await flushLogs();
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
