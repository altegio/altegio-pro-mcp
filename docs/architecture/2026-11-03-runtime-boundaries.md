# Runtime boundaries after the open-source audit

This change addresses F01, F04, F06, F07 and F14, and stages the runtime and
dependency parts of F08/F10. F09 remains incomplete: the SDK is patched on v1,
and this change does not claim support for protocol revision 2026-07-28.

## HTTP modes and deployment compatibility

Without an explicit `MCP_HTTP_MODE`, an existing configured proxy signing key or
`REQUIRE_DELEGATED_IDENTITY=true` selects `hosted`; otherwise the mode is `local`.
This preserves the existing signed-proxy listener and direct-token lane.

| Setting                                  | Behavior                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_HTTP_MODE=local`                    | Bind loopback by default. Anonymous requests can initialize and inspect the static tool surface, but cannot borrow a stored user credential.                                                                                                                  |
| `MCP_HTTP_MODE=hosted`                   | Bind all interfaces by default for the existing private proxy/container lane. Require a signed proxy request or a direct Altegio token before MCP dispatch. Delegated headers require a valid backend signature.                                              |
| `MCP_HTTP_HOST`                          | Explicit listener address; defaults to `127.0.0.1` locally and `0.0.0.0` when hosted.                                                                                                                                                                         |
| `MCP_HTTP_ALLOWED_HOSTS`                 | Additional comma-separated hostnames, without ports. Default hosts are `localhost`, `127.0.0.1`, `[::1]`, and the public base hostname when hosted. Proxies preserving another backend Host must name it here. Forwarded Host headers do not widen this list. |
| `MCP_HTTP_ALLOWED_ORIGINS`               | Additional comma-separated exact HTTP(S) origins. Hosted defaults include the public base origin; local defaults allow no browser Origin. Absent Origin is supported. Opaque `null`, paths and wildcard origins are invalid configuration.                    |
| `MCP_HTTP_ALLOW_SHARED_CREDENTIALS=true` | Deliberate legacy local HTTP opt-in for the single-user token/file fallback. An explicit delegated-identity requirement still disables it. Hosted admission still requires caller authentication.                                                             |

Host and Origin checks run before OAuth lookup and body parsing, for both session
and stateless requests, including GET and DELETE. Routes are case-sensitive so
Express cannot expose an uppercase alias outside those guards. Stdio remains single-user.
Location, chain, scope, read-only and confirmation checks retain their existing
execution boundaries. Direct user tokens never acquire another caller's identity.

Before rollout, inventory the actual backend Host and browser Origin values in
the private proxy configuration and set the allowlists accordingly. The default
public-base hostname is a configuration value, not a discovery of proxy behavior.

## Upstream budgets and lifecycle

`ALTEGIO_REQUEST_TIMEOUT_MS` defaults to 30 seconds (100 ms–120 seconds). One
budget covers rate admission, retry backoff, headers and consumption/cancellation
of the final response body. It applies to API adapters and the legacy ERP web
lane. `RATE_LIMIT_REQUESTS` / `RATE_LIMIT_WINDOW_MS` now control sliding-window
admission on each client instance; every attempt, including a write, counts.
This is an upstream client limit, not a process-wide caller quota.

`MAX_RETRY_ATTEMPTS` is the number of additional read attempts, defaults to one,
and is bounded at five. `INITIAL_RETRY_DELAY_MS` defaults to 150 ms;
`MAX_RETRY_DELAY_MS` defaults to 5 seconds. Network retries use capped exponential
backoff. Read-only 429 retries also respect the existing conservative five-second
`Retry-After` ceiling. All waits consume the same request budget. Writes, explicit
cancellation and timeouts are never automatically replayed.

MCP's explicit cancellation signal is rebound at actual tool dispatch, alongside
the existing per-request identity context in compiled ESM. A socket disconnect
alone does not mean an upstream operation was cancelled or rolled back. A
disconnected stateless operation retains its admission lease until it settles.

OAuth resource/profile resolution shares one in-flight lookup per token hash.
At most 32 distinct lookups run concurrently, with one ten-second budget for the
pair; overflow returns 503. Failures are removed immediately. Fresh checks before
local-state access use the same admission and deduplication, while bypassing
completed cached grants. Eviction also invalidates an in-flight result.

`MCP_SHUTDOWN_TIMEOUT_MS` defaults to 30 seconds (100 ms–120 seconds). HTTP marks
health/readiness as draining, rejects new MCP work, closes admissions, waits for
actual tool work and responses, then closes servers and transports. The deadline
aborts remaining upstream work and destroys sockets. Stdio stops tool admission
and pauses input while draining. Signal handlers are installed only by startup,
and importing either entry module has no startup or signal-registration effect.

The native Node `getCallSites` API identifies the calling module for the entry
check and compares real paths, including npm bin symlinks. This also works with
the repository's CommonJS Jest transform without adding an `import.meta`
transformer or testing a different entrypoint implementation.

## Supported stack and remaining work

The package supports Node 24 and 26, with Node 26 the primary deployment target,
and npm 11 (`packageManager: npm@11.19.0`). Node 20/22 and odd-numbered releases
are outside the new advertised range. TypeScript 6.0.3 keeps the compiler API and
fits ts-jest 29.4.15's `>=4.3 <7` peer requirement. Cheerio 1.2 and compatible
dependency updates are validated against the existing parser fixtures.

SDK 1.32.2 is a maintenance patch, not the v2 migration. The
[official v2 migration guide](https://ts.sdk.modelcontextprotocol.io/v2/migration/upgrade-to-v2)
requires coordinated low-level handler registration and context changes:
`extra.signal` moves to `ctx.mcpReq.signal`, HTTP identity headers come from a Web
Request, and elicitation and legacy-era serving require explicit adaptation.
Follow-up work must cover `src/tools/registry.ts`, confirmation helpers,
resource/prompt registries, all SDK-importing tests and eval clients, and the
Node HTTP transport package. It must test legacy initialized hosts, stateless
calls, stdio, compiled identity isolation, cancellation, and both confirmation
paths before removing the v1 dependency. These interfaces were deliberately not
partially migrated alongside the runtime fixes.

Production dependency auditing is clean after the compatible updates. Three
development-only advisory roots remain, propagated through the installed Jest
and lint tools:

| Advisory                                                                               | Reachability and disposition                                                                                                      |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [deepmerge prototype poisoning](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)     | Jest configuration merging; development only, trusted repository config. Await a supported upstream dependency update.            |
| [glob cancellation traversal](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)       | Test/lint filesystem traversal; development only. Request budgets do not depend on this package. Await an upstream update.        |
| [minimatch globparts amplification](https://github.com/advisories/GHSA-g3hv-75wg-m249) | Test/lint file patterns; development only, repository-controlled patterns. Await compatible upstream adoption of the fixed major. |

The audit solver proposes an unsupported Jest 25 downgrade for these chains.
No forced fix, major transitive override or advisory suppression is introduced.
Maintainers must keep the development exceptions under the repository's reviewed
advisory policy; this runtime change does not configure alerts or access settings.
