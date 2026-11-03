# Repository settings proposal

Read-only GitHub API inspection on **3 November 2026** found:

- `main.protected=false`; branch protection returned 404 and effective rulesets
  were empty. Merge commit, squash and rebase methods were all enabled.
- Secret scanning and push protection enabled; dependency alerts, automated
  security fixes and private vulnerability reporting disabled. No CodeQL
  analysis was present. Discussions were disabled.
- Default workflow token permissions were read-only, PR review approval by
  Actions disabled, all Actions allowed and SHA pin enforcement disabled.
- Repository description/homepage were empty and topics were absent.

No settings or collaborator permissions were changed by this remediation.
These are exact proposed maintainer deltas, to apply after independent review.

## Main ruleset

Create an **active branch ruleset** named `main-reviewed-delivery`, target
`refs/heads/main`, with no routine bypass actors. Require:

- pull requests and resolution of review conversations, with **zero required
  GitHub approvals** to preserve the owner's autonomous delivery policy;
  independent code review remains a documented delivery requirement. Keep
  code-owner approval and latest-push approval requirements disabled;
- required checks, with strict/up-to-date branch policy:
  `Quality`, `Tests (Node 26)`, `Tests (Node 24)`, `Artifacts`,
  `Package (Node 24)`, `Dependency audit`, `CodeQL analysis`;
- non-fast-forward updates and deletion blocked. Do not require linear history:
  the delivery method uses merge commits.

The seven checks above come from `github-actions` (integration ID **15368**).
The separate native `CodeQL` result comes from `github-advanced-security`
(integration ID **57789**); it is distinct from the `CodeQL analysis` job.
Those names/sources were verified on PR #182.

Use the check names above as emitted by the workflows, not their job IDs or
older `lint`, `test (22)` and `build` names. Bind status sources to GitHub Actions
where the ruleset UI supports that integration. First confirm every exact name
on a real PR; do not add a required name that has never run.

After the protected `catalog-spec` environment and a successful dispatched run
are verified, also require **`Catalog (pinned spec)`**, posted to the reviewed
PR head SHA, with `integration_id` set to the dedicated status App's numeric
App ID (not its installation ID or the generic GitHub Actions App). Until that setup is available, real drift remains an explicit manual
release gate and F11 enforcement is incomplete. A new PR head invalidates the
previous SHA-bound status. Do not substitute public fixture success for it.

Set `allow_merge_commit=true`, `allow_squash_merge=false`,
`allow_rebase_merge=false`; keep `delete_branch_on_merge=true`. Do not enable
admin bypass as a way to work around missing reviews. Emergency changes still
need a reviewed PR unless a separate, audited emergency policy is deliberately
approved.

`CODEOWNERS` uses verified current admin collaborators `@petroff` and
`@maksimn-altegio` for optional review routing. A mandatory independent human
approval, code-owner approval or latest-push approval would be a separate
maintainer decision: an automated review summary cannot satisfy those GitHub
gates. Never bypass an active review requirement. Existing administrator
membership was observed, not changed; collaborator access is separate work.

## Security and Actions

Enable dependency alerts, Dependabot security updates and GitHub private
vulnerability reporting. Keep secret scanning/push protection enabled and the
read-only workflow-token default. The new reviewed Dependabot configuration
covers npm, Actions and Docker. The CodeQL workflow uploads public-repo scanning
results; verify its first analysis and consider a separately reviewed code-
scanning merge rule if desired. A successful scanner run alone does not establish
that no alert requires triage.

Enable SHA pin enforcement after verifying every workflow action is pinned.
Do not change the Actions allowlist without inventorying the pinned Actions in
CI, Security, Live and Trusted catalog. No publishing permission is needed.
Keep environment secrets out of fork/ordinary PR jobs.

Create a dedicated GitHub App with Commit statuses: write and install it only on
this repository; no contents-write or administration permission is needed. Create
`catalog-spec` with main-only deployment branches, an independent required
reviewer and self-review prevention, then provision its App ID/private key and
read-only archive secrets as described in [OPENAPI.md](../OPENAPI.md#trusted-pinned-spec-gate). The private
archive must be reachable by the trusted runner. Existing `live-e2e` opt-in
business-test configuration is separate and is not required for public CI.

## Public profile

Set description to **"MCP server for authenticated Altegio B2B business workflows,
analytics and onboarding."**, homepage to the repository README, and topics to
`mcp`, `model-context-protocol`, `altegio`, `typescript`, `business-management`.
Keep Discussions disabled unless maintainers deliberately choose to moderate it;
public guides now route questions to Issues. The security policy explains the
current private-reporting activation gap without inventing a security email.
