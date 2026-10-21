import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools } from './tools/registry.js';
import {
  COMPACT_VIEW,
  FULL_VIEW,
  READONLY_VIEW,
  DEFAULT_FACET,
  demotedGroupsInstruction,
  effectiveView,
  type FacetKey,
} from './tools/facets.js';
import { registerResources, resourceModules } from './resources/index.js';
import { registerPrompts, promptModules } from './prompts/index.js';
import { AltegioClient } from './providers/altegio-client.js';
import {
  COMPACT_VIEW_INSTRUCTIONS,
  loadConfig,
  productInstructionsFor,
  readOnlyViewInstructions,
} from './config/schema.js';

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
  const defaultListing = config.env.MCP_DEFAULT_VIEW;
  // `/mcp` follows the compact view or the full list, as the deployment says.
  const listing = effectiveView(facet, { defaultListing });

  // The read-only view says so up front, before the product description invites
  // the model to manage anything; the compact listing says up front how to
  // reach what it does not list. The full list names the groups it does not
  // list and where they are served. All are added around the product text
  // rather than replacing it, so a deployment's `MCP_SERVER_INSTRUCTIONS`
  // override still gets them. The product text itself leaves out what is not
  // true on the view (`productInstructionsFor`).
  const product = productInstructionsFor(config.server.instructions, {
    writes: listing !== READONLY_VIEW,
    narrowerViews: facet === DEFAULT_FACET && listing === FULL_VIEW,
  });
  const instructions =
    listing === READONLY_VIEW
      ? `${readOnlyViewInstructions(publicBaseUrl)} ${product}`
      : listing === COMPACT_VIEW
        ? `${COMPACT_VIEW_INSTRUCTIONS} ${product}`
        : listing === FULL_VIEW
          ? `${product} ${demotedGroupsInstruction()}`
          : product;

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
    exposePasswordLogin: config.env.ALTEGIO_EXPOSE_PASSWORD_LOGIN,
    defaultListing,
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
