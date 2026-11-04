# Repository settings

The owner approved the following administrative changes on **3 November 2026**.
They were applied through the GitHub API and read back for verification.
Collaborator permissions and secrets were not changed.

## Active merge policy

The active [`main-reviewed-delivery` ruleset](https://github.com/altegio/altegio-pro-mcp/rules/26491479)
targets `refs/heads/main`, has no bypass actors and requires:

- a pull request, resolved review conversations and a merge commit;
- an up-to-date branch with successful `Quality`, `Tests (Node 26)`,
  `Tests (Node 24)`, `Artifacts`, `Package (Node 24)`, `Dependency audit` and
  `CodeQL analysis` checks, bound to `github-actions` (integration ID **15368**);
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

## Pending private-spec gate

On **4 November 2026**, the coordinator verified the `catalog-spec`
environment admits the main branch only, excludes tags and disables administrator
bypass. Its immutable archive URL and object-scoped WIF provider are provisioned
as environment secrets; no prior reviews or secrets were replaced.

The private organization-owned `altegio-catalog-gate` App (ID **5612704**) is
registered and installed on this repository only, with Metadata: read and Commit
statuses: write, no events and inactive webhooks. Its real permissions and
single-repository installation were independently verified, and only the missing
App ID/key were added to the existing environment. The first hosted OIDC
validation and the App-bound required status remain pending. Public
synthetic catalog fixtures run in every PR; exact real-spec drift remains a
manual release gate against [OPENAPI.md](../OPENAPI.md). F11 enforcement is
incomplete until the remaining reviewed setup is verified:

1. The dedicated status App is registered and independently verified. Preserve
   its repository-only access, the existing main-only `catalog-spec` environment and
   any configured reviewers/protection rules. New setup adds no mandatory human
   approval; independent exact-head review and deliberate trusted dispatch remain
   the delivery requirements.
2. Provision the App ID/private key and dedicated object-only OIDC access described
   in [OPENAPI.md](../OPENAPI.md#trusted-pinned-spec-gate). The private archive
   must be reachable by the trusted runner. The deterministic archive digest and
   extracted content digest are both pinned. Never publish the specification,
   archive URL or candidate-generated output.
3. Run the trusted workflow successfully for an exact reviewed PR head, then
   require `Catalog (pinned spec)` from that dedicated App's numeric integration
   ID. A new head invalidates the prior status. Do not bind this private check
   to the generic GitHub Actions App or substitute public fixture success.

The reviewed helpers in `scripts/catalog/{register-app,admin}.mjs` prepare the
one-time App registration, preserve configured environment reviews/secrets and
default administrative operations to inspection. Required-status activation
refuses an unverified App, stale head, failed trusted run or weakened existing
rules. Cloud provisioning remains a private coordinator-reviewed plan; no cloud
project/object identifiers or private archive are committed here. Local Docker
and fixture success is not proof of hosted OIDC access; record that first run
before calling this gate active.

Existing `live-e2e` opt-in business-test configuration is separate.

## Public profile

Description: **MCP server for authenticated Altegio B2B business workflows,
analytics and onboarding.** Homepage points to the repository README. Topics:
`mcp`, `model-context-protocol`, `altegio`, `typescript`, `business-management`.
Discussions remain disabled; questions use Issues. Sensitive reports use the
private channel documented in [SECURITY.md](../SECURITY.md).
