/**
 * Modern MCP Server Implementation
 * Handles JSON-RPC communication, tool management, and prompt handling
 */
import { createInterface } from 'readline';
import { EventEmitter } from 'events';
import { MethodNotFoundError, InvalidParamsError, ToolExecutionError, PromptExecutionError, toMCPError, } from '../utils/errors.js';
import { createLogger } from '../utils/logger.js';
export class MCPServer extends EventEmitter {
    tools = new Map();
    prompts = new Map();
    serverInfo;
    protocolVersion;
    capabilities;
    logger;
    rl;
    isInitialized = false;
    constructor(options = {}) {
        super();
        this.serverInfo = {
            name: options.name || 'altegio-mcp-server',
            version: options.version || '1.0.0',
            description: options.description,
        };
        this.protocolVersion = options.protocolVersion || '2024-11-05';
        this.capabilities = options.capabilities || {
            tools: { listChanged: true },
            prompts: { listChanged: true },
        };
        this.logger = options.logger || createLogger('mcp-server');
    }
    /**
     * Register a tool with the server
     */
    registerTool(definition, handler) {
        const tool = { ...definition, handler };
        this.tools.set(definition.name, tool);
        this.logger.debug({ tool: definition.name }, 'Tool registered');
        if (this.isInitialized && this.capabilities.tools?.listChanged) {
            this.sendNotification('notifications/tools/list_changed');
        }
    }
    /**
     * Register a prompt with the server
     */
    registerPrompt(definition, handler) {
        const prompt = { ...definition, handler };
        this.prompts.set(definition.name, prompt);
        this.logger.debug({ prompt: definition.name }, 'Prompt registered');
        if (this.isInitialized && this.capabilities.prompts?.listChanged) {
            this.sendNotification('notifications/prompts/list_changed');
        }
    }
    /**
     * Handle incoming JSON-RPC request
     */
    async handleRequest(request) {
        const { method, id } = request;
        // Notifications don't have an id
        if (id === undefined || id === null) {
            await this.handleNotification(request);
            return null;
        }
        this.logger.debug({ request }, 'Handling request');
        try {
            switch (method) {
                case 'initialize':
                    return this.handleInitialize(request);
                case 'tools/list':
                    return this.handleToolsList(request);
                case 'tools/call':
                    return await this.handleToolCall(request);
                case 'prompts/list':
                    return this.handlePromptsList(request);
                case 'prompts/get':
                    return await this.handlePromptGet(request);
                default:
                    throw new MethodNotFoundError(method);
            }
        }
        catch (error) {
            const mcpError = toMCPError(error);
            this.logger.error({ error: mcpError, request }, 'Request failed');
            return {
                jsonrpc: '2.0',
                id,
                error: mcpError.toJSON(),
            };
        }
    }
    /**
     * Handle notifications (no response)
     */
    async handleNotification(notification) {
        const { method } = notification;
        this.logger.debug({ notification }, 'Handling notification');
        switch (method) {
            case 'notifications/initialized':
                this.isInitialized = true;
                this.emit('initialized');
                break;
            case 'notifications/cancelled':
                this.emit('cancelled', notification.params);
                break;
            default:
                this.logger.warn({ method }, 'Unknown notification');
        }
    }
    /**
     * Handle initialize request
     */
    handleInitialize(request) {
        const { id, params } = request;
        // Validate protocol version
        if (params.protocolVersion !== this.protocolVersion) {
            this.logger.warn({ requested: params.protocolVersion, supported: this.protocolVersion }, 'Protocol version mismatch');
        }
        this.emit('initialize', params);
        return {
            jsonrpc: '2.0',
            id: id,
            result: {
                protocolVersion: this.protocolVersion,
                capabilities: this.capabilities,
                serverInfo: this.serverInfo,
            },
        };
    }
    /**
     * Handle tools/list request
     */
    handleToolsList(request) {
        const { id } = request;
        const tools = Array.from(this.tools.values()).map(({ handler, ...tool }) => tool);
        return {
            jsonrpc: '2.0',
            id: id,
            result: { tools },
        };
    }
    /**
     * Handle tools/call request
     */
    async handleToolCall(request) {
        const { id, params } = request;
        const { name, arguments: args = {} } = params;
        const tool = this.tools.get(name);
        if (!tool) {
            throw new InvalidParamsError(`Tool not found: ${name}`);
        }
        try {
            const result = await tool.handler(args);
            // Wrap result in content array
            const content = [
                {
                    type: 'text',
                    text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
                },
            ];
            return {
                jsonrpc: '2.0',
                id: id,
                result: { content },
            };
        }
        catch (error) {
            throw new ToolExecutionError(name, error);
        }
    }
    /**
     * Handle prompts/list request
     */
    handlePromptsList(request) {
        const { id } = request;
        const prompts = Array.from(this.prompts.values()).map(({ handler, ...prompt }) => prompt);
        return {
            jsonrpc: '2.0',
            id: id,
            result: { prompts },
        };
    }
    /**
     * Handle prompts/get request
     */
    async handlePromptGet(request) {
        const { id, params } = request;
        const { name, arguments: args = {} } = params;
        const prompt = this.prompts.get(name);
        if (!prompt) {
            throw new InvalidParamsError(`Prompt not found: ${name}`);
        }
        try {
            const messages = await prompt.handler(args);
            return {
                jsonrpc: '2.0',
                id: id,
                result: {
                    description: prompt.description,
                    messages,
                },
            };
        }
        catch (error) {
            throw new PromptExecutionError(name, error);
        }
    }
    /**
     * Send a notification
     */
    sendNotification(method, params) {
        const notification = {
            jsonrpc: '2.0',
            method,
            params,
        };
        this.send(notification);
    }
    /**
     * Send response or notification
     */
    send(message) {
        const json = JSON.stringify(message);
        console.log(json);
        this.logger.debug({ message }, 'Sent message');
    }
    /**
     * Start the server and listen for stdin
     */
    async start() {
        this.logger.info({ serverInfo: this.serverInfo }, 'Starting MCP server');
        this.rl = createInterface({
            input: process.stdin,
            output: process.stdout,
            terminal: false,
        });
        this.rl.on('line', async (line) => {
            try {
                const request = JSON.parse(line);
                const response = await this.handleRequest(request);
                if (response) {
                    this.send(response);
                }
            }
            catch (error) {
                const parseError = {
                    jsonrpc: '2.0',
                    id: null,
                    error: {
                        code: -32700,
                        message: 'Parse error',
                        data: error instanceof Error ? error.message : error,
                    },
                };
                this.send(parseError);
            }
        });
        this.rl.on('close', () => {
            this.logger.info('Server shutting down');
            this.emit('close');
        });
        // Write to stderr for debugging (not part of JSON-RPC)
        process.stderr.write(`MCP server started (${this.serverInfo.name} v${this.serverInfo.version})\n`);
    }
    /**
     * Stop the server
     */
    stop() {
        if (this.rl) {
            this.rl.close();
            this.rl = undefined;
        }
    }
}
//# sourceMappingURL=mcp-server.js.map