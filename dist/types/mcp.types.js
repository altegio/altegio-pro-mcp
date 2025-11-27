/**
 * MCP (Model Context Protocol) Type Definitions
 * Based on the official MCP specification
 * @see https://modelcontextprotocol.io/specification
 */
// Error Codes
export var MCPErrorCode;
(function (MCPErrorCode) {
    MCPErrorCode[MCPErrorCode["ParseError"] = -32700] = "ParseError";
    MCPErrorCode[MCPErrorCode["InvalidRequest"] = -32600] = "InvalidRequest";
    MCPErrorCode[MCPErrorCode["MethodNotFound"] = -32601] = "MethodNotFound";
    MCPErrorCode[MCPErrorCode["InvalidParams"] = -32602] = "InvalidParams";
    MCPErrorCode[MCPErrorCode["InternalError"] = -32603] = "InternalError";
    // MCP specific
    MCPErrorCode[MCPErrorCode["ToolExecutionError"] = -32000] = "ToolExecutionError";
    MCPErrorCode[MCPErrorCode["PromptExecutionError"] = -32001] = "PromptExecutionError";
    MCPErrorCode[MCPErrorCode["ResourceAccessError"] = -32002] = "ResourceAccessError";
})(MCPErrorCode || (MCPErrorCode = {}));
//# sourceMappingURL=mcp.types.js.map