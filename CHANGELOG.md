# Changelog

All notable changes to this project will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- [#200](https://github.com/mohanagy/miftah/issues/200) Reworked the README into a task-oriented first-use guide with complete Claude Desktop setup, authentication-path selection, generic MCP onboarding, profile-management tools, native versus upstream-owned OAuth, dashboard lifecycle, everyday diagnostics/audit commands, and focused security-control guidance; corrected stale configuration-version guidance to identify v3 as current while preserving an explicit v1/v2 removal window.

## [0.4.0] - 2026-07-23

### Added

- [#81](https://github.com/mohanagy/miftah/issues/81) Added configuration format v3 and a strict, non-secret OAuth connection core: opaque profile/upstream/resource/issuer bindings, canonical HTTPS Streamable HTTP validation, static-Authorization collision refusal, OS-vault credential isolation, crash-released binding-scoped transaction coordination, redacted lifecycle primitives, and v1/v2-to-v3 migration with no credential synthesis.
- [#82](https://github.com/mohanagy/miftah/issues/82) Enabled standards-compatible OAuth for exact v3 HTTPS Streamable HTTP connections: protected-resource plus authorization-server/OpenID discovery, explicit pre-registered, Client ID Metadata, or Dynamic Client Registration, system-browser PKCE authorization through a single-use literal-loopback callback, RFC 9207 issuer validation, profile-bound OS-vault credentials, refresh and reconnect, typed redacted failures, and unchanged non-OAuth transport behavior. Provider-specific/local OAuth, revocation, and operator lifecycle commands remain outside this release surface.
- [#83](https://github.com/mohanagy/miftah/issues/83) Added durable bounded profile/account identity bindings, visible per-profile binding states and evidence, exact OAuth connection identity-state updates, and opt-in explicit or confirmed current-session selection for protected multi-profile operations. Persisted evidence never replaces live verification, and external state changes never silently override an active client's in-memory profile.
- [#84](https://github.com/mohanagy/miftah/issues/84) Added dry-run-first OAuth connection setup, redacted connection list/status/test reports, safe connect and reauthentication, exact local disconnect, client snippets, and headless diagnostics through shared typed application services.
- [#85](https://github.com/mohanagy/miftah/issues/85) Added the explicitly launched, literal-loopback Console control API with a separate `/api/v1` listener, one-use terminal bootstrap, bounded HttpOnly browser sessions, strict Host/Origin and CSRF enforcement, metadata-only configuration/profile/connection health, atomic audited connection changes, redacted Console audit queries, credential rotation, and clean shutdown. The browser UI remains a separate roadmap layer.
- [#86](https://github.com/mohanagy/miftah/issues/86) Added the optional foreground-only `miftah dashboard` experience for first-run configuration, profile and connection management, standards-compatible OAuth onboarding and recovery, connection health, and reviewable client snippets. It uses the system browser, never renders credential material, never silently edits MCP client configuration, and preserves the authenticated loopback control-plane boundary.
- [#87](https://github.com/mohanagy/miftah/issues/87) Added a typed built-in provider-adapter contract and a bounded Google Search Console pilot with exact `mcp-search-console@0.3.2` launch pinning, explicit upstream-owned OAuth/browser/cache lifecycle, safe health metadata, read-only defaults, manual service-account guidance, and no token-cache access or native-OAuth claims.

### Changed

- [#88](https://github.com/mohanagy/miftah/issues/88) Added a dedicated OAuth/Console compatibility gate across Ubuntu, macOS, and Windows on Node.js 20, 22, and 24, plus published setup, recovery, security, and supported-authentication evidence. External design-partner completion and return-use gates remain open and are not claimed by this release.

### Fixed

- [#178](https://github.com/mohanagy/miftah/issues/178) Locked `fast-uri` 3.1.4, removing the high-severity URI host-confusion advisory, and added a package contract that rejects stale vulnerable nested resolutions. The separate moderate `@hono/node-server` advisory affects only its unused `serve-static` path; Miftah's MCP transport uses `getRequestListener`, and the current MCP SDK has no compatible patched Hono 1.x release.
- [#115](https://github.com/mohanagy/miftah/issues/115) Removed the Windows secret-provider PowerShell cold-start boundary by launching a SHA-256-verified precompiled helper directly with an empty argument array and `shell: false`. Exact argv forwarding, bounded input/output, cancellation, timeouts, redaction, and kill-on-close Job Object process-tree containment remain enforced.
- [#122](https://github.com/mohanagy/miftah/issues/122) Windows OAuth transaction locking now acquires an exclusive, crash-released named pipe instead of depending on a bind inside the operating system's default ephemeral TCP range, preventing unrelated connections from making the local credential store unavailable. It recognizes an exact older-version holder and, when the legacy port is available, holds a best-effort compatibility listener so older processes also stay excluded; unrelated legacy listeners degrade that rolling-upgrade bridge without blocking the pipe lock. Unused profile runtime isolation now defers configuration canonicalization until isolation is actually requested, preventing delayed background filesystem failures in remote OAuth runtimes.
- [#196](https://github.com/mohanagy/miftah/issues/196) Linux OAuth state coordination now acquires a per-key, crash-released abstract Unix socket while retaining the legacy TCP probe and compatibility listener. Independent connection files can no longer block each other when their legacy 16,384-port hashes collide during parallel startup or coverage runs.
- [#88](https://github.com/mohanagy/miftah/issues/88) Windows audit coordination now skips operating-system-reserved loopback lock candidates while retaining deterministic contention handling and fail-closed behavior for held locks and unknown errors.

## [0.3.3] - 2026-07-22

### Fixed

- [#169](https://github.com/mohanagy/miftah/issues/169) The trusted PostHog command adapter now accepts HogQL dollar identifiers such as `$pageview` in canonical JSON `call` payloads, including DAU queries. Shell-substitution forms (`$()` and `${...}`), malformed commands, non-call dollar syntax, alternate origins, and destructive nested operations remain fail-closed.

## [0.3.2] - 2026-07-21

### Fixed

- [#106](https://github.com/mohanagy/miftah/issues/106) Miftah now recognizes the strict PostHog command-wrapper grammar only at the canonical official MCP endpoint, so documented read/discovery commands can run under destructive-routing safeguards without a per-user routing workaround. Generic `exec` tools, alternate origins, malformed commands, and unknown nested operations remain fail-closed; route preview now exposes the same local policy-enforcement block as a real call.
- [#142](https://github.com/mohanagy/miftah/issues/142) Risk classification now prioritizes trusted PostHog command metadata over generic static annotations, so a destructive wrapper operation cannot be treated as read-only and bypass its routing safeguards.
- [#112](https://github.com/mohanagy/miftah/issues/112) Shutdown now completes upstream process containment even when a downstream transport close rejects, then rethrows the original close error after cleanup.
- [#120](https://github.com/mohanagy/miftah/issues/120) The development build toolchain now resolves `esbuild` 0.28.1, removing the known low-severity development-server path-traversal advisory.

## [0.3.1] - 2026-07-18

### Fixed

- Secret-provider cleanup now force-kills a retained POSIX descendant as soon as its direct provider process exits, keeping timeout and cancellation cleanup contained.

### Changed

- The README now leads with Miftah's product value and quick-start, while retaining explicit security, OAuth, and desktop-environment boundaries.

## [0.3.0] - 2026-07-18

### Changed

- [#96](https://github.com/mohanagy/miftah/issues/96) Confirmation-required MCP calls now default to human form elicitation and fail closed when the client cannot present that form. The former self-approval bearer path is available only through explicit `security.approvalMode: "delegated-agent"`, is hidden from normal tool discovery, and is audited as delegated authorization rather than human proof; approval records are bound to that form or delegated mechanism.
- [#97](https://github.com/mohanagy/miftah/issues/97) The generated multi-profile GitHub preset now requires exact profile-switch confirmation and explicit current-session selection before destructive work, preventing a silent profile change or implicit selection from satisfying that boundary.
- [#98](https://github.com/mohanagy/miftah/issues/98) Management tools now publish reviewed MCP behavioral annotations from one contract table, including `miftah_list_approvals` as a read-only local observation. `miftah init --client claude-code` prints exact, manually merged Claude Code permission guidance for visible privileged management tools without modifying client settings.

## [0.2.1] - 2026-07-17

### Fixed

- [#79](https://github.com/mohanagy/miftah/issues/79) Documented the OAuth support boundary and capability matrix for current static headers, upstream-owned local OAuth, and future standards-compatible remote HTTP OAuth. Miftah does not implement native OAuth, browser callbacks, token refresh, or revocation; upstream-owned and provider-owned OAuth remains managed by the upstream, not Miftah.
- [#80](https://github.com/mohanagy/miftah/issues/80) Documented the design-only OAuth broker and local Console threat model, including canonical resource and issuer binding, secure-store isolation, conditional client registration, effective-header collision prevention, and pre-implementation security tests. It does not run native OAuth, a Console, callback listener, or token store.

## [0.2.0] - 2026-07-14

### Added

- [#32](https://github.com/mohanagy/miftah/issues/32) Delivered MCP protocol conformance for resource templates, subscriptions, upstream list/update notifications, aggregate pagination, explicit capability/unsupported behavior, and request cancellation/progress forwarding across STDIO and Streamable HTTP upstreams.
- [#18](https://github.com/mohanagy/miftah/issues/18) The packed-package contract now exercises the installed CLI through shell and Windows command quoting, paths with spaces, generated help, stable category exits, JSON automation output, and normalized/redacted audit-log output.
- [#18](https://github.com/mohanagy/miftah/issues/18) The CLI reference now documents generated help, every command and option, version compatibility output, exit statuses, JSON streams, and audit snapshot/follow safety boundaries.
- [#19](https://github.com/mohanagy/miftah/issues/19) The versioned strict preset catalog, first-run onboarding wizard, generated absolute client snippets, compatibility matrix, and exact generated examples are documented and contract-tested. Tests validate generated configuration without constructing or starting external providers.
- [#20](https://github.com/mohanagy/miftah/issues/20) Metadata-only routing context now combines bounded workspace signals with deterministic profile selection, capability-gated MCP roots, strict project markers, and sanitized route-preview/audit evidence.
- [#21](https://github.com/mohanagy/miftah/issues/21) Delivered opt-in upstream identity fingerprint verification: strict expected/probe configuration, safe in-memory status and bounded caching, explicit MCP verification, required write/destructive gating, redacted audit evidence, and doctor readiness reporting.
- [#22](https://github.com/mohanagy/miftah/issues/22) Delivered typed internal secret providers for environment, dotenv, opt-in plaintext, OS keychains, and 1Password; strict external-reference parsing, bounded no-shell execution and process-tree cleanup, automatic redaction registration, provider timeout configuration, and target-scoped doctor readiness diagnostics.
- [#23](https://github.com/mohanagy/miftah/issues/23) Delivered opt-in active-profile persistence with explicit process, session, workspace, and config-identity-namespaced global scope; atomic restrictive state writes, safe restore diagnostics, lock precedence, and selection metadata in MCP current-profile output.
- [#26](https://github.com/mohanagy/miftah/issues/26) Policy risk classification now records source and confidence, accepts MCP annotations only from explicitly trusted configured upstreams, preserves local override precedence, fails closed on contradictory hints, and defaults unknown tools to destructive risk unless an operator selects the compatible write default.
- [#27](https://github.com/mohanagy/miftah/issues/27) Delivered connection-bound one-time approvals for confirmation-required tools, resource reads, and prompts: generic MCP form elicitation with a safe fallback flow, exact target/argument binding, one-time consumption, expiry and replay protection, bounded in-memory state, lifecycle audit events, and approval management tools.
- [#28](https://github.com/mohanagy/miftah/issues/28) Delivered connection-bound profile confirmation, runtime locks, and bounded per-profile risk leases: strict configuration, exact fallback/form confirmation, captured lease enforcement before execution, explicit destructive-selection controls, safe profile-state output, and rollback-protected profile audit transitions.
- [#29](https://github.com/mohanagy/miftah/issues/29) Delivered opt-in POSIX profile credential isolation: canonical marker-owned runtime trees, copy-only mapped credentials and HOME/XDG injection, redacted isolated-child stderr, fixed Docker/Podman bind-mount argv generation, explicit lifecycle limits, and documented same-user/container boundaries.
- [#30](https://github.com/mohanagy/miftah/issues/30) Delivered typed opt-in GitHub, Sentry, Jira, Linear, and PostHog provider routing matchers: fixed in-tree evaluation, canonical bounded argument/URL/resource-URI signals, safe Git/package context, deterministic ambiguity, client-visible multi-upstream routing, and redacted preview/audit evidence.
- [#31](https://github.com/mohanagy/miftah/issues/31) Delivered configurable audit-journal size/age rotation and safe retention, cross-process JSONL coordination, optional SHA-256-chain tamper evidence with first-break verification, and explicit redacted support export that omits stored arguments by default.
- [#34](https://github.com/mohanagy/miftah/issues/34) Delivered the versioned local plugin API for explicit secret providers and routing matchers: strict allowlisted configuration, preflight manifest/path validation, scrubbed bounded child hosts, canonical secret references and routing signals, redaction registration, request-level cancellation/timeout containment, package contracts, and reference documentation.
- [#38](https://github.com/mohanagy/miftah/issues/38) Added configuration format v2 with an explicit dry-run-first `migrate-config` command, exact exclusive backups for opted-in writes, historical v1 compatibility fixtures, documented compatibility/removal windows, and versioned public extension, CLI, management-tool, and audit contracts.
- Package metadata and a verified npm pack-content contract.
- Least-privilege CI and OIDC trusted-publishing workflows.
- Dependency update, contribution, vulnerability-reporting, and repository templates.

### Changed

- [#16](https://github.com/mohanagy/miftah/issues/16) The library root export is now an intentional, documented public API. Internal server, process, profile, routing, policy, audit, and secret-management classes are no longer available from `@lubab/miftah`; use the configuration utilities and `createMiftahRuntime()` instead. This pre-1.0 breaking change requires a minor release.
- [#26](https://github.com/mohanagy/miftah/issues/26) Unmatched tool names now default to destructive risk instead of write risk. Set `tooling.unknownToolRisk: "write"` only when the compatible, less restrictive default is intentional.
- [#38](https://github.com/mohanagy/miftah/issues/38) `MiftahConfig` is now a version-discriminated union: version 2 rejects removed configuration aliases at compile time while version 1 retains its documented compatibility surface. This intentional pre-1.0 type-surface change requires consumers that previously used `interface X extends MiftahConfig` to compose with a type intersection instead.

### Fixed

- Audit-journal local lock probing now treats interrupted lock-holder handoffs as unknown and retries the canonical candidate, preserving cross-process rotation exclusion instead of bypassing it.
- The package verifier now accepts both the list and keyed-object JSON formats emitted by supported npm `pack --json` versions while retaining the single-artifact and path allowlist checks.
- [#1](https://github.com/mohanagy/miftah/issues/1) Policy lookup now fails closed and configuration rejects unknown profile policy references instead of allowing a policy fail-open.
- [#2](https://github.com/mohanagy/miftah/issues/2) Secret redaction preserves ordinary identifiers while still removing configured credentials from logs, errors, and discovery results.
- [#3](https://github.com/mohanagy/miftah/issues/3) The GitHub Docker preset injects profile credentials correctly and pins the upstream image tag.
- [#4](https://github.com/mohanagy/miftah/issues/4) Configuration now rejects unsupported lifecycle controls, state/UI settings, routing plugins and non-hybrid modes, profile metadata and matchers, per-profile upstream `transport`/`command`/`url` overrides, and configurable tool namespaces with `UNSUPPORTED_CONFIG_OPTION` instead of silently ignoring them. Secret and audit redaction remain force-on protections.
- [#5](https://github.com/mohanagy/miftah/issues/5) Resource and prompt proxying no longer silently selects the first configured upstream: zero- and multi-upstream bundles fail closed, and one-entry bundles select their upstream explicitly.

## Release policy

Miftah is experimental and pre-1.0, so incompatible changes may occur between minor versions and must be called out here. For each release, maintainers move **Unreleased** entries into a dated version section, update `package.json` and `package-lock.json` together using npm tooling, and publish a GitHub release tagged `v<package-version>`. The release workflow publishes only after the tag, ancestry, tests, build, CLI smoke test, and package contents are verified.
