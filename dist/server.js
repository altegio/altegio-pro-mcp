import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools/registry.js';
import { AltegioClient } from './providers/altegio-client.js';
import { loadConfig } from './config/schema.js';
export function createServer() {
    // Load and validate configuration
    const config = loadConfig();
    const server = new Server({
        name: config.server.name,
        version: config.server.version,
    }, {
        capabilities: config.server.capabilities,
    });
    server.name = config.server.name;
    server.version = config.server.version;
    // Create Altegio client with validated config
    const altegioClient = new AltegioClient({
        apiBase: config.altegio.apiBase,
        partnerToken: config.altegio.partnerToken,
        userToken: config.altegio.userToken,
    });
    // Register tools with client
    registerTools(server, altegioClient);
    return server;
}
export async function startServer(server) {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
//# sourceMappingURL=server.js.map