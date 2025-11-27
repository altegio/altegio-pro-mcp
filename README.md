# Altegio.Pro MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-1.0-green)](https://modelcontextprotocol.io)

MCP server for Altegio.Pro business management API - B2B integration for salon/spa owners and administrators.

**Target users:** Business owners managing their Altegio companies
**Authentication:** All operations require user login (obtained via `altegio_login`)
**Focus:** Administrative B2B operations only (no public booking features)

## Features

- **33 MCP tools** including 10 onboarding wizard tools for first-time setup
- **CRUD operations** for staff, services, bookings, schedules, and positions management
- **Conversational onboarding** with bulk CSV/JSON import and checkpoint/resume
- **Dual transport:** stdio for Claude Desktop, HTTP for cloud deployments
- **TypeScript** with full type safety and comprehensive tests (145 passing)
- **Auto-deploy CI/CD** via Cloud Build on push to main
- **Rate limiting** and **retry logic** with exponential backoff
- **Secure credential storage** in `~/.altegio-mcp/`

## Available Tools

**33 tools organized by category** for complete business management:

### 🔐 Authentication
- `altegio_login` - Authenticate with email/password
- `altegio_logout` - Clear stored credentials

### 🏢 Company Management
- `list_companies` - Get managed companies (requires auth)

### 👥 Staff Management
- `get_staff` - View employees with admin details
- `create_staff` - Add new employee
- `update_staff` - Modify employee details
- `delete_staff` - Remove employee

### 📋 Positions Management
- `get_positions` - List company positions/roles
- `create_position` - Create new position (Manager, Stylist, etc.)
- `update_position` - Modify position details
- `delete_position` - Remove position

### 🛎️ Services Management
- `get_services` - View all services with configuration
- `get_service_categories` - View service categories
- `create_service` - Add new service
- `update_service` - Modify service details

### 📅 Schedule Management
- `get_schedule` - View employee work schedules
- `create_schedule` - Set employee work hours
- `update_schedule` - Modify work schedule
- `delete_schedule` - Remove schedule entry

### 📖 Bookings Management
- `get_bookings` - View appointments
- `create_booking` - Create client appointment
- `update_booking` - Modify existing appointment
- `delete_booking` - Cancel appointment

### 🚀 Onboarding Wizard
**Conversational first-time setup assistant:**
- `onboarding_start` - Initialize setup session
- `onboarding_resume` - Resume interrupted setup
- `onboarding_status` - Check progress
- `onboarding_add_categories` - Bulk create service categories
- `onboarding_add_staff_batch` - Bulk import staff (CSV/JSON)
- `onboarding_add_services_batch` - Bulk import services (CSV/JSON)
- `onboarding_import_clients` - Import client database
- `onboarding_create_test_bookings` - Generate sample data
- `onboarding_preview_data` - Validate before import
- `onboarding_rollback_phase` - Undo specific phase

**Note:** Services DELETE operation is not available in Altegio API. All write operations require user authentication via `altegio_login`. See [Onboarding Guide](docs/ONBOARDING_GUIDE.md) for first-time setup workflows.

## Quick Start

### Prerequisites

- Node.js >= 18
- Altegio Partner Token from [developer.alteg.io](https://developer.alteg.io)

### Installation

```bash
git clone https://github.com/altegio/altegio-pro-mcp.git
cd altegio-mcp
npm install
cp .env.example .env
# Edit .env and add ALTEGIO_API_TOKEN
npm run build
```

### Claude Desktop Setup

1. Build the server: `npm run build`
2. Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "altegio-pro": {
      "command": "node",
      "args": ["/absolute/path/to/altegio-mcp/dist/index.js"],
      "env": {
        "ALTEGIO_API_TOKEN": "your_partner_token"
      }
    }
  }
}
```

3. Restart Claude Desktop

See [CLAUDE_DESKTOP_SETUP.md](CLAUDE_DESKTOP_SETUP.md) for detailed setup.

## Onboarding Wizard

**New in v2.0:** Conversational assistant for first-time platform setup. Import staff, services, and clients through natural language or bulk CSV upload.

### Quick Onboarding Flow

```typescript
// 1. Login and start
altegio_login({ email: "owner@salon.com", password: "..." })
onboarding_start({ company_id: 123456 })

// 2. Create categories
onboarding_add_categories({
  company_id: 123456,
  categories: [
    { title: "Hair Services" },
    { title: "Nail Services" }
  ]
})

