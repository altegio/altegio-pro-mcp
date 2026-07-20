/**
 * Tool factory.
 *
 * `defineTool` turns a single declarative definition — a Zod input schema, an
 * optional structured-output schema, MCP annotations, and a small handler — into
 * a `DefinedTool` that knows how to (a) render its MCP tool spec and (b) build a
 * client-bound call handler.
 *
 * Unlike the original factory this one preserves everything current `main`
 * relies on: structured output (`structuredContent` + `outputSchema`, PRO-4),
 * tool `annotations` (PRO-5), and the shared typed-error wrapper. The input
 * JSON Schema is generated from the Zod schema via zod 4's native
 * `z.toJSONSchema`, so the definition is the single source of truth.
 */
import { z, type ZodType } from 'zod';
import type { AltegioClient } from '../providers/altegio-client.js';
import { withErrorHandling, type ToolResult } from './tool-result.js';

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

/** What a tool handler returns: human-readable text plus optional structured payload. */
export interface HandlerOutput {
  text: string;
  structuredContent?: unknown;
}

export interface ToolContext<T> {
  input: T;
  client: AltegioClient;
}

export interface ToolDefinition<T extends ZodType> {
  name: string;
  category: string;
  description: string;
  annotations?: ToolAnnotations;
  input: T;
  outputSchema?: Record<string, unknown>;
  handler: (ctx: ToolContext<z.infer<T>>) => Promise<HandlerOutput>;
}

export interface McpToolSpec {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

export interface DefinedTool<T extends ZodType = ZodType> {
  toMcpTool: () => McpToolSpec;
  createHandler: (
    client: AltegioClient
  ) => (args: unknown) => Promise<ToolResult>;
  meta: ToolDefinition<T>;
}

/** Generate a plain JSON Schema for the MCP `inputSchema` (drops the `$schema` key). */
function inputJsonSchema(schema: ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return json;
}

export function defineTool<T extends ZodType>(
  def: ToolDefinition<T>
): DefinedTool<T> {
  return {
    toMcpTool: () => ({
      name: def.name,
      description: def.description,
      ...(def.annotations ? { annotations: def.annotations } : {}),
      inputSchema: inputJsonSchema(def.input),
      ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
    }),

    createHandler: (client: AltegioClient) => (args: unknown) =>
      withErrorHandling(def.name, async () => {
        const input = def.input.parse(args ?? {}) as z.infer<T>;
        const { text, structuredContent } = await def.handler({
          input,
          client,
        });
        const result: ToolResult = {
          content: [{ type: 'text' as const, text }],
        };
        if (structuredContent !== undefined) {
          result.structuredContent = structuredContent;
        }
        return result;
      }),

    meta: def,
  };
}
