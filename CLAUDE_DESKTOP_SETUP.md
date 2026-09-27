# Claude Desktop Setup for Altegio.Pro MCP Server

This guide shows how to integrate Altegio.Pro MCP server with Claude Desktop.

## Option 1: Local Installation (Recommended)

### Step 1: Clone and Build

```bash
git clone https://github.com/altegio/altegio-pro-mcp.git
cd altegio-mcp
npm install
npm run build
```

### Step 2: Get Altegio API Token

1. Register at [developer.alteg.io](https://developer.alteg.io)
2. Get your Partner Token from Account Settings

### Step 3: Configure Claude Desktop

**macOS:**
Edit `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows:**
Edit `%APPDATA%\Claude\claude_desktop_config.json`

**Linux:**
Edit `~/.config/Claude/claude_desktop_config.json`

Add configuration:

```json
{
  "mcpServers": {
    "altegio-pro": {
      "command": "node",
      "args": ["/FULL/PATH/TO/altegio-mcp/dist/index.js"],
      "env": {
        "ALTEGIO_API_TOKEN": "your_partner_token_here"
      }
    }
  }
}
```

**Replace:**

- `/FULL/PATH/TO/altegio-mcp` with actual path
- `your_partner_token_here` with your token

### Step 4: Restart Claude Desktop

Close and restart Claude Desktop.

### Step 5: Verify

Look for the MCP indicator: the `altegio-pro` server and its tools should be listed.

---

## Option 2: Hosted Server

Claude Desktop connects to a hosted deployment directly over Streamable HTTP.
Add the server address as a custom connector (Settings → Connectors) and sign in
when prompted; no local process or bridge script is needed. Use the address of
the complete surface, or one of its views (`/<facet>` or `/readonly`) when the
host caps active tools. See [README.md](README.md) for the served views.

---

## Complete Setup Examples

### macOS Example

```bash
# Clone and build
cd ~/Developer
git clone https://github.com/altegio/altegio-pro-mcp.git
cd altegio-mcp
npm install
npm run build

# Get full path
pwd  # Copy this path

# Edit config
open -e ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Add to config (replace YOUR_USERNAME and YOUR_TOKEN):

```json
{
  "mcpServers": {
    "altegio-pro": {
      "command": "node",
      "args": ["/path/to/altegio-pro-mcp/dist/index.js"],
      "env": {
        "ALTEGIO_API_TOKEN": "YOUR_TOKEN",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

### Windows Example

```powershell
# Clone and build
cd C:\Users\%USERNAME%\Documents
git clone https://github.com/altegio/altegio-pro-mcp.git
cd altegio-mcp
npm install
npm run build

# Edit config
notepad %APPDATA%\Claude\claude_desktop_config.json
```

Add to config (use double backslashes):

```json
{
  "mcpServers": {
    "altegio-pro": {
      "command": "node",
      "args": [
        "C:\\Users\\YOUR_USERNAME\\Documents\\altegio-mcp\\dist\\index.js"
      ],
      "env": {
        "ALTEGIO_API_TOKEN": "YOUR_TOKEN",
        "LOG_LEVEL": "info"
      }
    }
  }
}
```

---

## Available Tools

After setup, Claude Desktop will have:

**Authentication:**

- `auth_login` - Login with email/password
- `auth_logout` - Clear credentials

**Business Management:**

- `locations_list` - Get managed locations
- `appointments_list` - View appointments
- `team_members_list` - View team members
- `services_list` - View services
- `service_categories_list` - View categories
- `schedules_get` - View team member work schedules

---

## Troubleshooting

### "node: command not found"

Install Node.js:

- **macOS**: `brew install node`
- **Windows**: Download from [nodejs.org](https://nodejs.org)
- **Linux**: `sudo apt install nodejs`

### Server not showing

1. Check Claude Desktop logs:
   - **macOS**: `~/Library/Logs/Claude/mcp-server-altegio-pro.log`
   - **Windows**: `%APPDATA%\Claude\logs\mcp-server-altegio-pro.log`

2. Test server manually:

```bash
cd /path/to/altegio-mcp
ALTEGIO_API_TOKEN=your_token node dist/index.js
```

Should connect via stdio.

### Authentication issues

After `auth_login`, credentials are saved to `~/.altegio-mcp/credentials.json`. Check this file exists and has valid token.

### Path issues

Use absolute paths in config. Get full path:

```bash
# macOS/Linux
cd /path/to/altegio-mcp && pwd

# Windows
cd C:\path\to\altegio-mcp && echo %CD%
```

---

## Environment Variables

Optional configuration in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "altegio-pro": {
      "command": "node",
      "args": ["/path/to/dist/index.js"],
      "env": {
        "ALTEGIO_API_TOKEN": "required_token",
        "ALTEGIO_API_BASE": "https://api.alteg.io/api/v1",
        "LOG_LEVEL": "info",
        "NODE_ENV": "production",
        "RATE_LIMIT_REQUESTS": "200",
        "MAX_RETRY_ATTEMPTS": "3"
      }
    }
  }
}
```

---

## Security Notes

- Do not commit `claude_desktop_config.json` with tokens
- Tokens stored in config are readable by any process
- For production, use environment variables or secrets manager
- User credentials saved to `~/.altegio-mcp/credentials.json`

---

## Testing Installation

In Claude Desktop, try:

```
"Use auth_login to authenticate with my credentials"
"List my locations using locations_list"
"Show staff for location ID 123"
```

---

## Support

- **Issues**: https://github.com/altegio/altegio-pro-mcp/issues
- **Docs**: See [README.md](README.md) and [TESTING.md](TESTING.md)
- **API**: https://developer.alteg.io
