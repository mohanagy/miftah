# Library API

`@lubab/miftah` intentionally supports only the package-root exports documented here. Import from `@lubab/miftah`; deep imports into `dist/` or `src/` are internal implementation details and are not compatibility promises.

## Runtime exports

| Export | Purpose |
| --- | --- |
| `MIFTAH_VERSION` | The package version compiled into Miftah's CLI and MCP metadata. |
| `CURRENT_CONFIG_VERSION` | The canonical configuration format written by current Miftah presets and examples. |
| `createMiftahRuntime` | Creates an MCP wrapper from a configuration file without exposing process, profile, or server internals. |
| `ProfileContextHandleService` | Mints, resolves, replaces, and revokes short-lived opaque profile selectors for a trusted modern stateless host. |
| `ProfileContextHandleError` | Fixed-code error class that never includes a handle, decrypted payload, identity claim, or backend detail. |
| `InMemoryProfileContextRevocationStore` | Bounded same-process implementation for tests and single-process hosts; it is not deployment-wide storage. |
| `PROFILE_CONTEXT_ARGUMENT` | Reserved model-visible tool argument carrying a profile-context handle in modern mode. |
| `PROFILE_CONTEXT_META_KEY` | Reserved request metadata key carrying the same handle for methods without tool arguments. |
| `createAuthenticatedRequestContextBoundary` | Derives an opaque deployment and chat binding only from claims verified by a trusted embedding host. |
| `requireAuthenticatedRequestContext` | Fails closed when a modern request has no configured trusted authentication boundary. |
| `AuthenticatedRequestContextError` | Fixed-code error class that carries no identity, provider, request, or key details. |
| `MiftahError` | Error class with stable Miftah error codes and optional diagnostic details. |
| `loadConfig` | Reads, validates, and resolves configuration-relative paths from a JSON file. |
| `validateConfig` | Validates unknown input against Miftah's strict configuration contract. |
| `generateConfigSchema` | Generates the editor-facing JSON Schema for the configuration contract. |
| `presetConfig` | Creates a supported configuration preset in memory. |

`createMiftahRuntime` returns `MiftahRuntime`, which exposes the resolved `config`, `connect(transport)`, and `close()` methods. Its optional `MiftahRuntimeOptions` enables the modern profile-context boundary described below. Supply an MCP SDK transport such as `StdioServerTransport`; transport types are provided by the direct `@modelcontextprotocol/sdk` dependency.

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMiftahRuntime } from "@lubab/miftah";

