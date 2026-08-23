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

### Initialized legacy serving over STDIO

- **Shipped contract:** the SDK v2 serving entry selects the frozen legacy adapter, performs `initialize` and `notifications/initialized`, and owns one Miftah runtime for the client connection. Reference and release gates pin `2025-11-25`; the pinned adapter retains its compatibility revision set, and the exact Codex CLI transcript below observed `2025-06-18`. That observation is not a blanket compatibility guarantee for every older revision. Roots and resource subscriptions remain capability-gated.
- **Owners:** `src/cli/main.ts`, `src/runtime/create-miftah-runtime.ts`, and the `@modelcontextprotocol/server-legacy` dependency.
- **Current evidence:** `source-test` in `tests/mcp-v2-serving.test.ts` negotiates `2025-11-25`, exposes tools, distinguishes legacy subscription and cache behavior from the modern STDIO path, and forwards list changes plus cancellation through the SDK v2 initialized boundary. The corrected exact published-v1.1.2 `packaged-test` below drives the installed CLI process and proves initialized Roots routing and refresh, resource subscribe/update/unsubscribe, active-profile list changes, cancellation, terminal audit outcome, and cleanup with the official client. The exact published-v1.1.3 Codex CLI 0.148.0 `named-host-runtime` record negotiates initialized `2025-06-18`, lists tools once, calls one tool once, records successful audits, and shuts down the deterministic upstream.
- **Migration required:** the exact client must negotiate `2026-07-28` through the SDK v2 entry. A future failure must name the retained revision and give an actionable client-upgrade or pinned-baseline path.
- **Missing evidence:** additional named-host STDIO feature transcripts, usage evidence for initialized-only clients, a packaged STDIO approval transcript, and proof that real profile, Roots, confirmation, resource, notification, and cancellation workflows survive migration.
- **Decision:** defer.

### Initialized `2025-11-25` Streamable HTTP sessions

- **Shipped contract:** legacy initialization creates a bounded runtime keyed by `Mcp-Session-Id`. Profile state is session-scoped. Admission limits, idle expiry, interrupted response-stream reconnection, client termination, initialization failure, and shutdown own cleanup of the runtime, upstream sessions, and transport.
- **Owners:** `src/http/miftah-http-server.ts`, `src/runtime/create-miftah-runtime.ts`, and `src/profiles/profile-state.ts`.
- **Current evidence:** `source-test` in `tests/mcp-v2-serving.test.ts` proves legacy negotiation and session creation. `tests/http-server.test.ts` covers concurrent session isolation, reconnection, capacity, idle expiry, DELETE cleanup, retained upstream release, and shutdown failures. The exact published-v1.1.2 `packaged-test` below drives the installed HTTP CLI with the official client, receives a real `Mcp-Session-Id`, completes one redacted form-elicitation approval, forwards one cancellation with explicit terminal audit evidence, explicitly terminates the session, proves the retained ID returns HTTP 404, and proves retained-upstream cleanup.
- **Migration required:** clients must use request-scoped `2026-07-28`, stop depending on initialization, GET reconnection, DELETE session lifecycle, or mutable session profile state, and use an authenticated application-state boundary where cross-request profile context is required.
- **Missing evidence:** named-host client behavior, real usage, an operator migration for every session-dependent workflow, and candidate rollback proof.
- **Decision:** defer.

### Roots-derived routing context

- **Shipped contract:** initialized clients may advertise Roots and send `notifications/roots/list_changed`. Only normalized `file:` roots are accepted. The deepest root containing the working directory bounds project-marker, package, workspace, and Git-origin discovery; environment and strict project markers may contribute profile hints.
- **Owners:** `src/mcp/server/miftah-server.ts`, `src/routing/context-collector.ts`, and the routing engine.
- **Current evidence:** `source-contract` shows bounded 64 KiB metadata reads, real-path boundary checks, symlink-swap checks, local Git config without includes, stripped `GIT_*` process input, URI redaction, ignored malformed/non-file Roots, and `ROUTING_PROFILE_NOT_FOUND` for an unknown hinted profile. The published-v1.1.2 `packaged-test` performs one initialized Roots request, routes to `personal`, sends `notifications/roots/list_changed`, performs one refresh, and routes the next call to `work`.
- **Migration required:** every affected workflow needs an explicit replacement using reviewed configuration, environment, project marker, or a separately approved modern context extension. The replacement must retain boundary and redaction properties and must not infer trusted identity from a path.
- **Missing evidence:** which real clients send Roots, which routing rules depend on them, and whether users can migrate without ambiguous or incorrect profile selection.
- **Decision:** defer.

