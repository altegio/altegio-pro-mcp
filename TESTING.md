# Testing Altegio.Pro MCP Server

## Local Testing

### 1. Run Tests

```bash
npm test                 # All tests
npm run test:coverage    # With coverage
npm run test:watch       # Watch mode
```

### 2. Manual Local Server

```bash
# Build
npm run build

# Run with your token
export ALTEGIO_API_TOKEN="your_partner_token"
node dist/index.js
```

## Cloud Run Testing

After deploying to Cloud Run (see [DEPLOYMENT.md](DEPLOYMENT.md)), test your server:

```bash
# Set your service URL
SERVICE_URL="https://your-service-name.run.app"

# Health check
curl $SERVICE_URL/health

# List available tools (JSON-RPC)
curl -X POST $SERVICE_URL/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# SSE streaming (for OpenAI/ChatGPT)
curl -N $SERVICE_URL/sse
```

## Available Tools

**Authentication:**
- `altegio_login` - Login with email/password
- `altegio_logout` - Clear credentials

**Business Management:**
- `list_companies` - Get managed companies
- `get_bookings` - View appointments
- `get_staff` - View staff (B2B)
- `get_services` - View services (B2B)
- `get_service_categories` - View categories
- `get_schedule` - View employee schedules

## Authentication Flow

```bash
# 1. Login
curl -X POST $SERVICE_URL/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "altegio_login",
      "arguments": {
        "email": "your_email@example.com",
        "password": "your_password"
      }
    }
  }'

# 2. List companies
curl -X POST $SERVICE_URL/rpc \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "list_companies",
      "arguments": {"my": 1}
    }
  }'
```

## Integration Testing

### OpenAI Platform / ChatGPT

1. Deploy to Cloud Run
2. Get your service URL
3. Add SSE endpoint in ChatGPT settings:
   ```
   https://your-service-name.run.app/sse
   ```

### Other AI Platforms

Use JSON-RPC endpoint:
```
POST https://your-service-name.run.app/rpc
```

## Automated Testing Script

```bash
#!/bin/bash

SERVICE_URL="https://your-service-name.run.app"

echo "Testing Altegio.Pro MCP Server..."

# Health check
echo "1. Health check..."
curl -s $SERVICE_URL/health | grep "healthy" && echo "✓ Health OK" || echo "✗ Health FAIL"

# Tools list
echo "2. Tools list..."
curl -s -X POST $SERVICE_URL/rpc \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | grep "altegio_login" && echo "✓ Tools OK" || echo "✗ Tools FAIL"

# SSE endpoint
echo "3. SSE streaming..."
timeout 3 curl -s -N $SERVICE_URL/sse | grep "connected" && echo "✓ SSE OK" || echo "✗ SSE FAIL"

echo "Testing complete!"
```

## Claude Desktop Testing

See [CLAUDE_DESKTOP_SETUP.md](CLAUDE_DESKTOP_SETUP.md) for integration instructions.

## Security Notes

**Important:**
- Do not commit API tokens to git
- Use test accounts for public deployments
- Review Cloud Run IAM permissions
- Monitor server logs for suspicious activity

## Support

- **Issues**: https://github.com/altegio/altegio-pro-mcp/issues
- **API Docs**: https://developer.alteg.io
