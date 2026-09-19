import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools/registry.js';
import { DEFAULT_FACET, READONLY_VIEW, type FacetKey } from './tools/facets.js';
import { registerResources, resourceModules } from './resources/index.js';
import { registerPrompts, promptModules } from './prompts/index.js';
import { AltegioClient } from './providers/altegio-client.js';
import { loadConfig, readOnlyViewInstructions } from './config/schema.js';

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
  const publicBaseUrl = config.env.MCP_PUBLIC_BASE_URL;

  // The read-only view says so up front, before the product description invites
  // the model to manage anything. Prefixed rather than replacing, so a
  // deployment's `MCP_SERVER_INSTRUCTIONS` override still gets the notice.
  const instructions =
    facet === READONLY_VIEW
      ? `${readOnlyViewInstructions(publicBaseUrl)} ${config.server.instructions}`
      : config.server.instructions;

  const server = new Server(
    {
      name: config.server.name,
      version: config.server.version,
    },
    {
      capabilities: config.server.capabilities,
      instructions,
    }
  ) as MCPServer;

  server.name = config.server.name;
  server.version = config.server.version;
  server.facet = facet;

  // Create Altegio client with validated config
  const altegioClient = new AltegioClient(
    {
      apiBase: config.altegio.apiBase,
      legacyWebBase: config.altegio.legacyWebBase,
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
    exposePasswordLogin: config.env.ALTEGIO_EXPOSE_PASSWORD_LOGIN,
    publicBaseUrl,
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
