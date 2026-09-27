# Contributor guidance

Read [CONTRIBUTING.md](CONTRIBUTING.md), [TESTING.md](TESTING.md), and the
[architecture decisions](docs/architecture/2026-09-07-mcp-platform-architecture.md).

- Use a feature branch and a pull request. Preserve concurrent work.
- Use `npm ci` and the committed lockfile.
- Keep backend wire names inside adapters; public tools use the product glossary.
- Collection tools must bound output and expose continuation metadata.
- Never hand-edit `src/generated/catalog.json` or the generated tool surface.
- Run lint, typecheck, tests, build, and the catalog/surface checks before delivery.
- Live tests are opt-in and require a disposable test location.
- Keep credentials, workstation paths, deployment inventories, and agent session
  state out of commits and release artifacts.

## MCP servers

Project MCP servers are declared in `.mcp.json` (altegio-pro, altegio-bi-data) and auto-approved via `.claude/settings.json`. First use on a machine: `/mcp` → Authenticate (Google). claude.ai connectors this project normally needs: Slack. Every other connector (Notion, Gmail, Google Drive, Atlassian, Whisper Flow, Kommo, Cognee) stays off by default; enable one for the current session only when the task needs it.
