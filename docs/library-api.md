# Library API

`@lubab/miftah` intentionally supports only the package-root exports documented here. Import from `@lubab/miftah`; deep imports into `dist/` or `src/` are internal implementation details and are not compatibility promises.

## Runtime exports

| Export | Purpose |
| --- | --- |
| `MIFTAH_VERSION` | The package version compiled into Miftah's CLI and MCP metadata. |
| `createMiftahRuntime` | Creates an MCP wrapper from a configuration file without exposing process, profile, or server internals. |
| `MiftahError` | Error class with stable Miftah error codes and optional diagnostic details. |
| `loadConfig` | Reads, validates, and resolves configuration-relative paths from a JSON file. |
| `validateConfig` | Validates unknown input against Miftah's strict configuration contract. |
| `generateConfigSchema` | Generates the editor-facing JSON Schema for the configuration contract. |
| `presetConfig` | Creates a supported configuration preset in memory. |

`createMiftahRuntime` returns `MiftahRuntime`, which exposes the resolved `config`, `connect(transport)`, and `close()` methods. Supply an MCP SDK transport such as `StdioServerTransport`; transport types are provided by the direct `@modelcontextprotocol/sdk` dependency.

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMiftahRuntime } from "@lubab/miftah";

const runtime = await createMiftahRuntime("./miftah.json");
await runtime.connect(new StdioServerTransport());
```

## Type exports

The configuration contract exposes `ActiveProfileStateScope`, `AuditConfig`, `IdentityConfig`, `IdentityFingerprint`, `IdentityProbeConfig`, `MiftahConfig`, `PolicyConfig`, `ProcessConfig`, `ProfileConfig`, `ProfileIsolationConfig`, `ProfileIsolationContainerVolume`, `ProfileIsolationFile`, `ProfileLeaseConfig`, `ProfileUpstreamOverride`, `RiskLevel`, `RoutingConfig`, `RoutingRule`, `SecurityConfig`, `SecretsConfig`, `StateConfig`, `ToolDiscoveryMode`, `ToolingConfig`, `TransportType`, `UnknownToolRisk`, `UpstreamConfig`, and `ValidatedRoutingConfig`.

`StateConfig` makes active-profile persistence explicit. Its durable `workspace` and `global` scopes require `persistActiveProfile: true`; custom state-file paths are intentionally not part of the public API.

`UpstreamConfig.trustToolAnnotations` is opt-in and defaults to false. `ToolingConfig.unknownToolRisk` uses the exported `UnknownToolRisk` union (`"write" | "destructive"`) and defaults to `"destructive"`; callers can use exact `toolRiskOverrides` for known read tools.

For identity configurations, format-dependent structural constraints and unique `requiredForRisk` tuples are static. For text probes, `validateConfig` runtime-validates equality between `expected.provider` and a static `probe.provider`; JSON probes do not permit a static provider.

Programmatic diagnostics expose `ConfigDiagnostic`, `MiftahErrorCode`, and `MiftahErrorDetails`. The wrapper factory exposes `MiftahRuntime`.

## Compatibility policy

Miftah is pre-1.0. Package-root exports documented on this page are supported within a patch release. A removal or incompatible change to one of these exports requires a minor release and an explicit entry under **Unreleased** in `CHANGELOG.md`.

Managers, registries, redaction helpers, routing/policy engines, audit implementations, and MCP server classes are intentionally internal. They may change at any time and are available only to Miftah's own CLI and test code.
