# Security policy

The latest `0.x.y-alpha.N` revision on `main` is the supported alpha line.
Node.js 26 is primary and Node.js 24 is the compatibility target. Older alpha
snapshots have no separate backport guarantee. Use a reviewed revision and read
its authentication/configuration guidance before exposing an HTTP listener.

## Reporting

Use **Report a vulnerability** on the repository's
[Security page](https://github.com/altegio/altegio-pro-mcp/security/advisories)
when private reporting is available. Include the affected revision, deployment
mode, impact and a minimal reproduction with synthetic data.

Private reporting was enabled and verified on 3 November 2026.
If the private-report button is unavailable, open a minimal
[contact-request issue](https://github.com/altegio/altegio-pro-mcp/issues/new)
asking the verified repository maintainer `@petroff` for a private reporting
channel. Include no exploit, credentials, client records or private URLs in that
public request. Share details only once a private channel is agreed.

Do not send live tokens or customer data with a reproduction. Acknowledgement
and resolution timing depend on impact and maintainer availability; no response
SLA is promised for the alpha.

## Maintenance

CI scans JavaScript/TypeScript with CodeQL and reviews dependency advisories.
A dependency entry is not itself evidence of an exploitable production defect:
triage records affected API reachability, an owner and an expiry. High/critical
advisories block CI, as does an untriaged runtime advisory. Secret scanning and
push protection are already enabled; never add a secret to a fixture to test
those controls. See [CI-CD.md](CI-CD.md) and
[repository settings](.github/REPOSITORY_SETTINGS.md).
