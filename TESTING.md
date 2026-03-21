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

The server uses **SSE transport** for MCP. The protocol requires keeping the SSE connection open while sending POST requests to the session URL.

**Step 1: Establish SSE connection** (keep this terminal open):

```bash
curl -sN http://localhost:8080/mcp -H "Accept: text/event-stream"
# Returns: event: endpoint
#          data: /mcp?sessionId=<SESSION_ID>
```

**Step 2: In another terminal, send MCP requests** using the session ID from step 1:

```bash
SESSION_ID="<paste session id from step 1>"

# Initialize MCP handshake
curl -s -X POST "http://localhost:8080/mcp?sessionId=$SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {"name": "manual-test", "version": "1.0"}
    }
  }'

# Send initialized notification
curl -s -X POST "http://localhost:8080/mcp?sessionId=$SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}'

# List all available tools
curl -s -X POST "http://localhost:8080/mcp?sessionId=$SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}'

# Call a tool (e.g., list_companies)
curl -s -X POST "http://localhost:8080/mcp?sessionId=$SESSION_ID" \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "list_companies",
      "arguments": {"count": 5}
    }
  }'
```

All responses arrive via the SSE stream in the first terminal.

### 5. Automated MCP Test Script

```bash
python3 -c "
import subprocess, json, time, re, threading, queue

q = queue.Queue()

def read_sse(proc, q):
    for line in proc.stdout:
        q.put(line.rstrip('\n'))

sse = subprocess.Popen(
    ['curl', '-sN', 'http://localhost:8080/mcp', '-H', 'Accept: text/event-stream'],
    stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
)
t = threading.Thread(target=read_sse, args=(sse, q), daemon=True)
t.start()
time.sleep(1)

session_id = None
while not q.empty():
    line = q.get()
    m = re.search(r'sessionId=([a-f0-9-]+)', line)
    if m:
        session_id = m.group(1)

if not session_id:
    print('FAIL: No session ID')
    sse.kill()
    exit(1)

BASE = f'http://localhost:8080/mcp?sessionId={session_id}'

def post(payload):
    subprocess.run(['curl', '-s', '-X', 'POST', BASE,
        '-H', 'Content-Type: application/json',
        '-d', json.dumps(payload)], capture_output=True, text=True)

def wait_response(req_id, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            line = q.get(timeout=0.5)
            if line.startswith('data: '):
                data = json.loads(line[6:])
                if data.get('id') == req_id:
                    return data
        except:
            pass
    return None

# Initialize
post({'jsonrpc':'2.0','id':1,'method':'initialize',
    'params':{'protocolVersion':'2024-11-05','capabilities':{},
        'clientInfo':{'name':'test','version':'1.0'}}})
r = wait_response(1)
print(f'1. Initialize: {'OK' if r and 'result' in r else 'FAIL'}')

post({'jsonrpc':'2.0','method':'notifications/initialized','params':{}})
time.sleep(0.5)

# List tools
post({'jsonrpc':'2.0','id':2,'method':'tools/list','params':{}})
r = wait_response(2)
tools = r.get('result',{}).get('tools',[]) if r else []
print(f'2. Tools list: {len(tools)} tools found {'(OK)' if len(tools) > 0 else '(FAIL)'}')

# Call list_companies
post({'jsonrpc':'2.0','id':3,'method':'tools/call',
    'params':{'name':'list_companies','arguments':{'count':3}}})
r = wait_response(3, 15)
has_result = r and 'result' in r and not r.get('result',{}).get('isError')
print(f'3. list_companies: {'OK' if has_result else 'FAIL'}')

sse.kill()
print('Done!')
"
```

## Cloud Run Testing

After deploying to Cloud Run (see [CI-CD.md](CI-CD.md)):

```bash
SERVICE_URL="https://your-service-name.run.app"

# Health check
curl $SERVICE_URL/health

# MCP SSE connection
curl -sN $SERVICE_URL/mcp -H "Accept: text/event-stream"
```

The MCP protocol flow is the same as local — establish SSE, then POST to the session endpoint.

## Integration Testing

### Claude Desktop

Native stdio transport. See [CLAUDE_DESKTOP_SETUP.md](CLAUDE_DESKTOP_SETUP.md).

### OpenAI Platform / ChatGPT

SSE transport via Cloud Run URL. See [OPENAI_PLATFORM.md](OPENAI_PLATFORM.md).

## Security Notes

- Never commit API tokens to git
- Use `.env` file (gitignored) for local credentials
- Use test accounts for public deployments
- Credentials are stored in `~/.altegio-mcp/credentials.json`

## Support

- **Issues**: https://github.com/altegio/altegio-pro-mcp/issues
- **API Docs**: https://developer.alteg.io
