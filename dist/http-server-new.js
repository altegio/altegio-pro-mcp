#!/usr/bin/env node
/**
 * HTTP Server for MCP using Official SDK
 * Supports both Streamable HTTP and Legacy HTTP+SSE protocols
 */
import 'dotenv/config';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AltegioClient } from './providers/altegio-client.js';
import { loadConfig } from './config/schema.js';
import { createLogger } from './utils/logger.js';
import { randomUUID } from 'crypto';
const logger = createLogger('http-server');
const app = express();
const port = process.env.PORT || 8080;
// Session management
const transports = new Map();
// Initialize Altegio client
const config = loadConfig();
const altegioClient = new AltegioClient(config.altegio);
// Create MCP Server factory
function createMCPServer() {
    const server = new Server({
        name: config.server.name,
        version: config.server.version,
    }, {
        capabilities: config.server.capabilities,
    });
    // Register tools list handler
    server.setRequestHandler('tools/list', async () => {
        return {
            tools: [
                {
                    name: 'altegio_login',
                    description: 'Login to Altegio with email and password to get user token. Use this first if not authenticated.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            email: {
                                type: 'string',
                                description: 'Altegio account email',
                            },
                            password: {
                                type: 'string',
                                description: 'Altegio account password',
                            },
                        },
                        required: ['email', 'password'],
                    },
                },
                {
                    name: 'altegio_logout',
                    description: 'Logout from Altegio and clear saved credentials',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                    },
                },
                {
                    name: 'list_companies',
                    description: 'Get list of companies available to the authenticated user. Use this first to get company IDs.',
                    inputSchema: {
                        type: 'object',
                        properties: {},
                    },
                },
                {
                    name: 'get_company',
                    description: 'Get detailed information about a specific company',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            company_id: {
                                type: 'number',
                                description: 'Company ID',
                            },
                        },
                        required: ['company_id'],
                    },
                },
                {
                    name: 'list_bookings',
                    description: 'List bookings/records for a company. Returns appointments with client, service, staff details.',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            company_id: {
                                type: 'number',
                                description: 'Company ID',
                            },
                            start_date: {
                                type: 'string',
                                description: 'Start date (YYYY-MM-DD)',
                            },
                            end_date: {
                                type: 'string',
                                description: 'End date (YYYY-MM-DD)',
                            },
                        },
                        required: ['company_id', 'start_date', 'end_date'],
                    },
                },
                {
                    name: 'get_booking',
                    description: 'Get detailed information about a specific booking',
                    inputSchema: {
                        type: 'object',
                        properties: {
                            company_id: {
                                type: 'number',
                                description: 'Company ID',
                            },
                            booking_id: {
                                type: 'number',
                                description: 'Booking ID',
                            },
                        },
                        required: ['company_id', 'booking_id'],
                    },
                },
            ],
        };
    });
    // Register tool call handler
    server.setRequestHandler('tools/call', async (request) => {
        const { name, arguments: args } = request.params;
        try {
            switch (name) {
                case 'altegio_login': {
                    const { email, password } = args;
                    const response = await altegioClient.login(email, password);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(response, null, 2),
                            },
                        ],
                    };
                }
                case 'altegio_logout': {
                    altegioClient.logout();
                    return {
                        content: [
                            {
                                type: 'text',
                                text: 'Successfully logged out',
                            },
                        ],
                    };
                }
                case 'list_companies': {
                    const companies = await altegioClient.getCompanies();
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(companies, null, 2),
                            },
                        ],
                    };
                }
                case 'get_company': {
                    const { company_id } = args;
                    const company = await altegioClient.getCompany(company_id);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(company, null, 2),
                            },
                        ],
                    };
                }
                case 'list_bookings': {
                    const { company_id, start_date, end_date } = args;
                    const bookings = await altegioClient.getBookings(company_id, start_date, end_date);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(bookings, null, 2),
                            },
                        ],
                    };
                }
                case 'get_booking': {
                    const { company_id, booking_id } = args;
                    const booking = await altegioClient.getBooking(company_id, booking_id);
                    return {
                        content: [
                            {
                                type: 'text',
                                text: JSON.stringify(booking, null, 2),
                            },
                        ],
                    };
                }
                default:
                    throw new Error(`Unknown tool: ${name}`);
            }
        }
        catch (error) {
            return {
                content: [
                    {
                        type: 'text',
                        text: `Error: ${error.message}`,
                        isError: true,
                    },
                ],
            };
        }
    });
    return server;
}
// Middleware
app.use(express.json());
// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Mcp-Protocol-Version');
    res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
    if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
    }
    next();
});
// Health check
app.get('/health', (_req, res) => {
    res.json({
        status: 'healthy',
        service: 'altegio-mcp',
        protocol: '2025-06-18',
    });
});
// POST /mcp - Streamable HTTP main endpoint
app.post('/mcp', async (req, res) => {
    try {
        let sessionId = req.headers['mcp-session-id'];
        let transport = sessionId ? transports.get(sessionId) : undefined;
        // Create new session if needed
        if (!transport) {
            sessionId = randomUUID();
            const server = createMCPServer();
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => sessionId,
            });
            // Store transport
            transports.set(sessionId, transport);
            // Connect server to transport
            await server.connect(transport);
            // Cleanup on close
            server.onclose = () => {
                transports.delete(sessionId);
                logger.info({ sessionId }, 'Session closed');
            };
            logger.info({ sessionId }, 'New session created');
        }
        // Handle request
        await transport.handleRequest(req, res);
    }
    catch (error) {
        logger.error({ error }, 'Error handling POST /mcp');
        res.status(500).json({ error: 'Internal server error' });
    }
});
// GET /mcp - SSE endpoint (for both Legacy and Streamable HTTP)
app.get('/mcp', async (req, res) => {
    try {
        let sessionId = req.headers['mcp-session-id'];
        let transport = sessionId ? transports.get(sessionId) : undefined;
        // If no transport, create new session (Legacy HTTP+SSE mode)
        if (!transport) {
            sessionId = randomUUID();
            const server = createMCPServer();
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => sessionId,
            });
            // Store transport
            transports.set(sessionId, transport);
            // Connect server to transport
            await server.connect(transport);
            // Cleanup on close
            server.onclose = () => {
                transports.delete(sessionId);
                logger.info({ sessionId }, 'Session closed');
            };
            logger.info({ sessionId }, 'New SSE session created (Legacy mode)');
        }
        // Handle SSE stream
        await transport.handleRequest(req, res);
    }
    catch (error) {
        logger.error({ error }, 'Error handling GET /mcp');
        res.status(500).json({ error: 'Internal server error' });
    }
});
// DELETE /mcp - End session
app.delete('/mcp', (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && transports.has(sessionId)) {
        transports.delete(sessionId);
        logger.info({ sessionId }, 'Session deleted');
        res.sendStatus(204);
    }
    else {
        res.status(404).json({ error: 'Session not found' });
    }
});
// Start server
app.listen(port, () => {
    logger.info({ port }, 'HTTP MCP server started');
    logger.info('Endpoints:');
    logger.info('  POST /mcp - Streamable HTTP endpoint');
    logger.info('  GET /mcp - SSE endpoint (Legacy & Streamable)');
    logger.info('  DELETE /mcp - End session');
    logger.info('  GET /health - Health check');
});
// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received, closing server');
    transports.clear();
    process.exit(0);
});
