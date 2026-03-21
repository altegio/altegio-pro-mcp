# Testing Altegio.Pro MCP Server

## Unit Tests

```bash
npm test                 # All tests (157 tests, 23 suites)
npm run test:coverage    # With coverage report
npm run test:watch       # Watch mode
npm run lint             # Code style check
npm run typecheck        # TypeScript validation
```

## Local Docker Testing

The recommended way to test the HTTP server locally.

### 1. Setup

```bash
# Create .env with your credentials
cat > .env << 'EOF'
ALTEGIO_API_TOKEN=your_partner_token
ALTEGIO_API_BASE=https://api.alteg.io/api/v1
EOF
```

### 2. Start with Docker Compose

```bash
# Build and start (port 8080, development mode)
docker compose -f docker-compose.local.yml up --build -d

# Check logs
docker compose -f docker-compose.local.yml logs -f

# Stop
docker compose -f docker-compose.local.yml down
```

Or run standalone Docker:

```bash
docker build -t altegio-mcp:local .
docker run --rm -p 8080:8080 --env-file .env -e PORT=8080 altegio-mcp:local
```

### 3. Health Check

```bash
curl http://localhost:8080/health
# {"status":"ok","timestamp":"..."}
```

### 4. MCP Protocol Testing

The server uses **Streamable HTTP transport** (MCP spec 2025-11-25). All communication happens via POST requests to the `/mcp` endpoint. The server returns an `mcp-session-id` header on initialization, which must be included in subsequent requests. Responses are returned inline in the POST response body.

```bash
# Initialize MCP handshake (note the session ID in the response header)
curl -sv -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2025-11-25",
      "capabilities": {},
      "clientInfo": {"name": "manual-test", "version": "1.0"}
    }
  }' 2>&1 | grep -i "mcp-session-id"
# Look for: mcp-session-id: <SESSION_ID>

SESSION_ID="<paste session id from response header>"

# Send initialized notification
curl -s -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}'

# List all available tools
curl -s -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}'

# Call a tool (e.g., list_companies)
curl -s -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -H "mcp-session-id: $SESSION_ID" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "list_companies",
      "arguments": {"count": 5}
    }
  }'

# Terminate session when done
curl -s -X DELETE http://localhost:8080/mcp \
  -H "mcp-session-id: $SESSION_ID"
```

All responses are returned inline in the POST response body (no separate SSE stream needed).

### 5. Automated MCP Test Script

```bash
python3 -c "
import subprocess, json, re

BASE = 'http://localhost:8080/mcp'

def post(payload, session_id=None):
    headers = ['-H', 'Content-Type: application/json']
    if session_id:
        headers += ['-H', f'mcp-session-id: {session_id}']
    result = subprocess.run(
        ['curl', '-s', '-D', '-', '-X', 'POST', BASE] + headers +
        ['-d', json.dumps(payload)],
        capture_output=True, text=True
    )
    return result.stdout

# Initialize
resp = post({'jsonrpc':'2.0','id':1,'method':'initialize',
    'params':{'protocolVersion':'2025-11-25','capabilities':{},
        'clientInfo':{'name':'test','version':'1.0'}}})

# Extract session ID from response headers
session_id = None
for line in resp.split('\n'):
    m = re.search(r'mcp-session-id:\s*(\S+)', line, re.IGNORECASE)
    if m:
        session_id = m.group(1)
        break

if not session_id:
    print('FAIL: No session ID in response headers')
    exit(1)

# Parse JSON body (after blank line in response)
parts = resp.split('\r\n\r\n', 1)
body = parts[1] if len(parts) > 1 else ''
r = json.loads(body) if body.strip() else None
print(f'1. Initialize: {\"OK\" if r and \"result\" in r else \"FAIL\"}')

# Send initialized notification
post({'jsonrpc':'2.0','method':'notifications/initialized','params':{}}, session_id)

# List tools
resp = post({'jsonrpc':'2.0','id':2,'method':'tools/list','params':{}}, session_id)
parts = resp.split('\r\n\r\n', 1)
body = parts[1] if len(parts) > 1 else ''
r = json.loads(body) if body.strip() else None
tools = r.get('result',{}).get('tools',[]) if r else []
print(f'2. Tools list: {len(tools)} tools found {\"(OK)\" if len(tools) > 0 else \"(FAIL)\"}')

# Call list_companies
resp = post({'jsonrpc':'2.0','id':3,'method':'tools/call',
    'params':{'name':'list_companies','arguments':{'count':3}}}, session_id)
parts = resp.split('\r\n\r\n', 1)
body = parts[1] if len(parts) > 1 else ''
r = json.loads(body) if body.strip() else None
has_result = r and 'result' in r and not r.get('result',{}).get('isError')
print(f'3. list_companies: {\"OK\" if has_result else \"FAIL\"}')

# Terminate session
subprocess.run(['curl', '-s', '-X', 'DELETE', BASE, '-H', f'mcp-session-id: {session_id}'],
    capture_output=True, text=True)
print('Done!')
"
```

## Cloud Run Testing

After deploying to Cloud Run (see [CI-CD.md](CI-CD.md)):

```bash
SERVICE_URL="https://your-service-name.run.app"

# Health check
curl $SERVICE_URL/health

# MCP Streamable HTTP — initialize a session
curl -sv -X POST $SERVICE_URL/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'
```

The MCP protocol flow is the same as local — POST requests to `/mcp` with the `mcp-session-id` header.

## Integration Testing

### Claude Desktop

Native stdio transport. See [CLAUDE_DESKTOP_SETUP.md](CLAUDE_DESKTOP_SETUP.md).

### Other MCP Clients

Streamable HTTP transport via Cloud Run URL. Any MCP-compatible client can connect using the `/mcp` endpoint.

## Security Notes

- Never commit API tokens to git
- Use `.env` file (gitignored) for local credentials
- Use test accounts for public deployments
- Credentials are stored in `~/.altegio-mcp/credentials.json`

## Support

- **Issues**: https://github.com/altegio/altegio-pro-mcp/issues
- **API Docs**: https://developer.alteg.io
