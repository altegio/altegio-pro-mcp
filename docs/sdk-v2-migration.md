# Staged SDK v2 migration

The runtime uses the official split SDK packages: server 2.4.0 and Node
adapter 2.1.2 (peer server `^2.4.0`, Node `>=20`). Client 2.4.0 and the old
SDK 1.32.2 are development-only compatibility clients. The committed
lockfile and Node 26.13.0 / 24.22.2 with npm 11.20.0 remain the supported
runtime matrix. Versions and APIs were checked on 2026-11-03 against npm
and the [official migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2.html).

`MCP_PROTOCOL_MODE=legacy` remains the default, preserving the production
2025-11-25 protocol posture and retained HTTP sessions until the architecture
ADR D7 platform canary passes. SDK package migration alone does not enable
the 2026 revision. `MCP_PROTOCOL_MODE=dual` opts HTTP into
`createMcpHandler` and stdio into `serveStdio`, serving both 2025-era clients
and protocol 2026-07-28 from the same server factory. Every dual HTTP request
gets a fresh instance; no session id is minted or retained. GET/DELETE legacy
session operations return 405. The existing `MCP_HTTP_MAX_SESSIONS` setting
caps concurrent dual HTTP exchanges; idle-session settings apply only to
legacy mode. Long-lived cross-call state still uses explicit application
handles and isolated credential/state directories.

The HTTP auth door, signed proxy admission, Host/Origin allowlists and
per-request identity/company scope run before either protocol entry. Tools
and resource handlers rebind identity from the v2 context's immutable HTTP
request. Handler cancellation reads `ctx.mcpReq.signal`; shutdown drains
accepted work before closing the SDK handlers. Tools, view boundaries,
dispatcher vocabulary, schemas, prompts and resources are unchanged.
The upstream rate window is shared per caller across fresh dual-mode
instances and views, with a bounded 10,000-caller cache; building a new SDK
instance does not reset the configured upstream request limit. Shutdown
and admission-stop signals propagate to per-request activity descendants.

Modern destructive calls use the existing argument/principal-bound
confirmation-token flow even if a client declares legacy form elicitation.
Push elicitation is unavailable in the modern protocol. Stateless legacy
HTTP requests also use tokens because no negotiated capability state is
retained. Legacy stdio and retained legacy HTTP sessions still negotiate and
use form elicitation. No request gains scope by confirming; scope and view
refusals precede the gate. A token repeat crosses independent requests and
must pass the same identity, scope, company and business preconditions.

Legacy-era cancellation is a compatibility limit of stateless HTTP: both
SDK v1 and v2 legacy clients send `notifications/cancelled` as a separate
request, which a fresh factory cannot correlate with the running exchange.
The caller stops awaiting its result, but work continues until its configured
deadline unless the host also closes the HTTP transport. Modern cancellation
and closing a legacy transport abort work and reclaim admission; the platform
canary tests both behaviors explicitly. Retained-session `legacy` mode keeps
its notification cancellation behavior. Do not claim cancellation parity for
a legacy host on `dual`; supported-host signoff must account for this limit
before rollout. The canary's success is not permission to ignore this gate.

## Rollout gate and rollback

This Pro PR must not be merged or deployed before the platform canary gate
passes: even `legacy` mode in this candidate uses the new SDK implementation.
Keeping the old protocol default provides a staged rollout after that gate;
it is not an exception to the gate.

The platform PR supplies `vm-services/sdk-v2-canary`: an isolated synthetic
backend on existing VM loopback, with no public route or business upstream.
Local and CI matrix results are **not** deployed-canary evidence. Before
Pro cutover, the coordinator must independently inspect and test both PRs,
deploy the reviewed platform canary on the existing VM, record its exact
commit/image, run old and modern SDK clients through the synthetic backend
and actual proxy code, and complete the bounded observation. The canary
README lists that evidence and its limits.

After that gate passes, first merge and deploy the split SDK packages with
`legacy` retained. Verify the exact revision/health, signed legacy protocol,
identity/refusal behavior and cancellation on both hosted lanes. This stage
updates the SDK implementation while preserving the established host protocol.
It does not claim real-host compatibility with the modern protocol.

Enabling `dual` is a separate subsequent rollout: inspect the actual supported
staff/customer hosts with synthetic calls and explicitly account for the
legacy notification-cancellation and elicitation differences above. Then
verify signed old/new protocol probes on both lanes and observe their behavior.
Keep the default and retained-session rollback path until that compatibility
is established. Rollback uses the previous verified Pro image and `legacy`
configuration. Local tests and the SDK-client matrix alone do not satisfy the
real-host gate for `dual`. This branch does not itself deploy either mode.

## Development dependency compatibility

Upstream Jest 30.5.2, ts-jest 29.4.15 and ESLint 10 still request vulnerable
glob/minimatch ranges. The lockfile overrides them to glob 14.0.3 and
minimatch 11.0.4, the supported fixed majors. These are deliberate cross-major
overrides, not a claim of upstream semver support. Dedicated tests exercise
Jest/Istanbul's real named CommonJS APIs, sync/async glob, braces/extglob,
ignored/hidden files, cancellation and the real `test-exclude` coverage
selector. Full lint, types, test/coverage and artifact checks on both Node
targets validate the actual consumers. Remove the overrides once the parent
packages declare fixed ranges and the same checks pass.

The remaining npm advisory is [deepmerge GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4),
one low-severity root reached only through Jest configuration. Rechecked on
2026-11-04: the installed Jest 30.5.2, jest-config 30.5.2 and ts-jest 29.4.15
are the latest supported releases; jest-config still requests deepmerge
`^4.3.1`, and 4.3.1 remains its latest published version.

The [authoritative CVE record](https://github.com/CVEProject/cvelistV5/blob/main/cves/2026/93xxx/CVE-2026-93753.json)
was **rejected by VulnCheck on 2026-11-02** because it does not describe a
security vulnerability. GitHub's advisory still has no withdrawal date or
patched version. The fresh lockfile audit therefore continues to report six
low affected entries, zero moderate/high/critical and zero runtime advisories.
Keep tracking the GitHub/npm metadata correction through the existing dependency
maintenance process; do not claim the npm audit is clean before it propagates.
No suppression, replacement package or Jest 25 downgrade is applied. Reassess
the actual consumers if upstream publishes a supported dependency fix instead.
