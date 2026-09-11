# Releasing Altegio Pro MCP

The server uses Semantic Versioning. While the public contract is alpha, release
versions have the form `0.x.y-alpha.N`.

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` in the release
   pull request.
2. Run `npm run lint`, `npm run typecheck`, `npm test`, and
   `npm run catalog:check`.
3. Merge the reviewed pull request to `main` and wait for the production health
   check to report the new version.
4. Create the annotated Git tag `v<version>` on the merged commit and publish a
   GitHub prerelease from that tag.

Patch bumps fix behavior without intentionally changing tool contracts. Minor
bumps add or intentionally change tools, resources, prompts, or authentication
behavior. The first stable contract will be `1.0.0`.
