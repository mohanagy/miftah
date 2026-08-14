# Legacy compatibility retirement evidence ledger

This ledger is the decision record for [retirement gate #388](https://github.com/mohanagy/miftah/issues/388). It inventories shipped compatibility behavior, separates executable proof from observation and usage evidence, and defines the migration and rollback evidence required before a removal issue can exist.

**Status: evidence collection; retirement deferred. No removal is authorized.**

## Immutable baseline

Evidence collected after 2026-08-14 must use the released package unless a row explicitly identifies a source-only test.

| Item | Verified baseline |
| --- | --- |
| Package | `@lubab/miftah@1.1.2`, npm `latest` on 2026-08-14 |
| Source and tag | `v1.1.2` at `db02f292bcb5f3f1013582f182d4baeb24ed8060`, which was the exact current `main` commit when the release was created |
| Registry integrity | `sha512-irvuGcic5EzsZc3cLEiw8+31Vnua5qjdU3l1gztl6q8I9RJQyCNLopVyolxRmmtoqHAoe+3803AvNy8V0ihvmw==` |
| Provenance | npm attestation with SLSA provenance predicate v1 |
| Promotion evidence | [PR #411](https://github.com/mohanagy/miftah/pull/411) and [CI run 31827883578](https://github.com/mohanagy/miftah/actions/runs/31827883578) |
| Publish evidence | [GitHub Release v1.1.2](https://github.com/mohanagy/miftah/releases/tag/v1.1.2) and [protected publish run 31828756232](https://github.com/mohanagy/miftah/actions/runs/31828756232) |
| Consumer verification | Fresh exact install, package import, and CLI version passed; npm reported zero known vulnerabilities, 100 verified registry signatures, and 15 verified attestations |

The release proves that evidence can be tied to one recoverable artifact. It does not prove that a compatibility path is unused or safe to remove.

## Evidence strength

Use the strongest applicable label for every matrix entry or transcript.

| Label | Meaning | What it can support |
| --- | --- | --- |
| `source-contract` | Reviewed implementation or documentation at the baseline commit | Inventory and risk hypotheses only |
| `source-test` | Automated test against the repository checkout | Deterministic behavior for the tested fixture |
| `packaged-test` | Test against the exact installed npm artifact | Packaging and runtime behavior for the named client, operation, transport, OS, and Node version |
| `configuration-shape` | Generated configuration matches a host's documented schema | Configuration generation only; not runtime compatibility |
| `named-host-runtime` | Deidentified transcript from the exact packaged artifact and exact host version | The operations and limitations in that transcript only |
| `usage-attestation` | Maintainer-reviewed, dated evidence from real configurations or operators | Demand and migration decisions within the recorded sample |
| `rollback-rehearsal` | A future incompatible candidate was rolled back to the baseline with state checks | Recoverability for the tested candidate and state fixture only |

Absence of reports is not `usage-attestation`. Generated configuration is not `named-host-runtime` evidence.

## Retirement candidate inventory

### Initialized `2025-11-25` serving over STDIO

- **Shipped contract:** the SDK v2 serving entry selects the frozen legacy adapter, performs `initialize` and `notifications/initialized`, and owns one Miftah runtime for the client connection. Roots and resource subscriptions remain capability-gated.
- **Owners:** `src/cli/main.ts`, `src/runtime/create-miftah-runtime.ts`, and the `@modelcontextprotocol/server-legacy` dependency.
- **Current evidence:** `source-test` in `tests/mcp-v2-serving.test.ts` negotiates `2025-11-25`, exposes tools, and distinguishes legacy subscription and cache behavior from the modern STDIO path. The exact published-v1.1.2 `packaged-test` below drives the installed CLI process and proves initialized Roots routing and refresh, resource subscribe/update/unsubscribe, and cleanup with the official client. It also records the advertised-but-undelivered list-change and unpropagated-cancellation limitations tracked by [#413](https://github.com/mohanagy/miftah/issues/413).
- **Migration required:** the exact client must negotiate `2026-07-28` through the SDK v2 entry. A future failure must name the retained revision and give an actionable client-upgrade or pinned-baseline path.
- **Missing evidence:** named-host STDIO transcripts, usage evidence for initialized-only clients, a packaged approval transcript, repair evidence for #413, and proof that real profile, Roots, confirmation, resource, notification, and cancellation workflows survive migration.
- **Decision:** defer.

### Initialized `2025-11-25` Streamable HTTP sessions

- **Shipped contract:** legacy initialization creates a bounded runtime keyed by `Mcp-Session-Id`. Profile state is session-scoped. Admission limits, idle expiry, interrupted response-stream reconnection, client termination, initialization failure, and shutdown own cleanup of the runtime, upstream sessions, and transport.
- **Owners:** `src/http/miftah-http-server.ts`, `src/runtime/create-miftah-runtime.ts`, and `src/profiles/profile-state.ts`.
- **Current evidence:** `source-test` in `tests/mcp-v2-serving.test.ts` proves legacy negotiation and session creation. `tests/http-server.test.ts` covers concurrent session isolation, reconnection, capacity, idle expiry, DELETE cleanup, retained upstream release, and shutdown failures.
- **Migration required:** clients must use request-scoped `2026-07-28`, stop depending on initialization, GET reconnection, DELETE session lifecycle, or mutable session profile state, and use an authenticated application-state boundary where cross-request profile context is required.
- **Missing evidence:** exact client-by-client behavior, an operator migration for every session-dependent workflow, and a named-host packaged transcript.
- **Decision:** defer.

### Roots-derived routing context

- **Shipped contract:** initialized clients may advertise Roots and send `notifications/roots/list_changed`. Only normalized `file:` roots are accepted. The deepest root containing the working directory bounds project-marker, package, workspace, and Git-origin discovery; environment and strict project markers may contribute profile hints.
- **Owners:** `src/mcp/server/miftah-server.ts`, `src/routing/context-collector.ts`, and the routing engine.
- **Current evidence:** `source-contract` shows bounded 64 KiB metadata reads, real-path boundary checks, symlink-swap checks, local Git config without includes, stripped `GIT_*` process input, URI redaction, ignored malformed/non-file Roots, and `ROUTING_PROFILE_NOT_FOUND` for an unknown hinted profile. The published-v1.1.2 `packaged-test` performs one initialized Roots request, routes to `personal`, sends `notifications/roots/list_changed`, performs one refresh, and routes the next call to `work`.
- **Migration required:** every affected workflow needs an explicit replacement using reviewed configuration, environment, project marker, or a separately approved modern context extension. The replacement must retain boundary and redaction properties and must not infer trusted identity from a path.
- **Missing evidence:** which real clients send Roots, which routing rules depend on them, and whether users can migrate without ambiguous or incorrect profile selection.
- **Decision:** defer.

### Resource subscriptions and list-changed notifications

- **Shipped contract:** initialized runtimes advertise resource subscriptions only when every selectable upstream supports them. Resource updates are forwarded, and profile transitions, upstream lifecycle changes, restarts, session termination, and shutdown invalidate or unsubscribe retained state. Direct-runtime source tests forward tools/resources/prompts list changes after bounded refresh, but the published-v1.1.2 initialized SDK v2 adapter currently advertises and drops those three notifications; see #413.
- **Owners:** `src/mcp/server/miftah-server.ts`, `src/mcp/server/resource-prompt-registry.ts`, and `src/upstream/upstream-session.ts`.
- **Current evidence:** `source-test` covers capability-gated subscribe/unsubscribe, update forwarding, list invalidation, cleanup, and the stable `RESOURCE_SUBSCRIPTION_UNSUPPORTED` failure. The published-v1.1.2 `packaged-test` proves exactly one initialized subscribe, one namespaced update, one unsubscribe, and clean shutdown for both routed upstreams. It receives zero advertised tools/resources/prompts list-change notifications; #413 owns that discrepancy. Modern request-scoped HTTP explicitly does not probe or advertise connection-bound subscriptions.
- **Migration required:** each subscriber needs an exact re-list, polling, or future extension workflow with bounded frequency, cache invalidation, and an actionable compatibility diagnostic.
- **Missing evidence:** real subscriber inventory, acceptable polling behavior, named-host notification transcripts, and proof that no retained upstream or cross-profile event leaks after migration.
- **Decision:** defer.

### Legacy form-elicitation bridge for approvals

- **Shipped contract:** the legacy SDK shim exposes Miftah's integrity-bound, one-time approval continuation as form elicitation; the modern path uses `input_required`, `requestState`, and `inputResponses`.
- **Owners:** `src/runtime/create-miftah-runtime.ts`, the approval continuation store, and the MCP server operation pipeline.
- **Current evidence:** `source-test` proves modern continuation across request-scoped server instances and legacy fallback behavior. Cross-process continuation is not claimed.
- **Migration required:** exact initialized clients must demonstrate the modern input-required flow, cancellation, expiry, replay rejection, and redacted audit results.
- **Missing evidence:** packaged named-host UI/runtime transcripts and user recovery behavior when a host cannot render the modern flow.
- **Decision:** defer with the initialized era; do not remove it independently without its own evidence.

### Upstream `transport: "sse"`

- **Shipped contract:** `sse` remains a deprecated public configuration input. It is independent of the downstream protocol era and has no remote session DELETE equivalent.
- **Owners:** the public config schema, remote upstream transport construction, OAuth connection lifecycle, and upstream session manager.
- **Current evidence:** `source-test` covers configuration and remote transport behavior. New presets generate `streamable-http`; the compatibility source of truth names `streamable-http` as the migration target.
- **Migration required:** verify that the provider exposes a Streamable HTTP endpoint, change the reviewed transport and endpoint together, re-establish OAuth binding when issuer or endpoint identity changes, and prove lifecycle, cancellation, progress, and safe error behavior.
- **Missing evidence:** an inventory of real `sse` configurations and upstream versions, a tested state-preserving migration command or procedure, and provider-specific rollback proof.
- **Decision:** defer.

### Public SDK v1 `createMiftahRuntime` host path

- **Shipped contract:** package consumers may import `createMiftahRuntime`, supply an MCP transport, and host Miftah with the monolithic SDK v1 `StdioServerTransport`. The compatible v1 SDK remains an installed runtime dependency for this public path.
- **Owners:** `src/runtime/create-miftah-runtime.ts`, `src/index.ts`, `docs/library-api.md`, package exports/dependencies, and the clean-package test fixture.
- **Current evidence:** `source-test` protects the public export. `packaged-test` compiles and executes the legacy SDK consumer from a clean installed tarball. The v2 factory is separately exercised by CLI, HTTP, dual-era, plugin-routing, and authenticated-context tests.
- **Migration required:** consumers must move to `createMiftahServerFactory` with the SDK v2 serving entry and reproduce their lifecycle, transport, plugin, routing, and shutdown integration.
- **Missing evidence:** identified external consumers, their TypeScript/build constraints, installed-artifact migration transcripts, and confirmation that dropping the v1 dependency does not reintroduce an unsafe transitive resolution.
- **Decision:** defer to a major release.

## Adjacent compatibility contracts needing explicit scope

The public upstream `transport: "http"` v1 alias and OAuth Dynamic Client Registration fallback also have modern targets (`streamable-http` and Client ID Metadata Documents respectively). Their documentation says they are compatibility behavior with future removal boundaries, but #388 does not yet contain enough direct evidence to merge them into one implementation scope. Record their usage separately and either add them to a maintainer-approved #388 decision or create independent retirement gates. Do not remove them opportunistically with the core legacy protocol work.

Sampling, MCP Logging, standalone downstream HTTP+SSE, Tasks, MCP Apps, and Enterprise Managed Authorization are not removal candidates because Miftah does not implement or advertise them. Their non-support remains part of the compatibility contract.

## Current client and artifact evidence

| Client or artifact | Version and evidence | Proven operations | Boundary |
| --- | --- | --- | --- |
| Official MCP TypeScript packages | `2.0.0`; broad `source-test` coverage, clean-tarball contracts, and the exact published-v1.1.2 STDIO record below | Source tests cover modern and initialized STDIO/HTTP negotiation, tools, MRTR, headers, caching, cancellation, and session lifecycle. Published-package proof covers initialized Roots refresh, subscribe/update/unsubscribe, and shutdown | Reference client only; no named-host or usage evidence. Published v1.1.2 delivered zero advertised list changes and zero upstream cancellation notifications; see #413 |
| MCP Inspector | `2.1.0`; `packaged-test` on Linux Node 22 | `tools/list` over installed-package STDIO and modern Streamable HTTP | No UI, OAuth, legacy HTTP, Roots, subscription, or notification claim |
| Claude Code `2.1.228` observed on macOS | `configuration-shape` | Generated project STDIO configuration and permission guidance | No packaged runtime transcript |
| Claude Desktop `1.26832.0` observed on macOS | `configuration-shape` | Generated `mcpServers` STDIO configuration | No headless packaged runtime transcript |
| VS Code `1.132.0` (`df53daabb18cd157bdb08c7f01c34df936cf12f4`, arm64) observed on macOS | `configuration-shape` | Generated STDIO configuration | No packaged runtime transcript |
| Cursor | Not installed in the 2026-08-12 audit environment; `configuration-shape` only | Generated STDIO configuration | No version or runtime claim |

This matrix inherits the named-host observation date and claim boundaries from [MCP protocol and client compatibility](mcp-compatibility.md). A version observation is not evidence that the host used Miftah.

## Published package evidence records

### Initialized STDIO reference client — 2026-08-14

| Field | Recorded value |
| --- | --- |
| Author and evidence class | Miftah maintainer; `packaged-test` |
| Package | Exact `@lubab/miftah@1.1.2`; integrity and SLSA provenance match the immutable baseline above |
| Environment | macOS 26.3 arm64 (`Darwin 25.3.0`), Node 22.9.0, npm 11.12.1; exact npm install with lifecycle scripts disabled |
| Downstream | Official `@modelcontextprotocol/client@2.0.0`, process STDIO, negotiated `2025-11-25` |
| Upstream | Deterministic fake STDIO upstream `1.0.0`; no provider or named-host claim |
| Reviewed fixture | `tests/fixtures/legacy-stdio-artifact-consumer.mjs`, SHA-256 `bd4e1fb6d14fe16574a9de3a0fe0de33ccb5233cd39d9b00c073838b3457d5f0`; embeds the redacted two-profile configuration shape |
| Positive result | One initial Roots request selected `personal`; one list-changed Roots refresh selected `work`; one subscribe produced one update; one unsubscribe completed; both routed upstreams shut down; stderr was empty |
| Limitation | Although all three list-change capabilities were advertised, the client received zero tools/resources/prompts list changes. A locally aborted request produced zero upstream cancellation notifications and zero cancelled audit events; the terminal audit result was `failure` / `UPSTREAM_CALL_FAILED`. Tracked by [#413](https://github.com/mohanagy/miftah/issues/413) |
| Claim boundary | Reference-client packaged evidence only. Not a desktop-host transcript, usage attestation, approval/UI result, Streamable HTTP result, or migration proof |

Deidentified transcript:

```json
{"protocol":"2025-11-25","roots":{"initialized":"personal","refreshed":"work","requests":2},"subscriptions":{"advertised":true,"updateForwarded":true,"subscribeCount":1,"unsubscribeCount":1},"listChanges":{"advertised":true,"tools":false,"resources":false,"prompts":false},"cancellation":{"downstreamRejected":true,"upstreamNotifications":0,"terminalAuditEvents":0,"lastAuditStatus":"failure","lastAuditErrorCode":"UPSTREAM_CALL_FAILED"},"cleanup":{"personal":true,"work":true},"stderrEmpty":true}
```

The same fixture runs against a clean tarball from current `development`; that reproducibility check is not a substitute for the exact published-package record. Windows Node 20 produced the same zero-upstream-cancellation limitation but recorded the local terminal audit as `cancelled` / `REQUEST_CANCELLED`, so the package contract accepts that platform-specific audit improvement while continuing to require zero forwarded cancellations until #413 is repaired.

## Required evidence record

Every new compatibility record must include:

- date and evidence author;
- exact `@lubab/miftah` version, npm integrity, and provenance result;
- OS, architecture, Node version, and installation method;
- exact client/upstream name, version, build hash when available, and source;
- downstream transport and negotiated protocol era;
- upstream transport and exact upstream package/service version;
- redacted configuration shape and a hash of the reviewed fixture;
- operations attempted, expected result, observed result, cleanup result, and known limitations;
- whether the evidence is source, packaged, named-host runtime, usage, or rollback evidence;
- a deidentified transcript or durable CI URL that contains no token, email, property list, path, approval input, or raw provider response.

## Rollback proof contract

The exact rollback target for any future incompatible candidate is `@lubab/miftah@1.1.2` at the source, tag, integrity, and provenance values above.

Before testing a candidate:

1. Use an isolated copy of each reviewed fixture. Record hashes and permissions for configuration, workspace/global profile state, approval state, OAuth references/provider storage, and audit JSONL. Do not use a live operator profile.
2. Install the candidate and baseline as exact packaged artifacts in separate prefixes. Do not publish or overwrite the baseline.
3. Exercise the affected initialization, routing, profile, approval, OAuth, audit, cancellation, notification, and shutdown paths with fixed non-secret fixtures.
4. Roll back only through the documented package/config migration path to exact 1.1.2. Run `miftah doctor`, schema/config validation, and the retained packaged-client operations.
5. Compare the recorded state. Configuration and security-sensitive state must either be byte-identical or have a documented reversible transform. Audit history must remain append-only and readable. No approval may be replayable, no OAuth binding may change accounts, and no profile selection may silently broaden scope.

**Rollback status: pending.** A meaningful `rollback-rehearsal` cannot run until an evidence-backed incompatible candidate and its migration exist. A fresh 1.1.2 install, provenance, signatures, package import, CLI execution, and zero-known-vulnerability audit have passed; those checks establish the target artifact, not candidate rollback safety.

## Security and privacy gates

Any future decision and implementation issue must show that:

- removing sessionful HTTP cannot move profile, approval, or routing state into an unauthenticated mutable global;
- replacing Roots cannot trust client paths as identity and preserves boundary, size, race, and redaction controls;
- replacing subscriptions cannot retain stale upstream sessions or leak updates across profiles or principals;
- cancellation reaches the selected upstream, releases the session/lease, and records one terminal `cancelled` audit result;
- changing an upstream transport or OAuth registration mode preserves issuer and account binding or requires an explicit reconnect;
- migration and failure diagnostics contain no bearer token, email, property list, local path, request arguments, approval response, or raw upstream error;
- rolling back does not weaken filesystem permissions, revive approvals, truncate audit data, or silently choose a different active profile.

## Decision and next gates

The current evidence supports **keep and collect**, not retire:

- internal source and deterministic tests describe the shipped behavior;
- the exact v1.1.2 artifact is published, reproducible, and signature/provenance verified;
- exact published-package STDIO evidence proves Roots, resource subscription/update/unsubscribe, and cleanup while exposing the merge-blocking list-change and cancellation defects in #413;
- named desktop-host runtime evidence, real configuration usage, exact per-surface migration proof, and candidate rollback proof are still missing.

Next evidence work:

1. Repair and re-run the packaged initialized STDIO list-change and cancellation boundary under #413.
2. Add exact published-package legacy Streamable HTTP evidence beyond `tools/list`, including approval, cancellation, session cleanup, and known limitations.
3. Collect deidentified exact-version transcripts for the named hosts that actually exercise Miftah, without upgrading a configuration-shape row into a runtime claim prematurely.
4. Collect maintainer-reviewed samples of real initialized, Roots, subscription, upstream `sse`, and SDK v1 library usage. Record zero observations as sample results, not proof of no usage.
5. Write and test one exact migration per observed workflow.
6. Run the rollback contract against a future incompatible candidate.
7. Obtain explicit maintainer approval on the evidence-backed keep/defer/retire decision.
8. Only then create a separate bounded retirement implementation issue and major-version release plan.
