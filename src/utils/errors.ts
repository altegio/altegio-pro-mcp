/**
 * Custom error classes for better error handling
 */

import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { AltegioError } from '../types/altegio.types.js';

/**
 * Base error class for MCP server errors
 */
export class MCPError extends Error {
  public readonly code: ErrorCode;
  public readonly data?: unknown;

  constructor(
    message: string,
    code: ErrorCode = ErrorCode.InternalError,
    data?: unknown
  ) {
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
  constructor(method: string) {
    super(`Method not found: ${method}`, ErrorCode.MethodNotFound);
    this.name = 'MethodNotFoundError';
  }
}

/**
 * Error thrown when request parameters are invalid
 */
export class InvalidParamsError extends MCPError {
  constructor(message: string, data?: unknown) {
    super(message, ErrorCode.InvalidParams, data);
    this.name = 'InvalidParamsError';
  }
}

/**
 * Error thrown when tool execution fails
 */
export class ToolExecutionError extends MCPError {
  constructor(toolName: string, originalError: Error) {
    super(
      `Tool execution failed for '${toolName}': ${originalError.message}`,
      ErrorCode.InternalError,
      {
        tool: toolName,
        originalError: originalError.message,
      }
    );
    this.name = 'ToolExecutionError';
  }
}

/**
 * Error thrown when prompt execution fails
 */
export class PromptExecutionError extends MCPError {
  constructor(promptName: string, originalError: Error) {
    super(
      `Prompt execution failed for '${promptName}': ${originalError.message}`,
      ErrorCode.InternalError,
      {
        prompt: promptName,
        originalError: originalError.message,
      }
    );
    this.name = 'PromptExecutionError';
  }
}

/**
 * Altegio API specific error
 */
export class AltegioApiError extends Error implements AltegioError {
  public readonly code?: number;
  public readonly statusCode?: number;
  public readonly response?: unknown;

  constructor(message: string, statusCode?: number, response?: unknown) {
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
  public readonly retryAfter?: number;

  constructor(message = 'Rate limit exceeded', retryAfter?: number) {
    super(message, 429);
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

/**
 * Configuration error
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Validation error
 */
export class ValidationError extends Error {
  public readonly errors: unknown[];

  constructor(message: string, errors: unknown[] = []) {
    super(message);
    this.name = 'ValidationError';
    this.errors = errors;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Type guard to check if error is an MCPError
 */
export function isMCPError(error: unknown): error is MCPError {
  return error instanceof MCPError;
}

/**
 * Type guard to check if error is an AltegioApiError
 */
export function isAltegioApiError(error: unknown): error is AltegioApiError {
  return error instanceof AltegioApiError;
}

/**
 * Convert any error to MCPError
 */
export function toMCPError(error: unknown): MCPError {
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
  private static readonly RETRYABLE_ERRORS = [408, 429, 500, 502, 503, 504];

  public static isRetryable(error: unknown): boolean {
    if (isAltegioApiError(error) && error.statusCode) {
      return this.RETRYABLE_ERRORS.includes(error.statusCode);
    }
    return false;
  }

  public static getRetryDelay(error: unknown, attempt: number): number {
    if (error instanceof RateLimitError && error.retryAfter) {
      return error.retryAfter * 1000;
    }
    // Exponential backoff with jitter
    const baseDelay = Math.min(1000 * Math.pow(2, attempt), 30000);
    const jitter = Math.random() * 1000;
    return baseDelay + jitter;
  }
}
