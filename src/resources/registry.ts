/**
 * Resource registry.
 *
 * The server exposes MCP resources through the low-level `Server` request
 * handlers, driven by a list of small modules. A pack adds its resources by
 * exporting one `ResourceModule` and adding a single import line to
 * `src/resources/index.ts` — no change to the handlers themselves.
 *
 * A module contributes any of three things:
 *  - `resources` — fixed URIs listed by `resources/list` and read by URI;
 *  - `templates` — URI templates listed by `resources/templates/list`, for
 *    families of resources too large or too dynamic to enumerate;
 *  - `resolve`   — a reader for URIs that no fixed resource matches, i.e. the
 *    instances of those templates.
 *
 * Lists are sorted by URI so `resources/list` is deterministic, the same
 * requirement `tools/list` carries (ADR-001 D7).
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ErrorCode,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/** One text body returned for a read. */
export interface ResourceContent {
  /** Defaults to the requested URI. */
  uri?: string;
  mimeType?: string;
  text: string;
}

export interface ResourceEntry {
  uri: string;
  /** Programmatic name, unique across modules. */
  name: string;
  /** Human-readable name for a picker. */
  title?: string;
  description: string;
  mimeType: string;
  /** Read the body. Called per request, so a module may cache internally. */
  read: () => Promise<string> | string;
}

export interface ResourceTemplateEntry {
  uriTemplate: string;
  name: string;
  title?: string;
  description: string;
  mimeType: string;
}

export interface ResourceModule {
  resources?: readonly ResourceEntry[];
  templates?: readonly ResourceTemplateEntry[];
  /** Return `null` when the URI does not belong to this module. */
  resolve?: (
    uri: string
  ) => Promise<ResourceContent | null> | ResourceContent | null;
}

function byUri(a: { uri: string }, b: { uri: string }): number {
  if (a.uri === b.uri) return 0;
  return a.uri < b.uri ? -1 : 1;
}

function byUriTemplate(
  a: { uriTemplate: string },
  b: { uriTemplate: string }
): number {
  if (a.uriTemplate === b.uriTemplate) return 0;
  return a.uriTemplate < b.uriTemplate ? -1 : 1;
}

/** Every fixed resource of every module, ordered by URI. */
export function collectResources(
  modules: readonly ResourceModule[]
): ResourceEntry[] {
  return modules.flatMap((module) => module.resources ?? []).sort(byUri);
}

/** Every URI template of every module, ordered by template. */
export function collectResourceTemplates(
  modules: readonly ResourceModule[]
): ResourceTemplateEntry[] {
  return modules
    .flatMap((module) => module.templates ?? [])
    .sort(byUriTemplate);
}

/** Read one URI: a fixed resource first, then each module's resolver. */
export async function readResource(
  modules: readonly ResourceModule[],
  uri: string
): Promise<ResourceContent> {
  const fixed = collectResources(modules).find((entry) => entry.uri === uri);
  if (fixed) {
    return {
      uri: fixed.uri,
      mimeType: fixed.mimeType,
      text: await fixed.read(),
    };
  }

  for (const module of modules) {
    if (!module.resolve) continue;
    const resolved = await module.resolve(uri);
    if (resolved) {
      return { uri, ...resolved };
    }
  }

  throw new McpError(
    ErrorCode.InvalidParams,
    `Unknown resource: ${uri}. Call resources/list for the available URIs.`
  );
}

/**
 * Register `resources/list`, `resources/templates/list` and `resources/read`.
 * Requires the `resources` capability to be declared on the server.
 */
export function registerResources(
  server: Server,
  modules: readonly ResourceModule[]
): string[] {
  const resources = collectResources(modules);
  const templates = collectResourceTemplates(modules);

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: resources.map((entry) => ({
      uri: entry.uri,
      name: entry.name,
      ...(entry.title ? { title: entry.title } : {}),
      description: entry.description,
      mimeType: entry.mimeType,
    })),
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: templates.map((entry) => ({
      uriTemplate: entry.uriTemplate,
      name: entry.name,
      ...(entry.title ? { title: entry.title } : {}),
      description: entry.description,
      mimeType: entry.mimeType,
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const content = await readResource(modules, request.params.uri);
    return {
      contents: [
        {
          uri: content.uri ?? request.params.uri,
          ...(content.mimeType ? { mimeType: content.mimeType } : {}),
          text: content.text,
        },
      ],
    };
  });

  return resources.map((entry) => entry.uri);
}
