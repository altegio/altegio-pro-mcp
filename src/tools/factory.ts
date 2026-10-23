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
import { z, type ZodError, type ZodType } from 'zod';
import type { AltegioClient } from '../providers/altegio-client.js';
import {
  prepareConfirmation,
  CONFIRMATION_TOKEN_ARG,
  CONFIRMATION_TOKEN_SCHEMA,
  type ConfirmationSpec,
  type ConfirmedCall,
  type PreparedConfirmation,
} from './confirmation.js';
import {
  withErrorHandling,
  type ToolContent,
  type ToolResult,
} from './tool-result.js';
import { requiredScopesFor, type ToolScope } from './scopes.js';
import {
  acceptedKeysAt,
  capPageSize,
  coerceIdStrings,
  compactJsonSchema,
  type PageSizeCap,
} from './input-normalization.js';
import { notePageSizeCapped } from '../utils/tool-call-observation.js';

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
  /** A partial workflow or refused mutation did not finish its requested work. */
  isError?: boolean;
  /**
   * Content blocks appended after the text summary — a `resource_link` to
   * output that does not fit in the result's size budget (ADR-001 D8).
   */
  extraContent?: ToolContent[];
}

export interface ToolContext<T> {
  input: T;
  client: AltegioClient;
  /**
   * Present when a person confirmed this call (`confirm`): the version they
   * were shown and the call's idempotency key (see `./confirmation.ts`).
   */
  confirmation?: ConfirmedCall;
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
  ) => (args: unknown, confirmation?: ConfirmedCall) => Promise<ToolResult>;
  /**
   * Present only when the definition declares `confirm`. Binds the declared
   * spec to one set of raw arguments with the input generic erased, so the
   * registry can hold the gates for every tool in one map. Returns `undefined`
   * for arguments the tool would reject anyway. The confirmation token binds
   * the parsed, canonical input (`./input-normalization.ts`), not the raw
   * arguments, so a cosmetic difference on the repeat does not void it.
   */
  prepareConfirmation?: (args: unknown) => PreparedConfirmation | undefined;
  /**
   * What the handler's own input validation finds wrong with `args` — the
   * same normalization and strictness — or `undefined` when they pass. The
   * registry uses it to resolve a former tool name and to classify failures.
   */
  inputIssues: (args: unknown) => ZodError['issues'] | undefined;
  meta: ToolDefinition<T>;
}

/**
 * Generate a plain JSON Schema for the MCP `inputSchema` (drops the `$schema`
 * key and the generator noise `compactJsonSchema` lists).
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
  const json = compactJsonSchema(
    z.toJSONSchema(schema, { io: 'input' })
  ) as Record<string, unknown>;
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

/** Says that a first page was served smaller than asked, and how to read on. */
function pageSizeCapNotice(cap: PageSizeCap): ToolContent {
  return {
    type: 'text',
    text:
      `page_size ${cap.requested} is above this tool's maximum of ${cap.served}, ` +
      `so this page holds up to ${cap.served} items. Read on with ` +
      'pagination.next_page and pagination.page_size from this result.',
  };
}

export function defineTool<T extends ZodType>(
  def: ToolDefinition<T>
): DefinedTool<T> {
  // Reject misspelled or obsolete top-level arguments instead of silently
  // dropping them before a mutation. Nested adapter payloads keep their schemas.
  const schema =
    def.input instanceof z.ZodObject ? def.input.strict() : def.input;
  /**
   * The arguments as the schema should judge them: the confirmation token
   * removed (the handler never sees it), id digit strings turned into ids and
   * an oversized first page lowered to the ceiling (`cap` says so).
   */
  const prepared = (args: unknown): { value: unknown; cap?: PageSizeCap } => {
    let input: unknown = args ?? {};
    if (
      def.confirm &&
      input &&
      typeof input === 'object' &&
      !Array.isArray(input)
    ) {
      const rest = { ...(input as Record<string, unknown>) };
      delete rest[CONFIRMATION_TOKEN_ARG];
      input = rest;
    }
    return capPageSize(schema, coerceIdStrings(schema, input));
  };
  const normalized = (args: unknown): unknown => prepared(args).value;
  // An unknown top-level key is answered with the keys the tool does take.
  const acceptedKeys = (path: readonly PropertyKey[]) => {
    const keys = acceptedKeysAt(schema, path);
    return keys && path.length === 0 && def.confirm
      ? [...keys, CONFIRMATION_TOKEN_ARG]
      : keys;
  };
  return {
    toMcpTool: () => ({
      name: def.name,
      description: def.description,
      ...(def.annotations ? { annotations: def.annotations } : {}),
      inputSchema: inputJsonSchema(schema, def.confirm !== undefined),
      ...(def.outputSchema ? { outputSchema: def.outputSchema } : {}),
    }),

    ...(def.confirm
      ? {
          prepareConfirmation: prepareConfirmation(def.confirm, (args) => {
            const parsed = schema.safeParse(normalized(args));
            return parsed.success ? (parsed.data as z.infer<T>) : undefined;
          }),
        }
      : {}),

    inputIssues: (args) => {
      const parsed = schema.safeParse(normalized(args));
      return parsed.success ? undefined : parsed.error.issues;
    },

    createHandler:
      (client: AltegioClient) =>
      (args: unknown, confirmation?: ConfirmedCall) =>
        withErrorHandling(
          def.name,
          async () => {
            const { value, cap } = prepared(args);
            const input = schema.parse(value) as z.infer<T>;
            if (cap) notePageSizeCapped();
            const { text, structuredContent, extraContent, isError } =
              await def.handler({
                input,
                client,
                ...(confirmation ? { confirmation } : {}),
              });
            const result: ToolResult = {
              content: [
                { type: 'text' as const, text },
                ...(cap ? [pageSizeCapNotice(cap)] : []),
                ...(extraContent ?? []),
              ],
            };
            if (structuredContent !== undefined) {
              result.structuredContent = structuredContent;
            }
            if (isError === true) result.isError = true;
            return result;
          },
          { acceptedKeysAt: acceptedKeys }
        ),

    meta: { ...def, requiredScopes: requiredScopesFor(def.name) },
  };
}
