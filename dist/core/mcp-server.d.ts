/**
 * Modern MCP Server Implementation
 * Handles JSON-RPC communication, tool management, and prompt handling
 */
import { EventEmitter } from 'events';
import type { MCPCapabilities, ToolDefinition, PromptDefinition, ToolHandler, PromptHandler } from '../types/mcp.types.js';
import type { Logger } from 'pino';
interface MCPServerOptions {
    name?: string;
    version?: string;
    description?: string;
    protocolVersion?: string;
    capabilities?: MCPCapabilities;
    logger?: Logger;
}
export declare class MCPServer extends EventEmitter {
    private readonly tools;
    private readonly prompts;
    private readonly serverInfo;
    private readonly protocolVersion;
    private readonly capabilities;
    private readonly logger;
    private rl?;
    private isInitialized;
    constructor(options?: MCPServerOptions);
    /**
     * Register a tool with the server
     */
    registerTool(definition: ToolDefinition, handler: ToolHandler): void;
    /**
     * Register a prompt with the server
     */
    registerPrompt(definition: PromptDefinition, handler: PromptHandler): void;
    /**
     * Handle incoming JSON-RPC request
     */
    private handleRequest;
    /**
     * Handle notifications (no response)
     */
    private handleNotification;
    /**
     * Handle initialize request
     */
    private handleInitialize;
    /**
     * Handle tools/list request
     */
    private handleToolsList;
    /**
     * Handle tools/call request
     */
    private handleToolCall;
    /**
     * Handle prompts/list request
     */
    private handlePromptsList;
    /**
     * Handle prompts/get request
     */
    private handlePromptGet;
    /**
     * Send a notification
     */
    private sendNotification;
    /**
     * Send response or notification
     */
    private send;
    /**
     * Start the server and listen for stdin
     */
    start(): Promise<void>;
    /**
     * Stop the server
     */
    stop(): void;
}
export {};
//# sourceMappingURL=mcp-server.d.ts.map