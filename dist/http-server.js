#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createServer } from './server.js';
import { createLogger } from './utils/logger.js';
const logger = createLogger('http-server');
async function startHTTPServer() {
    const app = express();
    const port = parseInt(process.env.PORT || '3000', 10);
    // Middleware
    app.use(express.json());
    // Health check endpoint
    app.get('/health', (_req, res) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });
    // Store transports by session ID
    const transports = {};
    // SSE endpoint - GET to establish connection
    app.get('/mcp', async (_req, res) => {
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
            await server.connect(transport);
            logger.info(`SSE connection established: ${sessionId}`);
        }
        catch (error) {
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
            const sessionId = req.query.sessionId;
            const transport = transports[sessionId];
            if (!transport) {
                logger.warn(`Session not found: ${sessionId}`);
                res.status(404).json({ error: 'Session not found' });
                return;
            }
            await transport.handlePostMessage(req, res, req.body);
        }
        catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to handle POST message: ${errMsg}`);
            if (!res.headersSent) {
                res.status(500).json({ error: 'Failed to handle message' });
            }
        }
    });
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
// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    startHTTPServer().catch((error) => {
        logger.error('Failed to start HTTP server', error);
        process.exit(1);
    });
}
export { startHTTPServer };
//# sourceMappingURL=http-server.js.map