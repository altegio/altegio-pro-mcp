# Desktop setup (local stdio)

Use a desktop MCP host that supports local stdio processes. The package is an
unpublished alpha, so build a checkout first. Node.js 26.13.0 (npm 11.20.0) is the
primary runtime; Node.js 24.22.2 is also tested.

```sh
git clone https://github.com/altegio/altegio-pro-mcp.git
cd altegio-pro-mcp
npm ci
npm run build
```

Obtain a partner token from your [Altegio developer account](https://developer.alteg.io).
For Claude Desktop, edit `claude_desktop_config.json` in
`~/Library/Application Support/Claude/` on macOS or `%APPDATA%\Claude\` on
Windows. Other stdio hosts use their own configuration UI, with the same
command, arguments and environment.

```json
{
  "mcpServers": {
    "altegio-pro": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/altegio-pro-mcp/dist/index.js"],
      "env": {
        "ALTEGIO_API_TOKEN": "your_partner_token",
        "CREDENTIALS_DIR": "/absolute/path/to/a/private/altegio-credentials"
      }
    }
  }
}
```

Use the actual Node executable, not a shell alias. `mise which node` prints it
for mise installations; `command -v node` can identify other installations.
On Windows, use `where.exe node` and JSON paths such as
`C:\\Program Files\\nodejs\\node.exe`. A desktop process may have a different
PATH from your terminal. Make the credential directory private to your OS user.

Restart the host. It should list `auth_login` and `locations_list`, and the
`onboarding_walkthrough` prompt. Authenticate through the local `auth_login`
tool or supply `ALTEGIO_USER_TOKEN` through the host's protected environment.
The complete tool inventory is generated in
[tool-surface.md](docs/architecture/tool-surface.md); named HTTP views differ
from stdio.

If the server does not appear, run the configured command in a terminal and
inspect stderr. A running stdio server waits for JSON-RPC on stdin; logs belong
on stderr. Check the absolute paths, Node version and partner-token environment.
Do not paste tokens or customer records into an issue.

For a credential-free installation check after building:

```sh
node scripts/smoke/stdio.mjs "$PWD"
```

This initializes MCP, lists tools and prompts, and reads both packaged Markdown
resources with synthetic state. It makes no Altegio business calls.

For the maintained remote service, add `https://mcp.alteg.io/pro` as a remote
Streamable HTTP server in a compatible host and complete Altegio sign-in. A
remote URL does not belong in this local `command` configuration. Read-only
access uses `https://mcp.alteg.io/pro/readonly`.
