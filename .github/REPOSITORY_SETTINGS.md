# Repository settings

The owner approved the following administrative changes on **3 November 2026**.
They were applied through the GitHub API and read back for verification.
Collaborator permissions were not changed. Subsequent catalog setup is recorded
below.

## Active merge policy

The active [`main-reviewed-delivery` ruleset](https://github.com/altegio/altegio-pro-mcp/rules/26491479)
targets `refs/heads/main`, has no bypass actors and requires:

- a pull request, resolved review conversations and a merge commit;
- an up-to-date branch with successful `Quality`, `Tests (Node 26)`,
  `Tests (Node 24)`, `Artifacts`, `Package (Node 24)`, `Dependency audit` and
  `CodeQL analysis` checks, bound to `github-actions` (integration ID **15368**);
- `Catalog (pinned spec)` from the dedicated `altegio-catalog-gate` App
  (integration ID **5612704**), after exact-head review and trusted dispatch;
- blocked branch deletion and non-fast-forward updates.

Independent code review is a delivery requirement. The owner's autonomous
delivery policy keeps **zero mandatory GitHub approvals**; code-owner and
latest-push approval requirements are disabled. `CODEOWNERS` routes optional
review to verified collaborators `@petroff` and `@maksimn-altegio`. Adding a
mandatory human approval is a separate maintainer decision. If such a gate is
later enabled, automated review cannot satisfy it and must never bypass it.

The repository permits merge commits only and deletes merged branches.
The separate native `CodeQL` result comes from `github-advanced-security`
(integration ID **57789**), distinct from the required `CodeQL analysis` job.
Check names and sources were verified on real pull requests. Any future change
to a required job name must coordinate the workflow and ruleset.

## Security and Actions

Dependency alerts, Dependabot security updates, private vulnerability reporting
and full-SHA Action pin enforcement are enabled. Secret scanning and push
protection remain enabled. Workflow tokens remain read-only by default, Actions
cannot approve pull requests, and the Actions allowlist is unchanged.
Dependabot configuration covers npm, Actions and Docker.

CodeQL analysis has run successfully; the API returned no open code-scanning
alerts at verification. A successful scanner run does not replace review or
ongoing alert triage. No npm/image publishing permission is configured by this
remediation. Keep secrets out of ordinary and fork pull-request jobs.

## Required private-spec gate

On **4 November 2026**, the coordinator verified the `catalog-spec`
environment admits the main branch only, excludes tags and disables administrator
bypass. Its immutable archive URL and object-scoped WIF provider are environment
secrets. Existing secrets and protection rules were preserved when adding the
missing App ID/private key.

The private organization-owned `altegio-catalog-gate` App (ID **5612704**) is
installed on this repository only, with Metadata: read and Commit statuses:
write, no events and inactive webhooks. Its real permissions, owner and
single-repository installation were independently verified through the API;
private visibility and inactive webhooks were also checked in App settings.

The [first hosted trusted run](https://github.com/altegio/altegio-pro-mcp/actions/runs/41848241770)
ran from trusted main against the independently reviewed open PR #193 head
`362bb6f3099d6a6d5628a23dc1b5131339d8aa4f`. It verified OIDC access, retrieval of
the immutable archive, both pinned digests, isolated generator comparison,
private-material cleanup and temporary App-token revocation. It published no
private artifacts or candidate output.

After that success, ruleset **26491479** was read back with the eighth required
check, **`Catalog (pinned spec)`**, bound to App **5612704**. The seven existing
check sources, strict updates, zero mandatory GitHub approvals, no bypass,
review-conversation resolution, merge method and deletion/force-push protections
were preserved. A generic GitHub Actions status with this name cannot satisfy it.

Every new PR head requires independent review and a new deliberate dispatch of
`catalog-trusted.yml` **from main**, with the exact open PR number/SHA. Public
fixtures still run independently and do not replace this private check. Follow
[OPENAPI.md](../OPENAPI.md#trusted-pinned-spec-gate); preserve any environment
reviewers added later and wait for their approval. Never publish the private
specification, archive URL or candidate-generated output.

The coordinator helpers verify the real App installation and trusted run before
changing settings. Activation uses the individual commit-status API because the
combined-status response omits issuer metadata; a missing/wrong issuer or a newer
pending/failed status refuses activation. Cloud provisioning details and private
readbacks remain outside the public repository.

Existing `live-e2e` opt-in business-test configuration is separate.

## Public profile

Description: **MCP server for authenticated Altegio B2B business workflows,
analytics and onboarding.** Homepage points to the repository README. Topics:
`mcp`, `model-context-protocol`, `altegio`, `typescript`, `business-management`.
Discussions remain disabled; questions use Issues. Sensitive reports use the
private channel documented in [SECURITY.md](../SECURITY.md).
