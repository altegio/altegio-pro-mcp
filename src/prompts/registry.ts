/**
 * Prompt registry.
 *
 * Prompts are the workflows a person picks by name in a host: a first-time
 * location setup, a monthly review. They are registered through the low-level
 * `Server` handlers and driven by a list of small modules, so a pack adds its
 * prompts by exporting one `PromptModule` and adding a single import line to
 * `src/prompts/index.ts`.
 *
 * `prompts/list` is sorted by name, for the same reason `tools/list` is
 * deterministic (ADR-001 D7).
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  McpError,
  type PromptMessage,
} from '@modelcontextprotocol/sdk/types.js';

export interface PromptArgumentSpec {
  name: string;
  description: string;
  required?: boolean;
}

/**
 * A type alias, not an interface: the SDK's result union is an
 * index-signature type, and only aliases get an implicit index signature.
 */
export type PromptBuildResult = {
  description?: string;
  messages: PromptMessage[];
};

export interface PromptEntry {
  name: string;
  title?: string;
  description: string;
  arguments?: readonly PromptArgumentSpec[];
  /** Called per request with the validated arguments. */
  build: (
    args: Readonly<Record<string, string>>
  ) => Promise<PromptBuildResult> | PromptBuildResult;
}

export interface PromptModule {
  prompts: readonly PromptEntry[];
}

/** A single user-role text message — what most prompts return. */
export function userText(text: string): PromptMessage {
  return { role: 'user', content: { type: 'text', text } };
}

/** Every prompt of every module, ordered by name. */
export function collectPrompts(
  modules: readonly PromptModule[]
): PromptEntry[] {
  return modules
    .flatMap((module) => module.prompts)
    .sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1));
}

/** Resolve one prompt, validating that every required argument is present. */
export async function getPrompt(
  modules: readonly PromptModule[],
  name: string,
  args: Readonly<Record<string, string>> = {}
): Promise<PromptBuildResult> {
  const entry = collectPrompts(modules).find((prompt) => prompt.name === name);
  if (!entry) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Unknown prompt: ${name}. Call prompts/list for the available prompts.`
    );
  }

  const missing = (entry.arguments ?? [])
    .filter((argument) => argument.required && !args[argument.name])
    .map((argument) => argument.name);
  if (missing.length > 0) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Prompt ${name} needs: ${missing.join(', ')}.`
    );
  }

  const built = await entry.build(args);
  return {
    description: built.description ?? entry.description,
    messages: built.messages,
  };
}

/**
 * Register `prompts/list` and `prompts/get`. Requires the `prompts` capability
 * to be declared on the server.
 */
export function registerPrompts(
  server: Server,
  modules: readonly PromptModule[]
): string[] {
  const prompts = collectPrompts(modules);

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: prompts.map((entry) => ({
      name: entry.name,
      ...(entry.title ? { title: entry.title } : {}),
      description: entry.description,
      ...(entry.arguments
        ? {
            arguments: entry.arguments.map((argument) => ({
              name: argument.name,
              description: argument.description,
              ...(argument.required === undefined
                ? {}
                : { required: argument.required }),
            })),
          }
        : {}),
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getPrompt(modules, request.params.name, request.params.arguments ?? {})
  );

  return prompts.map((entry) => entry.name);
}
