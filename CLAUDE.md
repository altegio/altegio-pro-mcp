# Altegio.Pro MCP Server - Project Context

## Overview
MCP (Model Context Protocol) server for Altegio.Pro business management API.
- **Target users**: Local service business owners, administrators and team members
- **Focus**: B2B authenticated operations only (no public B2C booking)
- **Tech**: TypeScript, @modelcontextprotocol/sdk, Express for HTTP mode
- **Package**: `@altegio/mcp-server-pro` (not published to npm)

## Workflow

**Before starting ANY new task:**

1. **Pull latest OpenAPI spec:**
   ```bash
   git -C api.docs pull origin master
   ```
2. **Check OpenAPI spec first:** `api.docs/docs/altegio/en/openapi.yml`
3. **NEVER modify `api.docs/`** - read-only submodule (managed in separate GitLab repo)
4. **Read Product logic** - `docs/*.md`

## Quick Start

**Tech Stack:** TypeScript, @modelcontextprotocol/sdk, Express (HTTP mode), Jest

**Build & Run:**
```bash
npm install
npm run build
npm start                    # stdio mode (Claude Desktop)
npm run dev                  # HTTP mode on port 8080
```

**Test:**
```bash
npm test                     # run tests
npm run test:watch           # watch mode
npm run lint                 # check code style
npm run typecheck            # TypeScript validation
```

### File Structure

```
src/
  core/          # MCP server initialization
  providers/     # API clients (altegio-client.ts)
  tools/         # Tool handlers & registry
  types/         # TypeScript interfaces
  utils/         # Logging, errors, config
  index.ts       # stdio entry
  http-server.ts # HTTP entry

tests/           # Jest tests
docs/plans/      # Design docs (keep latest refactoring only)
dist/            # Built JS (gitignored)
```

**Build & Deploy:**
Always check BUILD.md / never add it to Git

---

## Project description

### What This Server Does

MCP server for **B2B business management only** (Altegio.Pro, not public booking /b2c). Local service business business owners, admins and team members manage their operations through authenticated tools

### Tools Available (33 total)

**Category-organized with [Prefix] tags for LLM navigation:**

**[Auth] Authentication (2):** login, logout
**[Company] Company (1):** list_companies
**[Staff] Staff CRUD (4):** get, create, update, delete
**[Positions] Positions CRUD (4):** get, create, update, delete
**[Services] Services (3):** get, create, update
**[Categories] Service Categories (1):** get
**[Schedule] Schedule CRUD (4):** get, create, update, delete
**[Bookings] Bookings CRUD (4):** get, create, update, delete
**[Onboarding] Wizard (10):** start, resume, status, batch imports, preview, rollback

### Architecture

**Transports:**
- **stdio** (default) → `dist/index.js` → Claude Desktop integration
- **HTTP** → `dist/http-server.js` → Local on port 8080
  - `/health` - health check
  - `/sse` - Server-Sent Events (OpenAI/Perplexity)
  - `/rpc` - JSON-RPC 2.0
  - `/mcp` - MCP SSE

**Authentication:**
- Partner token: `ALTEGIO_API_TOKEN` (required, from https://developer.alteg.io)
- User token: obtained via `altegio_login`, saved to `~/.altegio-mcp/credentials.json`
- API headers: `Authorization: Bearer {partner_token}`, `User-Token: {user_token}` (To access internal information)

**Key Files:**
- `src/index.ts` - stdio entry point
- `src/http-server.ts` - HTTP server entry point
- `src/providers/altegio-client.ts` - API client (auth, retry, rate-limit)
- `src/tools/handlers.ts` - tool implementations
- `src/tools/registry.ts` - MCP tool definitions
- `src/types/altegio.types.ts` - TypeScript types
- `src/utils/` - logging, errors, config, credential manager

### Change history

**Positions Management CRUD (2025-10-30)**
- **Added 4 tools:** get_positions, create_position, update_position, delete_position
- Full CRUD for staff positions/roles (Manager, Stylist, Receptionist, etc.)
- Essential for onboarding - positions must be created before assigning staff
- Uses /positions/{company_id} endpoints
- All operations require user_token authentication

**Schedule Management CRUD (2025-10-30)**
- **Added 3 tools:** create_schedule, update_schedule, delete_schedule
- Full CRUD for employee work schedules (when staff works, not appointments)
- Uses PUT /schedule/{company_id} endpoint for create/update
- Uses DELETE /schedule/{company_id}/{staff_id}/{date} for deletion
- All operations require user_token authentication

**Altegio.Pro B2B Refactoring**
- **Removed 5 B2C tools:** get_company, get_booking_dates, get_booking_staff (no B2B alternatives)
- **Updated 2 tools to B2B:** get_staff, get_services (now require user_token)
- **Added 1 tool:** get_schedule (new admin schedule management)
- **Kept 1 public tool:** get_service_categories (only version available in API)
- All operations except login/logout now require user_token
- Implementation method: Test-driven development (write failing test → implement → verify)
- Breaking change: B2C users have no access (intentional rebranding)

### API Reference

**Base URL:** `https://api.alteg.io/api/v1`
**Docs:**
- Online: https://developer.alteg.io/api (cached at `/tmp/alteg_api.html`)
- **OpenAPI Spec (corporate):** `api.docs/docs/altegio/en/openapi.yml` (see OPENAPI.md for setup)

**B2B Endpoints (require user_token):**
- `GET /staff/{company_id}` - staff with admin details
- `GET /company/{company_id}/services` - services list (optional service_id)
- `GET /records/{company_id}` - bookings/appointments
- `GET /schedule/{company_id}/{staff_id}/{start_date}/{end_date}` - view employee schedule
- `PUT /schedule/{company_id}` - create/update employee work schedule
- `DELETE /schedule/{company_id}/{staff_id}/{date}` - delete employee work schedule

**Public Endpoint (partner_token only):**
- `GET /service_categories/{company_id}` - categories (no auth alternative)

### Common Patterns

**Authentication check in handlers:**
```typescript
if (!this.client.isAuthenticated()) {
  throw new Error('Authentication required');
}
```

**Authentication check in client methods:**
```typescript
async getStaff(companyId: number) {
  if (!this.userToken) {
    throw new Error('Not authenticated');
  }
  // ... API call
}
```

**Secrets Management:**
- Local: `.env` file (gitignored)
- Never commit tokens to git


**Test isolation:**
- Tests default to `~/.altegio-mcp/` credentials
- Pass `testDir` parameter to use isolated test directory:
  ```typescript
  new AltegioClient(config, testDir)
  ```

---

## Environment Variables

```bash
# Required
ALTEGIO_API_TOKEN=your_partner_token

# Optional
ALTEGIO_API_BASE=https://api.alteg.io/api/v1
NODE_ENV=development|production
LOG_LEVEL=debug|info|warn|error
PORT=8080
CREDENTIALS_DIR=~/.altegio-mcp
RATE_LIMIT_REQUESTS=200
MAX_RETRY_ATTEMPTS=3
```

---

## Documentation

- `README.md` - main user documentation
- `CONTRIBUTING.md` - contribution guidelines
- `CI-CD.md` - deployment pipeline details
- `CLAUDE_DESKTOP_SETUP.md` - local Claude Desktop setup
- `TESTING.md` - testing guide
- `OPENAI_PLATFORM.md` - OpenAI/ChatGPT integration
- `OPENAPI.md` - OpenAPI specification setup (corporate)