### Resource subscriptions and list-changed notifications

- **Shipped contract:** initialized runtimes advertise resource subscriptions only when every selectable upstream supports them. Resource updates are forwarded, and profile transitions, upstream lifecycle changes, restarts, session termination, and shutdown invalidate or unsubscribe retained state. Direct-runtime source tests and the corrected exact published-v1.1.2 transcript forward tools/resources/prompts list changes from the active catalog profile.
- **Owners:** `src/mcp/server/miftah-server.ts`, `src/mcp/server/resource-prompt-registry.ts`, and `src/upstream/upstream-session.ts`.
- **Current evidence:** `source-test` covers capability-gated subscribe/unsubscribe, update forwarding, list invalidation, cleanup, and the stable `RESOURCE_SUBSCRIPTION_UNSUPPORTED` failure. The corrected published-v1.1.2 `packaged-test` proves exactly one initialized subscribe, one namespaced update, one unsubscribe, all three advertised active-profile list changes, and clean shutdown for both routed upstreams. Modern request-scoped HTTP explicitly does not probe or advertise connection-bound subscriptions.
- **Migration required:** each subscriber needs an exact re-list, polling, or future extension workflow with bounded frequency, cache invalidation, and an actionable compatibility diagnostic.
- **Missing evidence:** real subscriber inventory, acceptable polling behavior, named-host notification transcripts, and proof that no retained upstream or cross-profile event leaks after migration.
- **Decision:** defer.

### Legacy form-elicitation bridge for approvals

- **Shipped contract:** the legacy SDK shim exposes Miftah's integrity-bound, one-time approval continuation as form elicitation; the modern path uses `input_required`, `requestState`, and `inputResponses`.
- **Owners:** `src/runtime/create-miftah-runtime.ts`, the approval continuation store, and the MCP server operation pipeline.
- **Current evidence:** `source-test` proves modern continuation across request-scoped server instances and legacy fallback behavior. The exact published-v1.1.2 initialized HTTP `packaged-test` records one form elicitation, the `requested` / `approved` / `consumed` lifecycle, exactly one upstream execution, a redacted `success` terminal audit, and no terminal error code. Cross-process continuation is not claimed.
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
| Official MCP TypeScript packages | `2.0.0`; broad `source-test` coverage, clean-tarball contracts, and exact published-v1.1.2 STDIO and Streamable HTTP records below | Source tests cover modern and initialized STDIO/HTTP negotiation, tools, MRTR, headers, caching, cancellation, and session lifecycle. Published-package proof covers initialized STDIO Roots, subscriptions, active-profile list changes, cancellation, and shutdown plus initialized HTTP session assignment, one redacted approval, cancellation, terminal audits, explicit termination with a 404 probe, and retained-upstream cleanup | Reference client only; no named-host, usage, migration, or rollback evidence |
| MCP Inspector | `2.1.0`; `packaged-test` on Linux Node 22 | `tools/list` over installed-package STDIO and modern Streamable HTTP | No UI, OAuth, legacy HTTP, Roots, subscription, or notification claim |
| Codex CLI `0.148.0` on macOS 26.3 arm64 | `named-host-runtime` against exact published Miftah 1.1.3 | Initialized STDIO `2025-06-18`, one successful `tools/list`, one successful `tools/call`, matching audits, initialization, and upstream shutdown | One fake-upstream tool only; no broader legacy-feature, provider, usage, migration, or rollback claim |
| Claude Code `2.1.235` on macOS 26.3 arm64 | `named-host-runtime` against exact published Miftah 1.1.3 | Modern STDIO `2026-07-28`, successful prompt/resource/tool discovery, one successful `tools/call`, matching audits, initialization, and upstream shutdown | One fake-upstream tool only; no approval, OAuth, HTTP, provider, usage, migration, or rollback claim |
| Claude Desktop `1.34493.1` on macOS 26.3 arm64, observed 2026-08-23 | `named-host-runtime` against exact published Miftah 1.1.3 after a blocked first attempt | Initialized STDIO `2025-11-25`, successful prompt/resource/tool discovery, one successful `tools/call`, matching audits, native **Allow once** approval, initialization, and upstream shutdown | One fake-upstream call only; Desktop also started one isolated list-only companion session; no broader legacy-feature, provider, usage, migration, or rollback claim |
| VS Code `1.132.0` (`df53daabb18cd157bdb08c7f01c34df936cf12f4`, arm64) observed on macOS | `configuration-shape` | Generated STDIO configuration | No packaged runtime transcript |
| Cursor | Not installed in the 2026-08-12 audit environment; `configuration-shape` only | Generated STDIO configuration | No version or runtime claim |

