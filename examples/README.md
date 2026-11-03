# Examples

Build the unpublished alpha from a checkout with Node.js 26.13.0 and npm 11.20.0
(Node.js 24.22.2 is the compatibility target):

```sh
git clone https://github.com/altegio/altegio-pro-mcp.git
cd altegio-pro-mcp
npm ci
npm run build
npx tsx examples/basic-usage.ts
```

Run these commands from the repository root. [basic-usage.ts](basic-usage.ts)
uses the installed MCP SDK client to start the built stdio CLI. It lists tools,
lists workflow prompts, reads a product resource and closes the process. It
uses a temporary credential directory and synthetic tokens, and makes no
business API calls.

For an actual desktop connection, follow
[desktop setup](../CLAUDE_DESKTOP_SETUP.md), set your partner token in the host's
protected environment, and authenticate using `auth_login`. Discover the current
names through `tools/list` and `prompts/list`; examples include `locations_list`,
`appointments_list`, `api_search_operations` and `onboarding_walkthrough`.
[Generated tool membership](../docs/architecture/tool-surface.md) distinguishes
stdio from HTTP views.

The supported install path is a source checkout or a verified alpha tarball;
`npx @altegio/mcp-server-pro` cannot work while the package is unpublished.
The root entry is the CLI. The existing advanced embedding subpath exports
`createServer` and `startServer` from `@altegio/mcp-server-pro/server`; it does
not export `AltegioClient`, `MCPServer` as a class, or tool-registration helpers
from the package root. Use the MCP protocol for client integrations rather than
importing private source paths.

Report a reproducible example failure in
[Issues](https://github.com/altegio/altegio-pro-mcp/issues). Sensitive reports
follow [SECURITY.md](../SECURITY.md).
