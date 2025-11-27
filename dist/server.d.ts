import { Server } from '@modelcontextprotocol/sdk/server/index.js';
export interface MCPServer extends Server {
    name: string;
    version: string;
}
export declare function createServer(): MCPServer;
export declare function startServer(server: Server): Promise<void>;
//# sourceMappingURL=server.d.ts.map