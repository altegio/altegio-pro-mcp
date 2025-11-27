/**
 * MCP (Model Context Protocol) Type Definitions
 * Based on the official MCP specification
 * @see https://modelcontextprotocol.io/specification
 */
export interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: string | number | null;
    method: string;
    params?: unknown;
}
export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: string | number | null;
    result?: unknown;
    error?: JsonRpcError;
}
export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}
export interface MCPCapabilities {
    tools?: {
        listChanged?: boolean;
    };
    prompts?: {
        listChanged?: boolean;
    };
    resources?: {
        listChanged?: boolean;
    };
}
export interface MCPServerInfo {
    name: string;
    version: string;
    description?: string;
}
export interface InitializeRequest extends JsonRpcRequest {
    method: 'initialize';
    params: {
        protocolVersion: string;
        capabilities?: MCPCapabilities;
        clientInfo?: {
            name: string;
            version: string;
        };
    };
}
export interface InitializeResponse extends JsonRpcResponse {
    result: {
        protocolVersion: string;
        capabilities: MCPCapabilities;
        serverInfo: MCPServerInfo;
    };
}
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties?: Record<string, unknown>;
        required?: string[];
    };
}
export interface ToolsListRequest extends JsonRpcRequest {
    method: 'tools/list';
    params?: {
        cursor?: string;
    };
}
export interface ToolsListResponse extends JsonRpcResponse {
    result: {
        tools: ToolDefinition[];
        nextCursor?: string;
    };
}
export interface ToolCallRequest extends JsonRpcRequest {
    method: 'tools/call';
    params: {
        name: string;
        arguments?: Record<string, unknown>;
    };
}
export interface ToolCallResponse extends JsonRpcResponse {
    result: {
        content: ContentItem[];
    };
}
export interface PromptDefinition {
    name: string;
    title?: string;
    description: string;
    arguments?: PromptArgument[];
}
export interface PromptArgument {
    name: string;
    description: string;
    required: boolean;
}
export interface PromptsListRequest extends JsonRpcRequest {
    method: 'prompts/list';
    params?: {
        cursor?: string;
    };
}
export interface PromptsListResponse extends JsonRpcResponse {
    result: {
        prompts: PromptDefinition[];
        nextCursor?: string;
    };
}
export interface PromptGetRequest extends JsonRpcRequest {
    method: 'prompts/get';
    params: {
        name: string;
        arguments?: Record<string, unknown>;
    };
}
export interface PromptGetResponse extends JsonRpcResponse {
    result: {
        description?: string;
        messages: Message[];
    };
}
export type ContentItem = TextContent | ImageContent | AudioContent | ResourceContent;
export interface TextContent {
    type: 'text';
    text: string;
}
export interface ImageContent {
    type: 'image';
    data: string;
    mimeType: string;
}
export interface AudioContent {
    type: 'audio';
    data: string;
    mimeType: string;
}
export interface ResourceContent {
    type: 'resource';
    resource: Resource;
}
export interface Resource {
    uri: string;
    name: string;
    title?: string;
    mimeType?: string;
    text?: string;
}
export interface Message {
    role: 'user' | 'assistant' | 'system';
    content: ContentItem;
}
export type PromptMessage = Message;
export interface MCPNotification {
    jsonrpc: '2.0';
    method: string;
    params?: unknown;
}
export declare enum MCPErrorCode {
    ParseError = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams = -32602,
    InternalError = -32603,
    ToolExecutionError = -32000,
    PromptExecutionError = -32001,
    ResourceAccessError = -32002
}
export type RequestHandler<T extends JsonRpcRequest = JsonRpcRequest> = (request: T) => Promise<JsonRpcResponse> | JsonRpcResponse;
export type NotificationHandler<T extends MCPNotification = MCPNotification> = (notification: T) => Promise<void> | void;
export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown> | unknown;
export type PromptHandler = (args: Record<string, unknown>) => Promise<Message[]> | Message[];
//# sourceMappingURL=mcp.types.d.ts.map