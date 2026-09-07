import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools/registry.js';
import { DEFAULT_FACET, type FacetKey } from './tools/facets.js';
import { registerResources, resourceModules } from './resources/index.js';
import { registerPrompts, promptModules } from './prompts/index.js';
import { AltegioClient } from './providers/altegio-client.js';
import { loadConfig } from './config/schema.js';

export interface MCPServer extends Server {
  name: string;
  version: string;
  /** Which static view of the tool surface this instance serves (ADR-001 D3). */
  facet: FacetKey;
}

export interface CreateServerOptions {
  /**
   * Serve a single facet instead of the default view. The HTTP transport passes
   * the facet of the path the request arrived on; stdio leaves it unset and
   * gets everything.
   */
  facet?: FacetKey;
}

export function createServer(options: CreateServerOptions = {}): MCPServer {
  // Load and validate configuration
  const config = loadConfig();
  const facet = options.facet ?? DEFAULT_FACET;

  const server = new Server(
    {
      name: config.server.name,
      version: config.server.version,
    },
    {
      capabilities: config.server.capabilities,
      instructions: config.server.instructions,
    }
  ) as MCPServer;

  server.name = config.server.name;
  server.version = config.server.version;
  server.facet = facet;

  // Create Altegio client with validated config
  const altegioClient = new AltegioClient(
    {
      apiBase: config.altegio.apiBase,
      partnerToken: config.altegio.partnerToken,
      userToken: config.altegio.userToken,
    },
    config.env.CREDENTIALS_DIR,
    { requireDelegatedIdentity: config.env.REQUIRE_DELEGATED_IDENTITY }
  );

  // Register tools with client, filtered to this facet
  registerTools(server, altegioClient, {
    facet,
    excludeOnboardingFromDefault:
      config.env.MCP_DEFAULT_FACET_EXCLUDE_ONBOARDING,
  });

  // Resources and prompts are the same on every facet: they describe the
  // product, not a slice of the tool surface.
  registerResources(server, resourceModules);
  registerPrompts(server, promptModules);

  return server;
}

export async function startServer(server: Server): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
