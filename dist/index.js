#!/usr/bin/env node
import 'dotenv/config';
import { createServer, startServer } from './server.js';
import { createLogger } from './utils/logger.js';
const logger = createLogger('main');
export async function main() {
    try {
        logger.info('Creating MCP server...');
        const server = createServer();
        logger.info('Starting server...');
        await startServer(server);
        logger.info('MCP server running');
    }
    catch (error) {
        logger.error({ error }, 'Failed to start server');
        process.exit(1);
    }
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
    main().catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}
//# sourceMappingURL=index.js.map