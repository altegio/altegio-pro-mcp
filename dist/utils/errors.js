/**
 * Custom error classes for better error handling
 */
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
/**
 * Base error class for MCP server errors
 */
export class MCPError extends Error {
    code;
    data;
    constructor(message, code = ErrorCode.InternalError, data) {
        super(message);
        this.name = 'MCPError';
        this.code = code;
        this.data = data;
        Error.captureStackTrace(this, this.constructor);
    }
    toJSON() {
        return {
            code: this.code,
            message: this.message,
            data: this.data,
        };
    }
}
/**
 * Error thrown when a method is not found
 */
export class MethodNotFoundError extends MCPError {
    constructor(method) {
        super(`Method not found: ${method}`, ErrorCode.MethodNotFound);
        this.name = 'MethodNotFoundError';
    }
}
/**
 * Error thrown when request parameters are invalid
 */
export class InvalidParamsError extends MCPError {
    constructor(message, data) {
        super(message, ErrorCode.InvalidParams, data);
        this.name = 'InvalidParamsError';
    }
}
/**
 * Error thrown when tool execution fails
 */
export class ToolExecutionError extends MCPError {
    constructor(toolName, originalError) {
        super(`Tool execution failed for '${toolName}': ${originalError.message}`, ErrorCode.InternalError, {
            tool: toolName,
            originalError: originalError.message,
        });
        this.name = 'ToolExecutionError';
    }
}
/**
 * Error thrown when prompt execution fails
 */
export class PromptExecutionError extends MCPError {
    constructor(promptName, originalError) {
        super(`Prompt execution failed for '${promptName}': ${originalError.message}`, ErrorCode.InternalError, {
            prompt: promptName,
            originalError: originalError.message,
        });
        this.name = 'PromptExecutionError';
    }
}
/**
 * Altegio API specific error
 */
export class AltegioApiError extends Error {
    code;
    statusCode;
    response;
    constructor(message, statusCode, response) {
        super(message);
        this.name = 'AltegioApiError';
        this.statusCode = statusCode;
        this.code = statusCode;
        this.response = response;
        Error.captureStackTrace(this, this.constructor);
    }
}
/**
 * Authentication error
 */
export class AuthenticationError extends AltegioApiError {
    constructor(message = 'Authentication failed') {
        super(message, 401);
        this.name = 'AuthenticationError';
    }
}
/**
 * Rate limit error
 */
export class RateLimitError extends AltegioApiError {
    retryAfter;
    constructor(message = 'Rate limit exceeded', retryAfter) {
        super(message, 429);
        this.name = 'RateLimitError';
        this.retryAfter = retryAfter;
    }
}
/**
 * Configuration error
 */
export class ConfigurationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigurationError';
        Error.captureStackTrace(this, this.constructor);
    }
}
/**
 * Validation error
 */
export class ValidationError extends Error {
    errors;
    constructor(message, errors = []) {
        super(message);
        this.name = 'ValidationError';
        this.errors = errors;
        Error.captureStackTrace(this, this.constructor);
    }
}
/**
 * Type guard to check if error is an MCPError
 */
export function isMCPError(error) {
    return error instanceof MCPError;
}
/**
 * Type guard to check if error is an AltegioApiError
 */
export function isAltegioApiError(error) {
    return error instanceof AltegioApiError;
}
/**
 * Convert any error to MCPError
 */
export function toMCPError(error) {
    if (isMCPError(error)) {
        return error;
    }
    if (error instanceof Error) {
        return new MCPError(error.message, ErrorCode.InternalError, {
            name: error.name,
            stack: error.stack,
        });
    }
    return new MCPError('An unknown error occurred', ErrorCode.InternalError, {
        error,
    });
}
/**
 * Error handler utility
 */
export class ErrorHandler {
    static RETRYABLE_ERRORS = [408, 429, 500, 502, 503, 504];
    static isRetryable(error) {
        if (isAltegioApiError(error) && error.statusCode) {
            return this.RETRYABLE_ERRORS.includes(error.statusCode);
        }
        return false;
    }
    static getRetryDelay(error, attempt) {
        if (error instanceof RateLimitError && error.retryAfter) {
            return error.retryAfter * 1000;
        }
        // Exponential backoff with jitter
        const baseDelay = Math.min(1000 * Math.pow(2, attempt), 30000);
        const jitter = Math.random() * 1000;
        return baseDelay + jitter;
    }
}
//# sourceMappingURL=errors.js.map