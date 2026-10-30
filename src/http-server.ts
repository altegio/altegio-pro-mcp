#!/usr/bin/env node
import './config/env.js';
import { parseProxyKeys, verifyProxyRequest } from './utils/proxy-auth.js';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ClientRequestSchema,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.js';
import { loadConfig } from './config/schema.js';
import {
  COMPACT_VIEW,
  DEFAULT_FACET,
  FACET_NAMES,
  FULL_VIEW,
  READONLY_VIEW,
  type FacetKey,
} from './tools/facets.js';
import {
  createLogger,
  flushLogs,
  logSafeToken,
  sessionLogId,
} from './utils/logger.js';
import {
  requestContextFromHeaders,
  runWithContext,
  type RequestContext,
} from './request-context.js';
import { COMMIT_SHA, PACKAGE_VERSION } from './package-metadata.js';
import {
  HttpSessionBudget,
  type HttpSessionLease,
} from './utils/http-sessions.js';
import { oauthDoor } from './auth/oauth-door.js';
import { oauthOriginFromApiBase } from './auth/oauth-access.js';

const logger = createLogger('http-server');

type TransportRegistry = Record<string, StreamableHTTPServerTransport>;

/** Every request method the protocol defines for a client to send. */
const MCP_CLIENT_METHODS: ReadonlySet<string> = new Set(
  ClientRequestSchema.options.map((schema) => schema.shape.method.value)
);

/**
 * Methods that mean a session is in real use. A session that only initialized
 * and listed tools keeps the short idle expiry (`./utils/http-sessions.ts`).
 */
const WORK_METHODS: ReadonlySet<string> = new Set([
  'tools/call',
  'resources/read',
  'prompts/get',
]);

/** A JSON-RPC method name as the request log may record it. */
const LOGGABLE_METHOD = /^[A-Za-z0-9_/.-]{1,64}$/;

/** The JSON-RPC messages of a POST body, single or batched. */
function rpcMessages(body: unknown): Array<Record<string, unknown>> {
  const messages = Array.isArray(body) ? body : [body];
  return messages.filter(
    (message): message is Record<string, unknown> =>
      !!message && typeof message === 'object' && !Array.isArray(message)
  );
}

/**
 * Every path this app serves MCP on, and the view each one exposes.
 *
 * `/mcp/full`, `/mcp/readonly` and `/mcp/compact` are listed here, next to the
 * facets, for one reason: these routes are all registered before the
 * catch-all below, and a path that is not in this list falls into it and
 * answers 404. They are still different kinds of view — a listing size, a
 * policy, a listing size with a dispatcher — which is why none is a member of
 * `FACET_NAMES`.
 */