This matrix inherits the named-host observation date and claim boundaries from [MCP protocol and client compatibility](mcp-compatibility.md). Codex CLI, Claude Code, and Claude Desktop have the bounded exact-package runtime evidence stated above; every other version-only observation remains configuration-shape evidence.

### Claude Desktop runtime attempt — 2026-08-23

This attempt stopped before a Desktop protocol exchange, so it is **not** `named-host-runtime` evidence.

| Field | Recorded value |
| --- | --- |
| Observed host | Claude Desktop `1.34493.1`; macOS 26.3 arm64 |
| Intended package | Exact published `@lubab/miftah@1.1.3`; npm shasum `b78879cd67541ea73796d242e0498e26e2f17002`; integrity `sha512-kqA/x/bUlS8wDN3MMd7H2RJyyELSrADDg3IiubUOSX3uAc2NeZ1TYavzVNj+H2LUhlFE2lZ54FTpEb/5w7pK2g==` |
| Existing state | Claude Desktop was running with an existing user-owned configuration, and its launched Miftah executable reported `1.1.2`. No configuration content, credential, account metadata, prompt, response, or session identifier was read or copied. |
| Isolation result | Anthropic's [local MCP setup guide](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop) documents Desktop Extensions through the app's Extensions settings. Its [local-versus-remote connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) identifies local servers configured through `claude_desktop_config.json` as a separate mechanism. Neither source documents a supported isolated Desktop profile/configuration switch. Undocumented application strings were not treated as a supported isolation contract. |
| Outcome | The maintainer declined to read, copy, overwrite, or restart the live Desktop setup. Generated configuration remains `configuration-shape` evidence only. |

Required handoff for a valid retry:

1. Use a separate macOS test user with fresh Claude Desktop state; the maintainer signs in through the app without sharing credentials or session material.
2. In an isolated working directory, install exact `@lubab/miftah@1.1.3` and verify the version, npm integrity, provenance, and installed CLI hash. Use the deterministic fake upstream and recorder from source commit `22d997379573bb812d9d5f89c84613f238e3bb9c`.
3. Create one non-secret Miftah profile whose STDIO upstream is the absolute Node executable plus `tests/fixtures/fake-upstream.mjs`. Use only fixed marker and audit files inside that isolated directory.
4. Add one entry only to the test user's Desktop `mcpServers`. Its absolute command and argument array must launch Node, then `named-host-stdio-recorder.mjs`, then the exact installed Miftah CLI with `--config` pointing to the fixture configuration. Restart Desktop in that test user.
5. In a new Desktop conversation, confirm the test connector is available and invoke the deterministic upstream's `whoami` tool once with `{}`. Do not use a real provider or account profile.
6. Exit Desktop cleanly, then verify the recorder, redacted Miftah audit entries, upstream initialization, list/call counts, expected non-secret fixture result, shutdown marker, and process exit state.
7. Persist only the same bounded fields as `tests/fixtures/named-host-v1.1.3-evidence.json`. Do not commit the raw host transcript, prompts, arguments, tool content, local paths, session identifiers, account metadata, audit file, or marker files.

The later retry used the maintainer-approved alternative of a byte-for-byte backup, temporary one-connector replacement, and byte-for-byte restoration in the existing macOS account. Desktop launched two MCP sessions, so the shared-file first retry was rejected as evidence. `tests/fixtures/named-host-desktop-launcher.mjs` then assigned each Desktop session its own Miftah configuration, recorder output, audit journal, and marker files. This kept the primary `claude-ai` call transcript distinct from the list-only `local-agent-mode` companion session.

## Published package evidence records

### Initialized STDIO reference client — 2026-08-14

