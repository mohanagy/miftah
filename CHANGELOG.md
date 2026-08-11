# Changelog

All notable changes to this project will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- [#363](https://github.com/mohanagy/miftah/issues/363) Added MCP `2026-07-28` serving alongside the existing legacy initialized era. STDIO now negotiates both eras through the SDK v2 serving entry; Streamable HTTP classifies each request before routing it to a fresh request-scoped modern server or the existing bounded sessionful legacy host. Modern requests use `server/discover`, carry per-request metadata, omit `Mcp-Session-Id`, propagate cancellation to the selected upstream, and return explicit supported-version diagnostics. The new public `createMiftahServerFactory` lets a trusted embedding host attach the authenticated stateless profile-context boundary without exposing Miftah's broker, policy, audit, OAuth, routing, or lifecycle internals.
- [#377](https://github.com/mohanagy/miftah/issues/377) Added the opt-in production profile-context boundary for trusted modern stateless hosts. Short-lived authenticated-encrypted handles bind a named profile to the verified issuer, subject, audience, chat, deployment, and monotonic sealing-key epoch; deployment-wide revocation, exact expiry, removed-profile checks, bearer-free keyed audit correlation, audited rejection and replacement-before-revocation ordering, and fixed fail-closed errors apply on every request. Reserved tool or request metadata is stripped before audit argument capture and upstream forwarding, transition approvals are bound to the authenticated chat correlation, and modern discovery enforces identical client-visible tools across profiles and is independent of prior selection calls. The CLI host does not synthesize trusted chat claims; an embedding host enables the boundary through `createMiftahServerFactory`.
- [#376](https://github.com/mohanagy/miftah/issues/376) Added a public authenticated request-context boundary for modern stateless handling. Trusted embedding hosts can provide verified issuer, subject, audience, per-chat, issuance, and expiry claims; Miftah derives only opaque deployment-bound and separately keyed audit correlations, fails closed on missing, malformed, expired, or mismatched context, and never falls back to MCP `clientInfo`, arbitrary headers, request metadata, tool arguments, or mutable profile state. The CLI-owned Streamable HTTP server negotiates the modern protocol without inventing these trusted claims; embedding hosts supply them through the public server factory.

### Changed

- [#363](https://github.com/mohanagy/miftah/issues/363) Replaced the monolithic MCP TypeScript SDK v1 dependency with the stable v2 split packages and migrated runtime schemas to Zod 4. Runtime consumers receive only `client`, `core`, and `server`; the Node adapter and frozen legacy server remain build/test dependencies. Direct consumers of the old monolithic SDK deep imports must move to the corresponding split package. The CLI bundles the v2 Node adapter with patched `@hono/node-server` and Hono builds so a fresh Miftah install does not inherit the Node package's still-vulnerable 1.x adapter range; custom embedding hosts own their direct Node adapter version. Confirmation-required tools, resources, prompts, and profile transitions now use the v2 `input_required` flow with integrity-bound one-time continuation state across request-scoped modern HTTP instances, while the SDK legacy shim preserves form elicitation for initialized clients. Native OAuth callback completion now carries the authorization-server issuer required by the v2 provider contract; Miftah continues to validate and round-trip that issuer without exposing tokens or client secrets.

## [1.0.0] - 2026-08-11

### Changed

- [#39](https://github.com/mohanagy/miftah/issues/39) Established the stable Semantic Versioning contract for documented configuration formats, CLI and MCP names, audit records, package exports, and the plugin API. The v1 candidate preserves the tested 0.5.8 runtime surface while promoting the compatibility, migration, documentation, security, and cross-platform gates accumulated across the pre-1.0 line.
- [#36](https://github.com/mohanagy/miftah/issues/36) Added a repeatable, research-only evaluation of MCP tool-description quarantine: exact descriptor drift is detected with canonical hashes, while a deliberately small heuristic corpus records both false positives and missed malicious descriptions. The published recommendation defers runtime quarantine until representative design-partner evidence shows acceptable value, approval churn, and recovery behavior; this prototype is not a production security control and does not claim protection after credentials reach an operator-approved upstream.

### Security

- [#373](https://github.com/mohanagy/miftah/issues/373) Updated the exact transitive security resolutions to `fast-uri` 3.1.5, `ip-address` 10.3.1, `hono` 4.12.34, `brace-expansion` 5.0.9, and `nanoid` 3.3.17 after newly disclosed host-confusion, SSRF/trust-classification, ReDoS, and denial-of-service advisories. Package contracts reject stale nested copies, and both production-only and full npm audits report zero known vulnerabilities without changing Miftah's runtime API.

### Validation

- The maintainer reported **5/5 completed external workflows**, **3 returning participants**, **3 unaided evaluators**, and a completed security report, then authorized closure of the related v1 issues. This release record preserves that as maintainer attestation: the participant records and completed report were not independently inspected during release preparation, and no additional provider, reviewer, severity, or remediation facts are inferred here.
- Publication remains protected: the finalized candidate is promoted from `development` to the exact current `main` commit, released as `v1.0.0`, and published only through protected OIDC publication with registry provenance, fresh-install, and signature verification recorded on #39.

## [0.5.8] - 2026-08-09

### Fixed

- [#347](https://github.com/mohanagy/miftah/issues/347) Made upstream startup failures actionable without exposing configuration or credential material. Runtime warnings remain concise and point to the exact `miftah test-profile` command; `test-profile` and `doctor` now surface a bounded, secret-redacted failure cause and remediation. Diagnostics also recognize pinned `uvx` package invocations while retaining the existing fail-closed startup boundary.

### Changed

- [#349](https://github.com/mohanagy/miftah/pull/349) Refreshed the compatible `dotenv`, ESLint, and TypeScript ESLint dependencies after the full supported Node and operating-system matrix passed. The deferred Vitest 4 and TypeScript 7 major upgrades are not part of this release.
- [#350](https://github.com/mohanagy/miftah/issues/350) Prepared the compatible v0.5.8 patch release for actionable upstream-startup diagnostics and the safe dependency refresh. Miftah remains experimental and pre-1.0. Technical delivery and owner dogfooding do not satisfy external evaluator counts; external validation remains incomplete under #25, #88, #202, and #290.

## [0.5.7] - 2026-08-01

### Changed

- [#334](https://github.com/mohanagy/miftah/issues/334) Tightened the Console connection catalog for faster scanning: cards use a compact hierarchy for the connection name, durable default, named-account actions, authentication status, and Manage connection action; medium and narrow layouts collapse before controls can crowd or clip; and long account or connection names wrap without hiding status counts or keyboard focus. Existing authentication, redaction, audit, containment, no-shell, and public API guarantees are unchanged.
- [#333](https://github.com/mohanagy/miftah/issues/333) Replaced first-use Console setup vocabulary with task-oriented language: the chooser now leads with **Choose your MCP**, groups built-in and custom options plainly, names custom MCP, local executable, remote HTTPS, browser sign-in, existing-client-entry, and secret-reference paths distinctly, and limits help text to the information needed for the next step. The wording does not claim universal MCP or OAuth compatibility, and existing authentication, redaction, audit, containment, no-shell, and public API guarantees are unchanged.
- [#332](https://github.com/mohanagy/miftah/issues/332) Turned Console management navigation into five focused, keyboard-accessible sections: Overview, Accounts, Authentication, Client setup, and Audit. Only the selected task is shown; the non-secret URL fragment restores a valid selection after refresh or reauthentication, while switching tasks leaves in-page form drafts untouched and performs no writes. Destructive account removal remains confined to Accounts, and existing redaction, audit, OAuth, containment, no-shell, and public API guarantees are unchanged.
- [#331](https://github.com/mohanagy/miftah/issues/331) Made Console account switching read like a user action: each named account now offers a client-specific `Use <account> in this chat` action, copied-request confirmation names the account and selected client, and the durable default is described as applying to new MCP sessions. Shared guidance appears once instead of on every connection card. The existing `miftah_use_profile` request, supported clients, redaction, audit, credential handling, containment, and public APIs are unchanged.
- [#339](https://github.com/mohanagy/miftah/issues/339) Prepared the compatible v0.5.7 patch release for clearer account switching, focused task sections, setup written in user language, and a responsive connection catalog. Miftah remains experimental and pre-1.0. Technical delivery and owner dogfooding do not satisfy external evaluator counts; external validation remains incomplete under #25, #88, #202, and #290.

## [0.5.6] - 2026-07-31

### Fixed

- [#325](https://github.com/mohanagy/miftah/issues/325) Made Console setup completion and account switching remain actionable through overlapping refreshes and reauthentication. Successful setup now keeps its client handoff and focus without overriding the unlock screen; stale session responses cannot replace a newer configuration, status, or generated client entry; and Save draft, Resume draft, and readiness actions recover after successful reauthentication. Existing authentication, redaction, audit, no-shell subprocess, file-containment, Windows, and public API boundaries are unchanged.
- [#327](https://github.com/mohanagy/miftah/issues/327) Prepared the compatible v0.5.6 patch release for the Console actionability correction. Miftah remains experimental and pre-1.0. Technical delivery and owner dogfooding do not satisfy external evaluator counts; external validation remains incomplete under #25, #88, #202, and #290.

## [0.5.5] - 2026-07-31

### Changed

- [#202](https://github.com/mohanagy/miftah/issues/202) Made the Console task-first for returning users: validated MCP connections now lead the page and show their named account profiles, durable default, and whether live in-session switching through `miftah_use_profile` is available. The setup wizard remains directly reachable, while the authentication ownership matrix and trust-boundary reference are collapsed behind **How authentication works**. The Console still exposes only non-secret metadata, never inspects client settings or running MCP processes, and preserves the existing validation, redaction, audit, file-containment, and no-shell boundaries. External evaluator acceptance remains open and is not claimed by this change.
- [#319](https://github.com/mohanagy/miftah/issues/319) Prepared the compatible v0.5.5 patch release for the task-first Console correction. Miftah remains experimental and pre-1.0. Technical delivery and owner dogfooding do not satisfy the external acceptance counts; external validation remains incomplete under #25, #88, and #202.

## [0.5.4] - 2026-07-30

### Changed

- [#204](https://github.com/mohanagy/miftah/issues/204) Corrected returning-user Console setup so it presents one setup path at a time instead of rendering connector, client-entry import, and browser-sign-in forms together. Users now choose their starting point before seeing details; the shared step label names the selected path; Back and Cancel provide no-write recovery, with Back returning to the chooser and Cancel clearing the draft without creating or changing a configuration. The existing local STDIO and returning provider-owned account paths continue to reuse the typed planners and writers; non-overwrite publication, redaction, audit, direct argument arrays with `shell: false`, credential isolation, and Windows/POSIX containment remain unchanged.
- [#314](https://github.com/mohanagy/miftah/issues/314) Prepared the compatible v0.5.4 patch release for the guided Console correction. Miftah remains experimental and pre-1.0. Technical delivery and owner dogfooding do not satisfy the external acceptance counts; external validation remains incomplete under #25 and #88.

## [0.5.3] - 2026-07-30

### Changed

- [#204](https://github.com/mohanagy/miftah/issues/204) Kept guided Console setup reachable after configurations already exist through a visible **Set up another MCP** action. Returning users can create a separate named configuration through the reviewed local STDIO secret/API-key, native OAuth, returning provider-owned account, provider-adapter OAuth, or manual upstream-auth paths; successful publication refreshes discovery immediately. Existing files are never overwritten, unsafe catalog candidates remain unavailable with bounded diagnostics, audit fields remain redacted, and private-directory, inode-anchored POSIX publication, bounded no-shell subprocess, and Windows containment contracts remain fail closed.
- [#309](https://github.com/mohanagy/miftah/issues/309) Prepared the compatible v0.5.3 patch release for returning-user Console setup. Miftah remains experimental and pre-1.0. Closing #204 was an owner waiver of its three-evaluator acceptance criterion, not evidence that those evaluations occurred; external validation remains incomplete under #25, #88, #202, and #290.

## [0.5.2] - 2026-07-29

### Fixed

- [#203](https://github.com/mohanagy/miftah/issues/203) Made bounded Console configuration discovery explain what happened instead of silently omitting unsafe candidates. The Console now reports aggregate found, ready, and need-attention counts with fixed repair categories while continuing to hide rejected names, paths, values, parser details, and filesystem identities. POSIX ownership/mode checks, Windows DACL verification, symlink/race/deduplication protections, and exact selected-file binding remain fail closed.
- [#300](https://github.com/mohanagy/miftah/issues/300) Preserved still-valid Console sessions across refresh, back/forward navigation, and additional tabs through the existing authenticated loopback session boundary. Expired, reused, superseded, malformed, and wrong-process bootstrap codes now receive specific recovery guidance without exposing credential material. One-use terminal bootstrap codes, HttpOnly `SameSite=Strict` cookies, in-memory-only CSRF proofs, Host/Origin checks, credential rotation, and no-store responses are unchanged.
- [#301](https://github.com/mohanagy/miftah/issues/301) Added names-only environment-secret readiness before CLI and Console client handoff. Setup now distinguishes not required, available, missing, and not fully checked states, keeps configured environment files unopened, treats empty inherited values as missing, and leaves generated client JSON credential-free. Console completion guidance is cleared when the active configuration changes so stale readiness cannot be attributed to another configuration.
- [#305](https://github.com/mohanagy/miftah/issues/305) Prepared the compatible v0.5.2 corrective release for the first external evaluator blockers. Miftah remains experimental and pre-1.0; external validation remains incomplete under #25, #36, #37, #39, #78, #88, #202, #204, and #290.

## [0.5.1] - 2026-07-29

### Added

- [#40](https://github.com/mohanagy/miftah/issues/40) Added an owner-readable Miftah 0.5 feature and usage guide that distinguishes the 0.5 onboarding/profile-management delta from capabilities first shipped in 0.4, maps each outcome to production-bound CLI or Console entry points, and retains the package's OAuth, active-session, provider-ownership, pre-1.0, and incomplete external-validation boundaries.

### Changed

- [#204](https://github.com/mohanagy/miftah/issues/204) Made guided setup an explicit first-use product front door: the terminal wizard now presents numbered source choices, visible setup steps, safe back/cancel handling before connection details, and current-step recovery for invalid choices; the README now places both `miftah setup` and the `miftah dashboard` browser Console ahead of the optional scripted `init` example and distinguishes the browser UI from the lower-level `console` API command. Existing local STDIO, returning provider-owned account, no-secret, no-shell, no-overwrite, OAuth ownership, import, validation, and shared CLI/Console setup boundaries are unchanged. External evaluator acceptance remains open and is not claimed.
- [#290](https://github.com/mohanagy/miftah/issues/290) Redesigned the README as a concise product front door: first-screen fit guidance, one connector with named profiles, one safe GitHub first-success path, distinct secret/native-OAuth/upstream-owned-OAuth routes, visible client/wizard/Console choices, and progressively disclosed security, architecture, reference, and troubleshooting links. External evaluator acceptance remains open and is not claimed by this documentation change.
- [#297](https://github.com/mohanagy/miftah/issues/297) Prepared the compatible v0.5.1 corrective release for the first-use README and setup-wizard improvements. This release keeps Miftah experimental and pre-1.0 and does not claim that external validation under #25, #88, #202, #204, or #290 is complete.

### Fixed

- [#255](https://github.com/mohanagy/miftah/issues/255) Isolated logical audit, Console, and OAuth profile-rename contracts from host-dependent file-flush latency while retaining dedicated real-sync audit and OAuth transaction integration tests and the broader durability suites. Process-tree tests now stop at their real containment boundary, drain bounded restart work, and use a minimal MCP fixture for the shutdown-timing contract. Production audit writes, fail-closed locking, transactional recovery, containment, test timeouts, coverage, and platform gates are unchanged.

## [0.5.0] - 2026-07-28

### Added

- [#204](https://github.com/mohanagy/miftah/issues/204) Added guided multi-account Google Search Console onboarding through the CLI and local Console, including an explicit opt-in first-success check that resolves only the selected target, verifies audit/policy/identity boundaries before its one declared read-only probe, and cancels with the requesting Console session. The check trusts only the catalog's reviewed launch envelope and fails closed without launching a process after execution-affecting customization. It creates named profiles with an explicit durable default and separate upstream-owned OAuth state directories per generated configuration file and profile, while continuing to keep browser login, token-cache contents, reauthentication, revocation, and account identity verification outside Miftah. A returning provider-owned account can now be added atomically through the reviewed adapter contract in either CLI or Console, with a fresh isolated state directory, a redacted fail-closed lifecycle record, and no token-cache access. It also adds a separate returning-user path for a simple local STDIO environment credential binding: CLI and Console accept a variable name rather than a secret, require every existing profile to share the same narrow binding, enforce multi-profile safeguards, use guarded audited replacement, and refuse remote HTTP, provider-adapter, OAuth, named-upstream, mixed-profile, duplicate-source, and arbitrary-override configurations. It also adds explicitly acknowledged local STDIO setup and client-entry import: literal executable plus bounded argument array, no shell, no secret-shaped values, no generic-command launch during onboarding, read-only default policy, destructive handling for unknown tools, and Windows-only direct absolute `.exe`/`.com` requirements to avoid a command-shell fallback. Bare interactive `miftah setup` now also lets a user choose one selected existing client entry: it reads one explicit absolute client file through a bounded verified handle, lists only safe entry names, imports from that same inspected snapshot, and never prints source command, argument, header, environment, or credential values. Returning CLI users can now review the durable default and fixed non-secret account metadata with `profile list`, and rerun only the selected provider adapter's declared, audited read-only readiness check with `profile test`, receiving a redacted report and nonzero outcome for any non-ready state without an arbitrary tool call, browser handoff, configuration mutation, or provider-cache access. It also adds a guarded CLI and local Console flow for setting or explicitly clearing one existing profile's non-secret description. It preserves all other profile fields, durable default, routing, OAuth bindings, credential and provider-cache ownership; writes through the existing audited replacement and exact-recovery transaction; and returns no configuration bytes or submitted label.
  It also adds guarded profile rename through the CLI and local Console. The operation atomically updates configuration-owned default, routing, routing-plugin, and profile-lock references with recovery backup and fail-closed audit records, while leaving credentials, provider caches, profile state, identity records, and active clients untouched. A recoverable native OAuth-bound profile rename separately migrates configuration references, profile-bound OS-vault credentials, and binding metadata with exact destination-collision protection and redacted audit records.
- [#204](https://github.com/mohanagy/miftah/issues/204) Added outcome-first source choices to the interactive CLI and Console: known connector or pinned package, remote HTTPS endpoint, local executable, remote MCP with browser sign-in, or one existing client entry. Each choice reuses the existing hardened setup path; generic remote setup remains network-free and authentication-free, local setup remains no-shell and does not launch the executable, and client settings remain manual and untouched.
- [#204](https://github.com/mohanagy/miftah/issues/204) Added review-before-write setup planning: a complete noninteractive `miftah setup --plan` emits only validated non-secret structure without touching the filesystem or an upstream, and the first-run Console requires a fresh structural review before its separate create action. The review omits paths, endpoints, launch arguments, credential references, OAuth details, and secret values; changing the form invalidates it.
- [#204](https://github.com/mohanagy/miftah/issues/204) Added a private resumable connector-setup checkpoint shared by `miftah setup` and the first-run Console. It stores only a bounded configuration name, catalog preset, and setup stage with atomic compare-and-swap protection; URLs, paths, commands, arguments, environment references, client entries, browser state, OAuth state, credentials, and secrets must be entered again. A saved checkpoint can be resumed or explicitly discarded, survives cancellation or a pre-publication failure, and is cleared only after configuration publication succeeds.

### Changed

- [#202](https://github.com/mohanagy/miftah/issues/202) Made the shipped trust controls and one-connector multi-profile model discoverable at first use: the README now distinguishes credential readiness, verified identity, native and provider-owned OAuth, local policy, and audit boundaries; it gives a no-token team-sharing pattern; CLI client handoffs and the local Console now state that one generated client entry serves every named profile and contains no credential values.
- [#200](https://github.com/mohanagy/miftah/issues/200) Reworked the README into a task-oriented first-use guide with complete Claude Desktop setup, authentication-path selection, generic MCP onboarding, profile-management tools, native versus upstream-owned OAuth, dashboard lifecycle, everyday diagnostics/audit commands, and focused security-control guidance; corrected stale configuration-version guidance to identify v3 as current while preserving an explicit v1/v2 removal window.
- [#280](https://github.com/mohanagy/miftah/issues/280) Prepared this minor release so the current guided setup and multi-account onboarding can undergo real external design-partner validation. The release does not claim that the completion or returning-user gates in #25 and #88 are met.

### Fixed

- [#205](https://github.com/mohanagy/miftah/issues/205) Audit journal lock probing now gives a just-queued local connection refusal one additional check phase to settle before it fails closed. This prevents host-scheduling races from being mistaken for an ambiguous lock holder without increasing the bounded probe or lock-acquisition timeouts; truly ambiguous probes remain unavailable.
- [#217](https://github.com/mohanagy/miftah/issues/217) Windows STDIO launch now resolves only direct `.exe`/`.com` commands before the MCP SDK, rejects command shims and shell executables, and refuses npx-backed presets on Windows rather than silently falling back to `cmd.exe`.
- [#281](https://github.com/mohanagy/miftah/issues/281) Updated the MCP SDK Hono runtime dependency chain to patched compatible releases, removing known runtime advisories without changing Miftah's public interface.
- [#282](https://github.com/mohanagy/miftah/issues/282) Scoped patched development toolchain dependencies beneath their test and build dependency ancestry, removing known development advisories without broad package-manager overrides or runtime dependency changes.
- [#284](https://github.com/mohanagy/miftah/issues/284) Replaced repeated Windows Console catalog ACL helper launches with batched Windows Console catalog ACL verification of the trusted directory and candidate, preserving fail-closed checks while improving reliability under load.
- [#221](https://github.com/mohanagy/miftah/issues/221) and [#242](https://github.com/mohanagy/miftah/issues/242) Hardened Windows configuration migration and Console configuration cataloging around exact, lossless file identities, preserving fail-closed handling for ambiguous files.
- [#264](https://github.com/mohanagy/miftah/issues/264) Prevented unrelated macOS loopback listeners from blocking a profile's OAuth credential lock while preserving same-profile exclusion.
- [#269](https://github.com/mohanagy/miftah/issues/269) Made audit-journal locking bind a free exclusive local listener before probing occupied candidates, avoiding a bounded-probe stall before the first audit append without weakening fail-closed contention behavior.
- [#255](https://github.com/mohanagy/miftah/issues/255), [#265](https://github.com/mohanagy/miftah/issues/265), and [#270](https://github.com/mohanagy/miftah/issues/270) Strengthened bounded upstream process-tree teardown and capacity recovery across contained STDIO transports.

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

Miftah 1.x follows Semantic Versioning for the public compatibility surfaces documented in the library, CLI, configuration, audit, MCP-management, and plugin references. Compatible fixes use patch releases, additive compatible features use minor releases, and incompatible public changes require a new major release with an explicit **Unreleased** entry and migration guidance. For each release, maintainers move **Unreleased** entries into a dated version section, update `package.json` and `package-lock.json` together using npm tooling, and publish a GitHub release tagged `v<package-version>`. The release workflow publishes only after the tag, ancestry, tests, build, CLI smoke test, and package contents are verified.