const FACET_ROUTES: ReadonlyArray<{ path: string; facet: FacetKey }> = [
  { path: '/mcp', facet: DEFAULT_FACET },
  { path: `/mcp/${FULL_VIEW}`, facet: FULL_VIEW },
  { path: `/mcp/${READONLY_VIEW}`, facet: READONLY_VIEW },
  { path: `/mcp/${COMPACT_VIEW}`, facet: COMPACT_VIEW },
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
 * Answer a sessionless JSON-RPC request for a method the protocol does not
 * define (`server/discover`, say) without building a server for it: -32601,
 * as JSON-RPC specifies, instead of a transport-level 400. Returns false when
 * the body is something the MCP server itself has to handle.
 */
function answerUnknownMethod(res: express.Response, body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const { method, id } = body as Record<string, unknown>;
  if (typeof method !== 'string' || MCP_CLIENT_METHODS.has(method)) {
    return false;
  }
  if (method.startsWith('notifications/')) return false;
  if (typeof id !== 'string' && typeof id !== 'number') {
    // A notification for a method nobody serves: nothing to answer.
    res.status(202).end();
    return true;
  }
  res.status(200).json({
    jsonrpc: '2.0',
    error: { code: -32601, message: 'Method not found' },
    id,
  });
  return true;
}

/** The 503 every view returns when every slot is serving a request. */
function refuseAtCapacity(
  res: express.Response,
  requestId: string | number | null
): void {
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
}

/**
 * Refuse a request this view has no session for, as the Streamable HTTP
 * transport specifies. A session ID the view does not hold — lost when the
 * process restarted, terminated by DELETE, or issued by another view — is 404,
 * which tells the client to start a new session with `initialize`. A missing
 * session ID on GET or DELETE is 400 (a sessionless POST is served statelessly
 * instead). Answering 400 for an unknown session left clients retrying a dead
 * session until their own timeout.
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
  options: {
    maxSessions?: number;
    idleTimeoutMs?: number;
    unusedIdleTimeoutMs?: number;
  } = {}
): {
  app: express.Express;
  /** The default `/mcp` session registry. */
  transports: TransportRegistry;
  transportsByFacet: Record<FacetKey, TransportRegistry>;
} {
  const app = express();
  const config = loadConfig();
  const env = config.env;
  const budget = new HttpSessionBudget(
    options.maxSessions ?? env.MCP_HTTP_MAX_SESSIONS,
    {
      idleTimeoutMs:
        options.idleTimeoutMs ?? env.MCP_HTTP_SESSION_IDLE_SECONDS * 1000,
      unusedIdleTimeoutMs:
        options.unusedIdleTimeoutMs ??
        env.MCP_HTTP_UNUSED_SESSION_IDLE_SECONDS * 1000,
      onEvict: ({ used, idleSeconds, sessions }) => {
        logger.info(
          {
            event: 'session_evicted',
            reason: 'capacity',
            session_used: used,
            idle_s: idleSeconds,
            sessions,
          },
          'Evicted an idle MCP session to admit a new one'
        );
      },
    }
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

  /**
   * Serve one POST that carries no session and is not `initialize` — a host
   * that sends `tools/call` straight from a cached tool list — on a server and
   * transport built for this request alone. Same proxy-verified context,
   * scopes and view as a session; nothing outlives the response. Its lease
   * counts against the shared budget while the request runs. Without an
   * `initialize` the server knows no client capabilities, so a destructive
   * call takes the confirmation-token path rather than elicitation.
   */
  const serveStateless = async (
    facet: FacetKey,
    req: express.Request,
    res: express.Response,
    requestContext: RequestContext
  ): Promise<void> => {
    if (answerUnknownMethod(res, req.body)) return;
    res.locals.stateless = true;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const lease = budget.acquire(() => transport.close());
    if (!lease) {
      refuseAtCapacity(res, req.body?.id ?? null);
      return;
    }
    const finish = lease.beginPost();
    const server = createServer({ facet });
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      finish();
      lease.release();
      void server.close().catch(() => undefined);
    };
    res.once('finish', cleanup);
    res.once('close', cleanup);
    try {
      await server.connect(transport);
      await runWithContext(requestContext, () =>
        transport.handleRequest(req, res, req.body)
      );
    } catch (error) {
      cleanup();
      throw error;
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
    // Hono builds the SDK Web Request from rawHeaders. Replace the caller's
    // ID in both representations before the SDK copies request headers.
    for (let i = req.rawHeaders.length - 2; i >= 0; i -= 2) {
      if (req.rawHeaders[i]?.toLowerCase() === 'x-request-id') {
        req.rawHeaders.splice(i, 2);
      }
    }
    req.rawHeaders.push('X-Request-Id', requestId);
    res.setHeader('X-Request-Id', requestId);
    const started = performance.now();
    let logged = false;
    const record = () => {
      if (logged) return;
      logged = true;
      const method: unknown = req.body?.method;
      const clientInfo: unknown = req.body?.params?.clientInfo;
      const session =
        req.headers['mcp-session-id'] ?? res.getHeader('mcp-session-id');
      logger.info(
        {
          event: 'request',
          request_id: requestId,
          route: req.path,
          rpc_method:
            typeof method === 'string'
              ? LOGGABLE_METHOD.test(method)
                ? method
                : 'invalid'
              : undefined,
          ...(typeof session === 'string'
            ? { session: sessionLogId(session) }
            : {}),
          ...(res.locals.stateless ? { transport: 'stateless' } : {}),
          // Who opens sessions: the product token a client names itself by.
          ...(method === 'initialize' &&
          clientInfo &&
          typeof clientInfo === 'object'
            ? {
                client_name: logSafeToken(
                  (clientInfo as Record<string, unknown>).name
                ),
                client_version: logSafeToken(
                  (clientInfo as Record<string, unknown>).version
                ),
              }
            : {}),
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
  // An Altegio OAuth access token is resolved — or challenged — before the
  // transport sees the request (`./auth/oauth-door.ts`).
  app.use(
    oauthDoor({
      apiBase: config.altegio.apiBase,
      partnerToken: config.altegio.partnerToken,
      publicBaseUrl: env.MCP_PUBLIC_BASE_URL,
    })
  );
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
          const lease = leases.get(transport);
          if (
            lease &&
            rpcMessages(req.body).some(
              (message) =>
                typeof message.method === 'string' &&
                WORK_METHODS.has(message.method)
            )
          ) {
            lease.markUsed();
          }
          trackPost(transport, res);
        } else if (!sessionId && isInitializeRequest(req.body)) {
          // New initialization request — create transport + server
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports[id] = transport;
              logger.info(
                {
                  event: 'session_opened',
                  route: path,
                  session: sessionLogId(id),
                  sessions: budget.size,
                },
                `Session initialized on ${path}`
              );
            },
          });

          // Reserve before the first await: concurrent initializes and views
          // share one process-wide capacity rather than each growing forever.
          // A full budget evicts its least recently used idle session first.
          const lease = budget.acquire(() => transport.close());
          if (!lease) {
            refuseAtCapacity(res, requestId);
            return;
          }
          leases.set(transport, lease);
          trackPost(transport, res);

          transport.onclose = () => {
            lease.release();
            const sid = transport.sessionId;
            if (sid && transports[sid]) {
              delete transports[sid];
              logger.info(
                {
                  event: 'session_closed',
                  route: path,
                  session: sessionLogId(sid),
                  session_used: lease.used,
                  sessions: budget.size,
                },
                'Transport closed'
              );
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
        } else if (sessionId) {
          // An ID this view does not hold (restart, expiry, eviction): 404
          // tells the client to initialize again.
          rejectSessionlessRequest(res, sessionId);
          return;
        } else {
          await serveStateless(facet, req, res, requestContext);
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
    logger.info(
      `Altegio OAuth access tokens (ag_at_) are accepted on the HTTP views and verified against ${oauthOriginFromApiBase(config.altegio.apiBase)}/oauth/accessible-resources; a refused token is answered 401 with resource_metadata`
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
  startHTTPServer().catch(async (error) => {
    logger.error(
      { error_type: error instanceof Error ? error.name : 'unknown' },
      'Failed to start HTTP server'
    );
    await flushLogs();
    process.exit(1);
  });
}

export { startHTTPServer, FACET_ROUTES };