// 3. Import staff (CSV or JSON)
onboarding_add_staff_batch({
  company_id: 123456,
  staff_data: `name,specialization,phone
Alice Johnson,Senior Stylist,+1234567890
Bob Smith,Nail Technician,+1234567891`
})

// 4. Add services
onboarding_add_services_batch({
  company_id: 123456,
  services_data: [
    { title: "Haircut", price_min: 50, duration: 60 },
    { title: "Manicure", price_min: 30, duration: 45 }
  ]
})

// 5. Import clients
onboarding_import_clients({
  company_id: 123456,
  clients_csv: `name,phone,email
Sarah Miller,+1234560001,sarah@example.com
John Davis,+1234560002,john@example.com`
})

// 6. Generate test bookings
onboarding_create_test_bookings({ company_id: 123456, count: 5 })

// 7. Check progress
onboarding_status({ company_id: 123456 })
```

**Key Features:**
- **Checkpoint/Resume:** Automatically recovers from errors or interruptions
- **Hybrid Input:** Accept JSON arrays or CSV strings
- **Preview Mode:** Validate data before importing (`onboarding_preview_data`)
- **Rollback:** Undo specific phases (`onboarding_rollback_phase`)
- **Progress Tracking:** View completion status (`onboarding_status`)

**Time Savings:** 5-10 minutes vs 30+ minutes manual setup

See [docs/ONBOARDING_GUIDE.md](docs/ONBOARDING_GUIDE.md) for complete guide with CSV templates, error handling, and troubleshooting.

### Cloud Deployment

Automatic deployment to Cloud Run on push to `main`. See [CI-CD.md](CI-CD.md) for:
- GitHub → Cloud Build → Artifact Registry → Cloud Run pipeline
- Local Docker testing
- Secret management

```bash
# Local Docker test
docker build -t altegio-mcp:local .
docker run --rm -p 8080:8080 --env-file .env altegio-mcp:local
```

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ALTEGIO_API_TOKEN` | Yes | - | Partner API token |
| `ALTEGIO_API_BASE` | No | `https://api.alteg.io/api/v1` | API base URL |
| `LOG_LEVEL` | No | `info` | `debug\|info\|warn\|error` |
| `NODE_ENV` | No | `development` | `development\|production` |
| `RATE_LIMIT_REQUESTS` | No | `200` | Max requests per minute |

## Development

```bash
npm install          # Install dependencies
npm run dev          # Dev mode with hot reload
npm run build        # Build TypeScript
npm test             # Run tests
npm run test:watch   # Watch mode
npm run lint         # Check code style
```

### Project Structure

```
src/
  config/        # Configuration and validation
  providers/     # API clients (altegio-client.ts)
  tools/         # MCP tool handlers & registry
  types/         # TypeScript interfaces
  utils/         # Logging, errors, helpers
  __tests__/     # Jest unit tests
  index.ts       # stdio server entry
  http-server.ts # HTTP server entry
  server.ts      # Shared MCP server setup
```

### Testing

- **68 tests** covering authentication, all tools, error handling, pagination
- **Jest** for unit tests with mocked API responses
- **Test isolation** with temporary credentials directory
- Run: `npm test` or `npm run test:coverage`

## Integrations

- **Claude Desktop:** Native stdio transport (recommended)
- **OpenAI/ChatGPT:** SSE transport - see [OPENAI_PLATFORM.md](OPENAI_PLATFORM.md)
- **Other LLMs:** JSON-RPC endpoint at `/rpc`

## API Reference

Base URL: `https://api.alteg.io/api/v1`
Documentation: [developer.alteg.io/api](https://developer.alteg.io/api)

**Authentication:**
- Partner token: `Authorization: Bearer {token}`
- User token: `User-Token: {token}` (obtained via `altegio_login`)

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for:
- Development setup
- Coding standards (TypeScript, Prettier, ESLint)
- Testing guidelines
- Commit conventions

Quick contribution flow:
1. Fork and create feature branch
2. Add tests for new features
3. Ensure `npm test` and `npm run lint` pass
4. Submit PR with clear description

## License

MIT License - see [LICENSE](LICENSE) file

## Support

- **Issues:** [GitHub Issues](https://github.com/altegio/altegio-pro-mcp/issues)
- **Discussions:** [GitHub Discussions](https://github.com/altegio/altegio-pro-mcp/discussions)
- **Altegio API:** [support.alteg.io](https://support.alteg.io)

## Acknowledgments

Built with [Model Context Protocol](https://modelcontextprotocol.io) by Anthropic and [Altegio API](https://developer.alteg.io) for salon/spa management.
# Test staging trigger