const runtime = await createMiftahRuntime("./miftah.json");
await runtime.connect(new StdioServerTransport());
```

## Authenticated request context

The additive authenticated request-context API is the trust seam for future modern stateless handling. An embedding host supplies a verifier callback that returns `VerifiedHttpRequestClaims` only after it has authenticated the request. Miftah does not parse MCP `clientInfo`, arbitrary headers, request metadata, tool arguments, or a model-generated conversation ID into this boundary.

`createAuthenticatedRequestContextBoundary` uses separate deployment-managed keys to derive an opaque `binding` and a non-sensitive `auditCorrelation` from the verified issuer, subject, audience, per-chat context, and deployment. Instances in one deployment receive the same binding when configured with the same keys. `assertBinding` fails with `AUTH_CONTEXT_MISMATCH` when any bound value changes. A valid replay within the same authenticated chat is allowed because the binding selects profile context; it is not an authorization credential and does not replace policy, approval, or operation idempotency checks.

Claims are rejected at exact expiry. Provider failures and missing claims return only `AUTH_CONTEXT_UNAVAILABLE`; malformed claims return `AUTH_CONTEXT_INVALID`. Call `requireAuthenticatedRequestContext` in a modern account-sensitive path so an absent boundary cannot silently fall back to client metadata, a mutable default, or durable active-profile state.

The current CLI-owned Streamable HTTP server remains the documented legacy session-aware path and does not synthesize these claims from its static bearer token. Until a supported host supplies a verified per-chat claim and the modern protocol path is enabled, deploy a profile-scoped or operator-locked endpoint and do not claim chat-scoped switching.

## Stateless profile-context handles

`ProfileContextHandleService` is the production account-selection primitive for an embedding host that has already authenticated each modern request. Pass it, together with the host's `AuthenticatedRequestContextBoundary`, through `createMiftahRuntime(configPath, { modernProfileContext })`. The configuration must enable a concrete audit journal so profile transitions cannot silently bypass their required audit commit. The host must provide its verified request result through the MCP SDK `authInfo` request field. Miftah authenticates first and derives the binding only through the configured boundary; it does not trust `clientInfo`, arbitrary headers, raw request `_meta`, tool arguments, or a model-created conversation identifier as identity.

Each handle is a short-lived AES-256-GCM bearer bound to the deployment, sealing-key epoch, existing profile, verified issuer, subject, audience, and trusted per-chat claim. All instances in a deployment must use the same atomic `ProfileContextKeyringSnapshot` and deployment-wide `ProfileContextRevocationStore`. A retained `ProfileContextKeyEpoch` may resolve old handles only during its declared overlap, and an instance rejects minting-key rollback. Key-manager, clock, randomness, and revocation failures fail closed. The audit correlation is produced with a separate key. Never reuse the sealing key, authenticated-context binding key, or either audit key.

`InMemoryProfileContextRevocationStore` is bounded and appropriate only for tests or multiple services in one process. A round-robin or multi-process deployment must provide shared revocation storage whose successful writes are visible to every instance before the API reports completion. The keyring provider and revocation store are trusted deployment infrastructure; the handle contains no OAuth token or upstream credential.

In modern mode, account-sensitive tool schemas include the reserved model-visible `PROFILE_CONTEXT_ARGUMENT`. The first `miftah_use_profile` call may omit it and receives a new handle. A switch requires the current handle, commits a bearer-free audit transition, then revokes the old handle before returning its replacement. Tools that do not carry ordinary arguments use `PROFILE_CONTEXT_META_KEY`. Miftah strips either form before audit argument capture and before every upstream call, rejects duplicate or nested bearer placement, and records only the separately keyed correlation. Tool discovery is derived from configuration and does not change because a prior request selected another profile.

A valid handle selects a profile; it is not operation authorization or idempotency. Policy, approval, identity, lease, OAuth, and upstream checks still run for every request. Missing, malformed, tampered, expired, revoked, cross-principal, cross-chat, cross-deployment, and removed-profile handles return fixed `ProfileContextHandleErrorCode` failures. The modern runtime never reads or mutates `ProfileManager`'s legacy active profile.

The package exports `ProfileContextHandleServiceOptions`, `ModernProfileContextRuntimeOptions`, `MintedProfileContext`, `ResolvedProfileContext`, `ProfileContextReplacementAudit`, `ProfileContextKeyringProvider`, `ProfileContextKeyringSnapshot`, `ProfileContextKeyEpoch`, and `ProfileContextRevocationStore` for host integration. The current CLI-owned Streamable HTTP entry point does not enable this option; protocol-era negotiation and transport selection remain separate work, so existing stdio and session-aware HTTP behavior stays unchanged.

## Type exports

The package root also exports `AuthenticatedRequestContext`, `AuthenticatedRequestContextBoundary`, `AuthenticatedRequestContextBoundaryOptions`, `AuthenticatedRequestContextErrorCode`, `VerifiedHttpRequestClaims`, and `VerifiedHttpRequestClaimsProvider` for the trusted host boundary. `MiftahRuntimeOptions`, `ModernProfileContextRuntimeOptions`, `MintedProfileContext`, `ResolvedProfileContext`, `ProfileContextHandleErrorCode`, `ProfileContextHandleServiceOptions`, `ProfileContextReplacementAudit`, `ProfileContextKeyEpoch`, `ProfileContextKeyringProvider`, `ProfileContextKeyringSnapshot`, and `ProfileContextRevocationStore` describe modern profile-context hosting. The configuration contract exposes `ActiveProfileStateScope`, `AuditConfig`, `AuditIntegrityConfig`, `AuditRotationConfig`, `GitHubProfileRoutingMatch`, `HttpServerConfig`, `IdentityConfig`, `IdentityFingerprint`, `IdentityProbeConfig`, `JiraProfileRoutingMatch`, `LinearProfileRoutingMatch`, `MiftahConfig`, `MiftahConfigVersion`, `OAuthConfig`, `OAuthConnectionConfig`, `OAuthConnectionRef`, `PluginConfig`, `PluginKind`, `PluginsConfig`, `PolicyConfig`, `PostHogProfileRoutingMatch`, `ProcessConfig`, `ProfileConfig`, `ProfileIsolationConfig`, `ProfileIsolationContainerVolume`, `ProfileIsolationFile`, `ProfileLeaseConfig`, `ProfileRoutingConfig`, `ProfileRoutingMatchConfig`, `ProfileUpstreamOverride`, `RiskLevel`, `RoutingConfig`, `RoutingMatcherPluginConfig`, `RoutingRule`, `SecurityConfig`, `SecretProviderPluginConfig`, `SentryProfileRoutingMatch`, `SecretsConfig`, `ServerConfig`, `StateConfig`, `ToolDiscoveryMode`, `ToolingConfig`, `TransportType`, `UnknownToolRisk`, `UpstreamConfig`, and `ValidatedRoutingConfig`.

`MiftahConfigVersion` is the union of format versions accepted by this installed release. `CURRENT_CONFIG_VERSION` is the version generated by presets; it does not cause `loadConfig` to rewrite a legacy file. Use the explicit [configuration migration command](cli.md#migrate-config) when an on-disk upgrade is intended.

`MiftahConfig` is a version-discriminated union. A `version: "1"` value retains the documented compatibility aliases; `version: "2"` accepts the canonical static-credential surface; and `version: "3"` adds opaque `OAuthConfig` bindings. Version 3 contains no token, refresh-token, client-secret, or callback fields; an exact OAuth binding enables the internal standards-compatible remote Streamable HTTP authorization runtime. The pre-1.0 version-3 type-surface change means application-side composition must use an intersection such as `type AppConfig = MiftahConfig & { readonly appMetadata: AppMetadata }`, rather than `interface AppConfig extends MiftahConfig`; strip application-only metadata before strict Miftah config validation.

`AuditRotationConfig` requires `retainFiles` (maximum `2000`) plus at least one positive trigger (`maxBytes` or `maxAgeMs`). `AuditIntegrityConfig` currently exposes the explicit local `"sha256-chain"` option only. Both configure the runtime journal; journal writers, readers, and CLI export/verification implementations remain internal.

`StateConfig` makes active-profile persistence explicit. Its durable `workspace` and `global` scopes require `persistActiveProfile: true`; custom state-file paths are intentionally not part of the public API.

`ServerConfig` and `HttpServerConfig` configure the CLI-owned literal-loopback-first Streamable HTTP host. Authentication values are supported secret references, not command-line token values; non-loopback binds require explicit opt-in, a bearer token, and exact allowed hosts.

`UpstreamConfig.trustToolAnnotations` is opt-in and defaults to false. `ToolingConfig.unknownToolRisk` uses the exported `UnknownToolRisk` union (`"write" | "destructive"`) and defaults to `"destructive"`; callers can use exact `toolRiskOverrides` for known read tools.

`OAuthConfig`, `OAuthConnectionConfig`, and the opaque `OAuthConnectionRef` expose only version-3 non-secret connection declarations. There is no public OAuth adapter, browser client, callback, token value, credential-store, or token-lifecycle export. `UpstreamConfig.headers` remains available for manual remote credentials, while an exact OAuth declaration activates the internal standards-compatible flow only for its bound HTTPS Streamable HTTP target. See [OAuth support](oauth-support.md).

`ProfileRoutingConfig` describes opt-in identifiers for Miftah's fixed in-tree provider matchers. It is declarative configuration only: it does not load third-party code, resolve secrets, or grant a matcher access to process or network APIs.

## Plugin API subpath

`@lubab/miftah/plugin-api` is the separate stable plugin-authoring surface. It exports `MIFTAH_PLUGIN_API_VERSION`, `MiftahPlugin`, `SecretProviderPlugin`, `SecretProviderPluginRequest`, `SecretProviderPluginResult`, `RoutingMatcherPlugin`, `RoutingMatcherPluginRequest`, `RoutingMatcherPluginResult`, and the canonical routing-signal types. It intentionally does not export Miftah's internal secret resolver, runner, redactor, routing engine, configuration, or process-management types. See [local plugins](plugins.md) for behavior and trust boundaries.

For identity configurations, format-dependent structural constraints, unique `requiredForRisk` tuples, and `selectionMode: "explicit" | "confirmed"` are static. A selection mode requires `requiredForRisk`. For text probes, `validateConfig` runtime-validates equality between `expected.provider` and a static `probe.provider`; JSON probes do not permit a static provider.

Programmatic diagnostics expose `ConfigDiagnostic`, `MiftahErrorCode`, and `MiftahErrorDetails`. `MiftahErrorCode` includes the stable resource-template and resource-subscription protocol error categories. The wrapper factory exposes `MiftahRuntime`.

## Compatibility policy

Starting with Miftah 1.0, these public surfaces follow Semantic Versioning. Compatible fixes may ship in a patch release, and additive compatible behavior may ship in a minor release. A removal, rename, semantic reinterpretation, or incompatible output change requires a new major release, an explicit **Unreleased** changelog entry, and migration guidance. A security correction may remove unsafe behavior without preserving an exploitable contract, but its impact and safe replacement must be documented.

| Surface | Contract |
| --- | --- |
| Configuration formats | `MiftahConfigVersion` and `CURRENT_CONFIG_VERSION` describe the installed release. Supported historical formats remain loadable for their documented window; upgrades are explicit through `miftah migrate-config`, never an implicit load-time rewrite. |
| CLI | Documented command names, flags, JSON success shapes, and exit categories are public. A deprecated form remains available through the announced window and gets an actionable replacement. |
| MCP management namespace | `miftah_*` management tool names and multi-upstream `<upstream>__<tool>`, resource, and prompt namespaces are public client-facing identifiers. Renaming or changing their routing meaning follows the major-release/remediation rule. |
| Audit JSONL | Persisted records carry an immutable schema version. Existing schema versions remain readable for their announced window; incompatible record changes need a documented reader/export migration path. |
| Package root | The documented runtime and type exports on this page are public; internal deep imports are not. |
| Plugin subpath | `@lubab/miftah/plugin-api` is an ABI-versioned authoring surface. A new incompatible ABI uses a new `apiVersion`; it does not silently reinterpret an existing one. |

The currently reserved MCP management names are `miftah_list_profiles`, `miftah_current_profile`, `miftah_use_profile`, `miftah_reset_profile`, `miftah_lock_profile`, `miftah_unlock_profile`, `miftah_profile_info`, `miftah_health`, `miftah_validate_config`, `miftah_list_upstream_tools`, `miftah_restart_profile`, `miftah_verify_identity`, `miftah_route_preview`, `miftah_list_approvals`, `miftah_approve`, and `miftah_deny`. The two decision tools are advertised only with explicit `security.approvalMode: "delegated-agent"`; their names remain reserved and direct calls fail when delegated approval is disabled. In a multi-upstream bundle, every upstream tool uses `<upstream>__<tool>`; for a single upstream whose exact tool name collides with a reserved management name, the default is `upstream_<name>`, while `tooling.collisionStrategy: "fail"` rejects the collision. Other upstream names that merely start with `miftah_` are not reserved.

For configuration format retirement specifically, see the longer [format migration window](config.md#configuration-version-compatibility-and-migration). For plugin ABI retirement, see [local plugin API compatibility](plugins.md#api-compatibility).

Managers, registries, redaction helpers, routing/policy engines, audit implementations, plugin host machinery, and MCP server classes are intentionally internal. They may change at any time and are available only to Miftah's own CLI and test code.
