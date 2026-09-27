# Build and deployment

Pull requests run lint, formatting, type checking, tests, build, generated-surface
checks, and dependency auditing through `.github/workflows/ci.yml`.
Tests run on Node.js 20, 22, and 24. Merge with a merge commit after required
checks and reviews pass; do not bypass branch protection.

## Self-hosting

```sh
npm ci
npm run build
npm run start:http
```

Set the configuration described in `.env.example`. The HTTP service is designed
for a trusted authentication proxy. Keep its listener private and strip
caller-supplied identity headers before forwarding verified identity and scope.
See the authentication section of README.md before exposing it to a network.

For containers:

```sh
docker build -t altegio-pro-mcp .
docker run --rm --env-file .env -p 127.0.0.1:3000:3000 -e PORT=3000 altegio-pro-mcp
curl --fail http://localhost:3000/health
```

The image runs as a non-root user and includes the documentation served by MCP
resources. Keep credentials outside the image. Persist the configured credential
and onboarding directories if the deployment uses file-backed state.

## Maintained hosted service

Merges to main are picked up by the maintained deployment's automation. A green
CI run confirms a build, not a rollout: maintainers must verify the deployed Git
revision and `/health` after deployment. Infrastructure inventory, credentials,
and operational access instructions belong in the private deployment runbook.
