# CI and deployment

Public pull requests run without private API specifications or business
credentials. The primary runtime is Node.js 26.13.0 (bundled npm 11.20.0), and
Node.js 24.22.2 is the compatibility target. The image uses a digest-pinned
Node 26 Alpine base. Updating those pins is a reviewed compatibility change.

## Checks

| Check name              | Required behavior                                                                                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Quality`               | Recommended JS/TypeScript correctness lint, type-aware promises in runtime code, formatting, typechecking, example compilation and generated tool-surface drift |
| `Tests (Node 26)`       | Full default suite, public generator fixtures and coverage floors                                                                                               |
| `Tests (Node 24)`       | Full default suite on the compatibility runtime                                                                                                                 |
| `Artifacts`             | Build once; install/smoke the tarball; save/reload and smoke the same container image                                                                           |
| `Package (Node 24)`     | Verify checksums, install and smoke the Node 26-built tarball on Node 24                                                                                        |
| `Dependency audit`      | Fail high/critical advisories in the complete tree and any untriaged runtime advisory                                                                           |
| `CodeQL`                | JavaScript/TypeScript scanning, also run weekly                                                                                                                 |
| `Catalog (pinned spec)` | Separate trusted manual gate against an exact private snapshot and reviewed PR head                                                                             |

The first seven checks run for ordinary PRs. The last requires the protected
setup in [OPENAPI.md](OPENAPI.md). Do not make it a required check until that
setup has completed successfully on a reviewed candidate. Public CI explicitly
reports real-spec drift as **not run**; synthetic generator tests always run.
[Repository settings](.github/REPOSITORY_SETTINGS.md) records the proposed
required-check names, ownership constraints and settings changes; documentation
does not itself enforce merge protection.

Default Jest uses two workers with a 384 MB recycle threshold. Coverage runs
only on Node 26; its floors are rounded below the reviewed baseline. No live
suite runs in public CI. [TESTING.md](TESTING.md) describes opt-in live testing.

`npm run format:check` checks runtime sources. The expanded check is:

```sh
npx prettier --check .github scripts/catalog scripts/smoke scripts/quality \
  eslint.config.js jest.config.js README.md CONTRIBUTING.md CI-CD.md \
  RELEASING.md TESTING.md OPENAPI.md CLAUDE_DESKTOP_SETUP.md examples SECURITY.md
```

Actions are pinned to verified full commit SHAs. Dependabot proposes reviewed
weekly npm, Actions and container-base updates. `.github/dependency-advisories.json`
records short-lived runtime triage with an owner, reachability rationale and
expiry. Counts of vulnerable dependency entries are not counts of exploitable
production flaws. High/critical findings cannot be exempted by this file.

## Artifacts

CI stores the tested tarball, runtime CycloneDX SBOM, source revision and
checksums for seven days. Successful main runs also retain the tested container
archive and image ID; PR runs test and discard the larger image archive. `dist/build-provenance.json`
records the tarball's source revision, build Node version and lockfile hash.
These records are metadata, not a signed provenance attestation. Downloads must
come from the successful run for the exact reviewed source revision; never
promote arbitrary PR or `workflow_run` artifacts through a privileged workflow.
Tarball bytes are immutable, but installing one resolves its declared dependency
ranges. For the exact locked dependency tree, use `npm ci` from its source
revision or the verified container archive. The source-lock SBOM describes that
locked tree, rather than promising future tarball resolution will be identical.
Neither CI nor the release procedure publishes npm packages or container images.
See [RELEASING.md](RELEASING.md) for deliberate GitHub prerelease attachments.

## Self-hosting

```sh
npm ci
npm run build
npm run start:http
```

Configure the documented authentication mode and listener in `.env.example`
and [README.md](README.md#self-hosting-and-authentication). Keep a proxy-backed
listener private and strip caller-supplied identity headers before forwarding
verified identity and scope. Credential and onboarding state remain external.
Current session limits and idle policies are documented in README and configured
through `.env.example`; they are shared across HTTP views.

```sh
docker build --build-arg COMMIT_SHA="$(git rev-parse HEAD)" -t altegio-pro-mcp .
docker run --rm --env-file .env -p 127.0.0.1:3000:3000 -e PORT=3000 altegio-pro-mcp
curl --fail http://localhost:3000/health
```

The image runs as UID 1001 and includes runtime resources. `/health` must report
both the expected version and exact `commit`, matching the OCI revision label.
It binds to `0.0.0.0` inside the container; the published address above remains
loopback. A proxy deployment must configure its actual backend Host and browser
Origin allowlists before rollout. Local source execution defaults to loopback.

## Maintained hosted service

Merge reviewed PRs with a merge commit after required checks and independent
code review; do not bypass protection. The maintained deployment follows `main`.
A green CI run is not a rollout: verify the deployed image/revision and `/health`
through the private deployment runbook. Roll back to the previous verified
image/digest if health or revision checks fail, then verify that revision again.
