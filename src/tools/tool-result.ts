/**
 * Shared tool-result shape and the typed-error wrapper used by every tool.
 *
 * Extracted from the former monolithic `handlers.ts` so both the tool factory
 * and any remaining handlers share a single error-mapping implementation.
 */
import { ZodError } from 'zod';
import { AuthenticationError, AltegioApiError } from '../utils/errors.js';

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Run a tool body and map any thrown error to a friendly `isError` result.
 * Preserves the typed-error messages relied on by the tool tests and clients.
 */
export async function withErrorHandling(
  toolName: string,
  fn: () => Promise<ToolResult>
): Promise<ToolResult> {
  try {
    return await fn();
  } catch (error) {
    let message: string;

    if (error instanceof ZodError) {
      const issues = error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; ');
      message = `Invalid parameters for ${toolName}: ${issues}`;
    } else if (error instanceof AuthenticationError) {
      message = `Authentication required. Call altegio_login before using ${toolName}.`;
    } else if (error instanceof AltegioApiError) {
      message = error.message;
    } else if (error instanceof Error) {
      message = `${toolName} failed: ${error.message}`;
    } else {
      message = `${toolName} failed with an unexpected error`;
    }

    return {
      content: [{ type: 'text' as const, text: message }],
      isError: true,
    };
  }
}
