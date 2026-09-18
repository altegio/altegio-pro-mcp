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
import {
  prepareConfirmation,
  CONFIRMATION_TOKEN_ARG,
  CONFIRMATION_TOKEN_SCHEMA,
  type ConfirmationSpec,
  type PreparedConfirmation,
} from './confirmation.js';
import {
  withErrorHandling,
  type ToolContent,
  type ToolResult,
} from './tool-result.js';
import { requiredScopesFor, type ToolScope } from './scopes.js';

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
  /**
   * Content blocks appended after the text summary — a `resource_link` to
   * output that does not fit in the result's size budget (ADR-001 D8).
   */
  extraContent?: ToolContent[];
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
  /**
   * Require a human to confirm this call before it runs (see
   * `./confirmation.ts`). Declaring it here adds the always-present
   * `confirmation_token` argument to `inputSchema` and registers the tool with
   * the gate in `./registry.ts`; the handler itself stays unchanged and never
   * sees the token.
   */
  confirm?: ConfirmationSpec<z.infer<T>>;
  /**
   * Token scopes this tool's execution requires (see `./scopes.ts`).
   *
   * A definition never authors this: `defineTool` fills it from the one map
   * in `./scopes.ts`, keyed by tool name, and a value written here is
   * overwritten. That indirection is the point — the scope vocabulary is a
   * placeholder awaiting the API team, so a rename has to be an edit in one
   * file rather than across seventy definitions. The field exists so a tool's
   * requirement is readable off `meta`, next to its annotations and its
   * confirmation spec, and so the registry enforces what the tool declares.
   */
  requiredScopes?: readonly ToolScope[];
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
  /**
   * Present only when the definition declares `confirm`. Binds the declared
   * spec to one set of raw arguments with the input generic erased, so the
   * registry can hold the gates for every tool in one map. Returns `undefined`
   * for arguments the tool would reject anyway.
   */
  prepareConfirmation?: (args: unknown) => PreparedConfirmation | undefined;
  meta: ToolDefinition<T>;
}

/**
 * Generate a plain JSON Schema for the MCP `inputSchema` (drops the `$schema`
 * key).
 *
 * `withConfirmationToken` adds the optional `confirmation_token` argument. It
 * is added unconditionally, never from the connected client's capabilities:
 * `tools/list` must be identical for every connection to one path (ADR-001 D7),
 * so the argument exists even on hosts that will never need it.
 */
function inputJsonSchema(
  schema: ZodType,
  withConfirmationToken: boolean
): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  if (!withConfirmationToken) return json;

  const properties = (json.properties ?? {}) as Record<string, unknown>;
  return {
    ...json,
    properties: {
      ...properties,
      [CONFIRMATION_TOKEN_ARG]: { ...CONFIRMATION_TOKEN_SCHEMA },
    },
  };
}

export function defineTool<T extends ZodType>(
  def: ToolDefinition<T>
): DefinedTool<T> {
  return {
    toMcpTool: () => ({
      name: def.name,
      description: def.description,
      ...(def.annotations ? { annotations: def.annotations } : {}),
      inputSchema: inputJsonSchema(def.input, def.confirm !== undefined),
      ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
    }),

    ...(def.confirm
      ? {
          prepareConfirmation: prepareConfirmation(def.confirm, (args) => {
            const parsed = def.input.safeParse(args ?? {});
            return parsed.success ? (parsed.data as z.infer<T>) : undefined;
          }),
        }
      : {}),

    createHandler: (client: AltegioClient) => (args: unknown) =>
      withErrorHandling(def.name, async () => {
        const input = def.input.parse(args ?? {}) as z.infer<T>;
        const { text, structuredContent, extraContent } = await def.handler({
          input,
          client,
        });
        const result: ToolResult = {
          content: [{ type: 'text' as const, text }, ...(extraContent ?? [])],
        };
        if (structuredContent !== undefined) {
          result.structuredContent = structuredContent;
        }
        return result;
      }),

    meta: { ...def, requiredScopes: requiredScopesFor(def.name) },
  };
}
