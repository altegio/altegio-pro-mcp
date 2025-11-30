import { z, ZodSchema } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AltegioClient } from '../providers/altegio-client.js';

export interface ToolContext<T> {
  input: T;
  client: AltegioClient;
}

export interface ToolDefinition<T extends ZodSchema> {
  name: string;
  category: string;
  description: string;
  requiresAuth: boolean;
  input: T;
  handler: (ctx: ToolContext<z.infer<T>>) => Promise<string>;
}

export interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

export function textResponse(text: string): McpToolResponse {
  return {
    content: [{ type: 'text' as const, text }],
  };
}

export function errorResponse(text: string): McpToolResponse {
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

export interface DefinedTool<T extends ZodSchema> {
  toMcpTool: () => {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  };
  createHandler: (client: AltegioClient) => (args: unknown) => Promise<McpToolResponse>;
  meta: ToolDefinition<T>;
}

export function defineTool<T extends ZodSchema>(def: ToolDefinition<T>): DefinedTool<T> {
  return {
    toMcpTool: () => ({
      name: def.name,
      description: def.description,
      inputSchema: zodToJsonSchema(def.input, {
        target: 'openApi3',
        $refStrategy: 'none',
      }) as Record<string, unknown>,
    }),

    createHandler: (client: AltegioClient) => async (args: unknown): Promise<McpToolResponse> => {
      if (def.requiresAuth && !client.isAuthenticated()) {
        throw new Error('Authentication required. Please login first.');
      }

      try {
        const input = def.input.parse(args);
        const result = await def.handler({ input, client });
        return textResponse(result);
      } catch (error) {
        if (error instanceof Error && error.message.includes('Authentication required')) {
          throw error;
        }
        return errorResponse(
          `Failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    },

    meta: def,
  };
}
