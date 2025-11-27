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
      "args": [
        "/FULL/PATH/TO/altegio-mcp/dist/index.js"
      ],
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

Look for MCP indicator - you should see `altegio-pro` with 8 tools available.

---

## Option 2: Remote Server via Bridge

If you deployed MCP server to Cloud Run, connect via bridge:

### Step 1: Download Bridge

```bash
curl -O https://raw.githubusercontent.com/altegio/altegio-pro-mcp/main/docker-bridge.cjs
```

### Step 2: Configure

```json
{
  "mcpServers": {
    "altegio-remote": {
      "command": "node",
      "args": ["/path/to/docker-bridge.cjs"],
      "env": {
        "MCP_DOCKER_URL": "https://your-service-name.run.app"
      }
    }
  }
}
```

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
      "args": [
        "/Users/YOUR_USERNAME/Developer/altegio-mcp/dist/index.js"
      ],
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
- `altegio_login` - Login with email/password
- `altegio_logout` - Clear credentials

**Business Management:**
- `list_companies` - Get managed companies
- `get_bookings` - View appointments
- `get_staff` - View all staff (B2B)
- `get_services` - View services (B2B)
- `get_service_categories` - View categories
- `get_schedule` - View employee schedules

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

After `altegio_login`, credentials are saved to `~/.altegio-mcp/credentials.json`. Check this file exists and has valid token.

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
"Use altegio_login to authenticate with my credentials"
"List my companies using list_companies"
"Show staff for company ID 123"
```

---

## Support

- **Issues**: https://github.com/altegio/altegio-pro-mcp/issues
- **Docs**: See [README.md](README.md) and [TESTING.md](TESTING.md)
- **API**: https://developer.alteg.io
