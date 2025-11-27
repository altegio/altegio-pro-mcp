/**
 * Custom error classes for better error handling
 */
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { AltegioError } from '../types/altegio.types.js';
/**
 * Base error class for MCP server errors
 */
export declare class MCPError extends Error {
    readonly code: ErrorCode;
    readonly data?: unknown;
    constructor(message: string, code?: ErrorCode, data?: unknown);
    toJSON(): {
        code: ErrorCode;
        message: string;
        data: unknown;
    };
}
/**
 * Error thrown when a method is not found
 */
export declare class MethodNotFoundError extends MCPError {
    constructor(method: string);
}
/**
 * Error thrown when request parameters are invalid
 */
export declare class InvalidParamsError extends MCPError {
    constructor(message: string, data?: unknown);
}
/**
 * Error thrown when tool execution fails
 */
export declare class ToolExecutionError extends MCPError {
    constructor(toolName: string, originalError: Error);
}
/**
 * Error thrown when prompt execution fails
 */
export declare class PromptExecutionError extends MCPError {
    constructor(promptName: string, originalError: Error);
}
/**
 * Altegio API specific error
 */
export declare class AltegioApiError extends Error implements AltegioError {
    readonly code?: number;
    readonly statusCode?: number;
    readonly response?: unknown;
    constructor(message: string, statusCode?: number, response?: unknown);
}
/**
 * Authentication error
 */
export declare class AuthenticationError extends AltegioApiError {
    constructor(message?: string);
}
/**
 * Rate limit error
 */
export declare class RateLimitError extends AltegioApiError {
    readonly retryAfter?: number;
    constructor(message?: string, retryAfter?: number);
}
/**
 * Configuration error
 */
export declare class ConfigurationError extends Error {
    constructor(message: string);
}
/**
 * Validation error
 */
export declare class ValidationError extends Error {
    readonly errors: unknown[];
    constructor(message: string, errors?: unknown[]);
}
/**
 * Type guard to check if error is an MCPError
 */
export declare function isMCPError(error: unknown): error is MCPError;
/**
 * Type guard to check if error is an AltegioApiError
 */
export declare function isAltegioApiError(error: unknown): error is AltegioApiError;
/**
 * Convert any error to MCPError
 */
export declare function toMCPError(error: unknown): MCPError;
/**
 * Error handler utility
 */
export declare class ErrorHandler {
    private static readonly RETRYABLE_ERRORS;
    static isRetryable(error: unknown): boolean;
    static getRetryDelay(error: unknown, attempt: number): number;
}
//# sourceMappingURL=errors.d.ts.map