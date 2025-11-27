# Altegio.Pro MCP Examples

This directory contains examples demonstrating how to use the Altegio.Pro MCP Server.

## Examples

### 1. Basic Usage (`basic-usage.ts`)

Demonstrates direct usage of the Altegio client:
- Logging in with email/password
- Fetching companies
- Getting company details
- Retrieving bookings
- Getting booking details
- Logging out

**Run:**
```bash
# Set up environment
cp ../.env.example ../.env
# Edit .env with your credentials

# Run example
npm run build
node dist/examples/basic-usage.js
```

### 2. Using with Claude Desktop

The primary use case is integration with AI assistants like Claude Desktop.

**Setup in Claude Desktop:**

1. Open Claude Desktop configuration:
   ```bash
   # macOS
   ~/Library/Application\ Support/Claude/claude_desktop_config.json

   # Windows
   %APPDATA%\Claude\claude_desktop_config.json
   ```

2. Add the Altegio.Pro MCP server:
   ```json
   {
     "mcpServers": {
       "altegio": {
         "command": "npx",
         "args": ["@altegio/mcp-server-pro"],
         "env": {
           "ALTEGIO_API_TOKEN": "your_partner_token_here"
         }
       }
     }
   }
   ```

3. Restart Claude Desktop

4. Use natural language to interact:
   ```
   "I need to set up Altegio integration for my business"
   "Show me today's bookings for my barbershop"
   "What companies do I have access to?"
   ```

### 3. Custom MCP Server Integration

If you want to integrate this with your own MCP client:

```typescript
import { MCPServer } from '@altegio/mcp-server-pro';
import { AltegioClient } from '@altegio/mcp-server-pro';
import { registerTools, registerPrompts } from '@altegio/mcp-server-pro';

// Create client
const client = new AltegioClient({
  apiBase: 'https://api.alteg.io/api/v1',
  partnerToken: process.env.ALTEGIO_API_TOKEN!,
});

// Create MCP server
const mcpServer = new MCPServer({
  name: 'my-altegio-server',
  version: '1.0.0',
});

// Register tools and prompts
registerTools(mcpServer, client);
registerPrompts(mcpServer, client);

// Start server
await mcpServer.start();
```

## Available Tools

The MCP server exposes these tools:

### Authentication
- `altegio_login` - Login with email/password
- `altegio_logout` - Logout and clear credentials

### Companies
- `list_companies` - Get all accessible companies

### Bookings
- `list_bookings` - List bookings with filters
- `get_booking` - Get booking details

## Available Prompts

Prompts provide guided workflows:

### altegio_setup
Guides through authentication and company selection.

**Usage in AI assistant:**
```
"I need to set up Altegio"
```

### altegio_get_bookings
Helps retrieve bookings for a specific company and date range.

**Usage in AI assistant:**
```
"Show me this week's bookings"
"Get bookings for company 12345"
```

## Environment Variables

Required:
- `ALTEGIO_API_TOKEN` - Your Partner API token from Altegio

Optional:
- `ALTEGIO_USER_TOKEN` - Pre-authenticated user token
- `ALTEGIO_API_BASE` - API base URL (default: https://api.alteg.io/api/v1)
- `LOG_LEVEL` - Logging level (default: info)
- `CREDENTIALS_DIR` - Custom credentials directory
- `CREDENTIALS_ENCRYPTION_KEY` - Encryption key for credentials

## Getting Your API Token

1. Visit [Altegio Developer Portal](https://developer.alteg.io)
2. Log in to your account
3. Navigate to "Account Settings" → "Account Details"
4. Copy your Partner Token

## Security Notes

- Never commit your API tokens to version control
- User credentials are stored locally in `~/.altegio-mcp/credentials.json`
- Credentials are automatically encrypted if `CREDENTIALS_ENCRYPTION_KEY` is set
- File permissions are set to 0600 (owner read/write only)

## Troubleshooting

**"Authentication failed"**
- Verify your Partner API token is correct
- Check that you're using the correct email/password
- Ensure your account has API access enabled

**"Company not found"**
- Run `list_companies` to see available companies
- Verify the company ID is correct
- Check that your user has access to the company

**"Rate limit exceeded"**
- Default: 200 requests per minute
- Adjust with `RATE_LIMIT_REQUESTS` env var
- Wait for the rate limit window to reset

## Need Help?

- [Documentation](https://github.com/altegio/altegio-pro-mcp)
- [Issues](https://github.com/altegio/altegio-pro-mcp/issues)
- [Discussions](https://github.com/altegio/altegio-pro-mcp/discussions)