| Field | Recorded value |
| --- | --- |
| Author and evidence class | Miftah maintainer; `packaged-test` |
| Package | Exact `@lubab/miftah@1.1.2`; integrity and SLSA provenance match the immutable baseline above |
| Environment | macOS 26.3 arm64 (`Darwin 25.3.0`), Node 22.9.0, npm 11.12.1; exact npm install with lifecycle scripts disabled |
| Downstream | Official `@modelcontextprotocol/client@2.0.0`, process STDIO, negotiated `2025-11-25` |
| Upstream | Deterministic fake STDIO upstream `1.0.0`; no provider or named-host claim |
| Reviewed fixture | `tests/fixtures/legacy-stdio-artifact-consumer.mjs`, SHA-256 `fe99b4aefc50101a174a905b00ab8c1f4e38f998fc1e59d57d8153bcfdb09fd2`; embeds the redacted two-profile configuration shape |
| Positive result | One initial Roots request selected `personal`; one list-changed Roots refresh selected `work`; one subscribe produced one update; one unsubscribe completed; all three active-profile list changes arrived; one downstream abort produced one upstream cancellation and one `cancelled` / `REQUEST_CANCELLED` audit terminal; both routed upstreams shut down; stderr was empty |
| Evidence correction | The prior fixture emitted list changes from a Roots-routed non-active profile and reused a stale call-start marker, allowing abort before the cancellable call reached the upstream. The corrected causal barriers prove the published runtime behavior without a runtime code change; tracked by [#413](https://github.com/mohanagy/miftah/issues/413). |
| Claim boundary | Reference-client packaged evidence only. Not a desktop-host transcript, usage attestation, approval/UI result, Streamable HTTP result, or migration proof |

Deidentified transcript:

```json
{"protocol":"2025-11-25","roots":{"initialized":"personal","refreshed":"work","requests":2},"subscriptions":{"advertised":true,"updateForwarded":true,"subscribeCount":1,"unsubscribeCount":1},"listChanges":{"advertised":true,"tools":true,"resources":true,"prompts":true},"cancellation":{"downstreamRejected":true,"upstreamNotifications":1,"terminalAuditEvents":1,"lastAuditStatus":"cancelled","lastAuditErrorCode":"REQUEST_CANCELLED"},"cleanup":{"personal":true,"work":true},"stderrEmpty":true}
```

The same corrected fixture runs against a clean tarball from current `development`; that reproducibility check is not a substitute for the exact published-package record. The package contract requires the same exact positive list-change, cancellation, and audit outcome across supported CI operating systems and Node versions.

### Initialized Streamable HTTP reference client — 2026-08-15

| Field | Recorded value |
| --- | --- |
| Author and evidence class | Miftah maintainer; `packaged-test` |
| Package | Exact `@lubab/miftah@1.1.2`; npm integrity `sha512-irvuGcic5EzsZc3cLEiw8+31Vnua5qjdU3l1gztl6q8I9RJQyCNLopVyolxRmmtoqHAoe+3803AvNy8V0ihvmw==`; SLSA provenance matches the immutable baseline above |
| Environment | macOS 26.3 arm64 (`Darwin 25.3.0`), Node 22.9.0, npm 11.12.1; fresh exact npm install with lifecycle scripts disabled |
| Downstream | Official `@modelcontextprotocol/client@2.0.0`, Streamable HTTP, negotiated `2025-11-25`, non-empty real `Mcp-Session-Id` retained only as a boolean in the deidentified transcript |
| Upstream | Deterministic fake STDIO upstream `1.0.0`; no provider or named-host claim |
| Reviewed fixture | `tests/fixtures/legacy-http-artifact-consumer.mjs`, SHA-256 `0354ae23f54a2eec27e9e7ab4a6741c5e10086ea16188e3aadcc1064ecbfd4c8`; embeds one non-secret work profile, form-elicitation policy, audit path, and bounded process/HTTP settings |
| Positive result | One form elicitation was accepted; approval audit actions were exactly `requested`, `approved`, `consumed`; the tool executed once; its terminal audit was `success` with no error code; one downstream abort produced exactly one upstream cancellation and one `cancelled` / `REQUEST_CANCELLED` terminal; explicit session termination succeeded and a request with the retained ID returned HTTP 404; retained work upstream cleanup completed; stderr was empty; the synthetic argument was absent from both elicitation and audit records |
| Known limitations | Reference client and deterministic fake upstream only; one profile, approval, cancellation, and close workflow; no named desktop host, provider, usage, reconnection, capacity, idle-expiry, migration, rollback, or retirement-approval claim. The broader lifecycle cases remain source-test evidence. |
| Claim boundary | Exact published-package evidence for only the named client, transport, protocol, operations, environment, and fixture. It does not authorize removal. |

Deidentified transcript:

```json
{"protocol":"2025-11-25","session":{"mcpSessionIdAssigned":true,"terminationProbeStatus":404,"closed":true},"approval":{"elicitationCount":1,"actions":["requested","approved","consumed"],"toolExecutions":1,"terminalAuditStatus":"success","terminalAuditErrorCode":null,"sensitiveArgumentRedacted":true},"cancellation":{"downstreamRejected":true,"upstreamNotifications":1,"terminalAuditEvents":1,"lastAuditStatus":"cancelled","lastAuditErrorCode":"REQUEST_CANCELLED"},"cleanup":{"work":true},"stderrEmpty":true}
```

The same reviewed fixture runs against a clean tarball from current `development`; that reproducibility check is not a substitute for the exact published-package record. The package contract requires this exact approval, cancellation, audit, session-close, cleanup, redaction, and stderr outcome across supported CI operating systems and Node versions.

### Codex CLI and Claude Code named hosts — 2026-08-23

| Field | Recorded value |
| --- | --- |
| Author and evidence class | `Miftah maintainer`; `named-host-runtime` |
| Package | Exact `@lubab/miftah@1.1.3`; integrity `sha512-kqA/x/bUlS8wDN3MMd7H2RJyyELSrADDg3IiubUOSX3uAc2NeZ1TYavzVNj+H2LUhlFE2lZ54FTpEb/5w7pK2g==`; npm SLSA provenance predicate v1; installed CLI SHA-256 `1770a7e7efcad12f8ed8f59665d654a9f94bacf96fe8c6fdb48ddb3d31337541` |
| Environment | macOS 26.3 arm64 (`Darwin 25.3.0`), Node 22.22.3, npm 11.12.1; fresh exact npm install |
| Upstream | Deterministic fake STDIO upstream `1.0.0`; entry SHA-256 `ded19a9fae8c1d0b89adb75db88742346ed3206a280833709ba80f4686535135`; bundle SHA-256 `ec6a8e56de03194d0c607d26f6c4098348a0afd2e2d2d894eed46fed50bd7029` |
| Recorder | `tests/fixtures/named-host-stdio-recorder.mjs`, SHA-256 `8cf6ac0df8d75691a5b8e6633f0185e75f40c2f3e77eac401d7b1bd92db7004a`; byte parser `tests/fixtures/named-host-recorder-parser.mjs`, SHA-256 `96d9fa6f1c6622c7a5765d7f3784cceb0f2d2b55df0f60086102510b455c4795`; persists only client/server name and version, protocol, operation name/count/status, initialized notification, and process exit state |
| Reviewed configuration | One non-secret `work` profile and fixed marker/audit paths. Executed SHA-256 values: Codex Miftah `5d6426878d55518ded1bfdc8eab5e5ad82acd4c61cd9edb0ed3b4d74a24d95d8`; Claude Miftah `58f1a054b6011d7a1febffe656a8c97140e83980ee9eb24ad1dd568cdf39dc9b`; Claude host `047e27701b75a4b451dc0d2890c800615d038121d56334ebcbb5791992e0e649`. The redacted shape is retained in `tests/fixtures/named-host-v1.1.3-evidence.json`. |
| Privacy boundary | Raw host JSON and audit JSONL are not committed. The normalized record excludes prompts, arguments, content, session/request identifiers, paths, environment secrets, account metadata, and model usage/cost. |

Codex CLI normalized result:

```json
{"host":"Codex CLI","version":"0.148.0","clientInfo":"codex-mcp-client/0.148.0","transport":"stdio","era":"initialized","protocol":"2025-06-18","initializedNotification":true,"operations":{"tools/list":{"requests":1,"success":1,"error":0},"tools/call":{"requests":1,"success":1,"error":0}},"auditStatuses":["tools/list:success","tools/call:success"],"upstream":{"initialized":true,"shutdown":true},"process":{"exitCode":null,"signal":"SIGTERM","spawnError":null},"toolResultMatchedFixture":true}
```

Codex approval policy `never` rejected the MCP tool call before upstream execution; the successful evidence run used Codex `--approve-for-me`. The host ended the MCP process with `SIGTERM`, while Miftah still produced the deterministic upstream shutdown marker. This proves only one list and one call; the observed `2025-06-18` revision does not declare every older initialized revision compatible.

Claude Code normalized result:

```json
{"host":"Claude Code","version":"2.1.235","clientInfo":"claude-code/2.1.235","transport":"stdio","era":"modern","protocol":"2026-07-28","initializedNotification":false,"operations":{"prompts/list":{"requests":1,"success":1,"error":0},"resources/list":{"requests":1,"success":1,"error":0},"tools/list":{"requests":1,"success":1,"error":0},"tools/call":{"requests":1,"success":1,"error":0}},"auditStatuses":["prompts/list:success","resources/list:success","tools/list:success","tools/call:success"],"upstream":{"initialized":true,"shutdown":true},"process":{"exitCode":0,"signal":null,"spawnError":null},"toolResultMatchedFixture":true}
```

Claude Code used a strict isolated MCP configuration, empty setting sources, no session persistence, and an allowlist containing only the named Miftah tool. This proves only the listed discovery calls and one tool call; it does not prove Roots, subscriptions, cancellation, approval continuation, OAuth, Streamable HTTP, real provider usage, migration, or rollback.

### Claude Desktop named host — 2026-08-23

| Field | Recorded value |
| --- | --- |
| Author and evidence class | `Miftah maintainer`; `named-host-runtime` |
| Host | Claude Desktop `1.34493.1` (`com.anthropic.claudefordesktop`) on macOS 26.3 arm64 |
| Package | Exact published `@lubab/miftah@1.1.3`; integrity `sha512-kqA/x/bUlS8wDN3MMd7H2RJyyELSrADDg3IiubUOSX3uAc2NeZ1TYavzVNj+H2LUhlFE2lZ54FTpEb/5w7pK2g==`; installed CLI SHA-256 `1770a7e7efcad12f8ed8f59665d654a9f94bacf96fe8c6fdb48ddb3d31337541` |
| Environment | Node 22.22.3, npm 12.0.2; isolated exact install; no real provider or account profile |
| Recorder | Existing recorder and parser hashes above, plus per-session launcher `tests/fixtures/named-host-desktop-launcher.mjs`, SHA-256 `04d037ea8b1f581022bff297d711b6cdb0bb6e25330fa50bf05c5eeed19d3e2d`; the launcher passes only a bounded non-secret environment and gives each Desktop session isolated HOME/XDG directories |
| Reviewed configuration | One non-secret `work` profile; each Desktop session received unique fixed marker/audit paths and isolated HOME/XDG directories. The primary executed Miftah configuration SHA-256 was `8026fcb36afba52b831d2fc634c797b414473207bb4687b324e47a4a22288b33`. |
| Privacy boundary | The original Desktop configuration was backed up and restored byte-for-byte. Raw host JSON, audit JSONL, prompts, arguments, tool content, local paths, session identifiers, account metadata, and marker files are not committed. |

Normalized primary result:

```json
{"host":"Claude Desktop","version":"1.34493.1","clientInfo":"claude-ai/0.1.0","transport":"stdio","era":"initialized","protocol":"2025-11-25","initializedNotification":true,"operations":{"prompts/list":{"requests":1,"success":1,"error":0},"resources/list":{"requests":1,"success":1,"error":0},"tools/list":{"requests":1,"success":1,"error":0},"tools/call":{"requests":1,"success":1,"error":0}},"auditStatuses":["prompts/list:success","resources/list:success","tools/list:success","tools/call:success"],"upstream":{"initialized":true,"shutdown":true},"process":{"exitCode":null,"signal":"SIGTERM","spawnError":null},"toolResultMatchedFixture":true}
```

The native **Allow once** approval was observed manually in the Desktop UI; it was not a recorder-persisted transcript field. Desktop also started one independently isolated `local-agent-mode-miftah-evidence-425/1.0.0` session. It negotiated initialized `2025-11-25`, completed one `tools/list`, made no tool call, and exited cleanly. The primary transcript proves only the listed discovery operations and one approved fake-upstream call; the internal `claude-ai/0.1.0` metadata is not the Desktop application version.

### Public usage sampling — 2026-08-23

Issue #430 records a bounded public-source snapshot in `tests/fixtures/public-usage-sample-2026-08-23.json`. The sample was completed at 2026-08-23T18:43:19Z, under six hours after `@lubab/miftah@1.1.3` was published. It is a `usage-sampling-record` with no qualifying `usage-attestation`, not a representative adoption study or retirement authorization.

Method:

- GitHub code search used eleven direct product-anchored queries covering the package, CLI/configuration markers, initialized `2025-11-25`, Roots, resource subscription/list-change, upstream `sse`, and SDK v1 entry points. Every query excluded `mohanagy/miftah`, returned `incomplete_results: false`, and recorded the exact total count.
- GitHub issue and pull-request search used the package and CLI anchors. Included and excluded candidates were deduplicated by stable URL.
- Inclusion required a direct Miftah product anchor and public evidence. The Miftah repository, forks, mirrors, generated examples, and unrelated uses of the word “miftah” were excluded.
- npm activity came only from the public downloads API. Those aggregate counts were kept separate from direct configuration evidence.

Results:

| Surface | Qualifying public samples | Claim boundary |
| --- | ---: | --- |
| Initialized `2025-11-25` | 0 | Not observed in this bounded sample; not evidence of absence |
| Roots | 0 | Not observed in this bounded sample; not evidence of absence |
| Resource subscriptions or list-change | 0 | Not observed in this bounded sample; not evidence of absence |
| Upstream `sse` | 0 | Not observed in this bounded sample; not evidence of absence |
| SDK v1 | 0 | Not observed in this bounded sample; not evidence of absence |
| Real-provider configuration | 0 | Not observed in this bounded public sample; not evidence of absence |

All direct external GitHub code queries returned zero results. The issue/PR queries produced one private result, which was omitted without recording its URL or contents, and one unrelated public lexical false positive. The retained public sample therefore contains zero qualifying public usage samples.

The npm range API reported 147 package downloads from 2026-08-14 through 2026-08-23, and the per-version last-week API reported 58 downloads for 1.1.2. These counts can include CI, bots, caches, repeat installs, and maintainer activity. They are not unique users and cannot identify any protocol, transport, API, configuration, or operator. Version 1.1.3 had no per-version row yet; npm processes download data once per day after UTC midnight, so the same-day zero and missing row are not usable as zero-download evidence.

Only indexed public content was sampled. Private repositories, local configurations, credentials, account metadata, and private telemetry were excluded. GitHub indexing/query semantics and the same-day release window further limit the result. The decision remains **keep and collect**. Repeat no earlier than 2026-09-22, or when an incompatible retirement candidate is next considered, and preserve zero observations literally.

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
- corrected exact published-package STDIO evidence proves Roots, resource subscription/update/unsubscribe, active-profile list changes, cancellation, terminal audit outcome, and cleanup;
- exact published-package Streamable HTTP reference-client evidence proves one initialized session, redacted approval, cancellation, terminal audits, explicit termination with a 404 probe, and retained-upstream cleanup;
- exact published-v1.1.3 named-host evidence proves one initialized Codex CLI list/call exchange, one modern Claude Code prompt/resource/tool discovery plus call exchange, and one initialized Claude Desktop prompt/resource/tool discovery plus natively approved call, each with deterministic cleanup;
- bounded public sampling found no qualifying public usage samples; that zero is not evidence of absence;
- broader named-host feature evidence, independently-owned real configuration usage, exact per-surface migration proof, and candidate rollback proof are still missing.

Next evidence work:

1. Collect deeper feature-specific named-host transcripts without extending any row beyond the exact operations observed.
2. Repeat the bounded public sample no earlier than 2026-09-22 and collect maintainer-reviewed samples of real initialized, Roots, subscription, upstream `sse`, and SDK v1 library usage. Record zero observations as sample results, not proof of no usage.
3. Write and test one exact migration per observed workflow.
4. Run the rollback contract against a future incompatible candidate.
5. Obtain explicit maintainer approval on the evidence-backed keep/defer/retire decision.
6. Only then create a separate bounded retirement implementation issue and major-version release plan.
