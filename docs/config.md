# Configuration

Miftah uses JSON. Generate the machine-readable schema with:

```bash
miftah schema > miftah.schema.json
```

`miftah schema` is generated from the same strict Zod contract that normalizes successful runtime configuration. Required fields are `version: "1"`, `name`, `defaultProfile`, `profiles`, and either `upstream` or `upstreams`. Closed configuration objects reject unknown or misspelled keys; intentionally open maps are limited to named profiles, policies, upstreams, environment/header values, tool-risk overrides, and `routing.rules[].when`.

Miftah accepts config version `"1"` only and does not silently migrate config files. A future migration must be explicit and documented; an unsupported version returns `UNSUPPORTED_CONFIG_VERSION` with remediation.

For strict starter configurations, use the versioned `init` catalog rather than treating generic command examples as trusted upstream recommendations. The [preset and client compatibility matrix](presets-and-clients.md) records exact pins, required inputs, upstream provenance, and the validation boundary for every catalog entry.

The generated JSON Schema enforces static structure, including exactly one of `upstream` or `upstreams` and the active-profile state opt-in rules. References to names declared in dynamic maps cannot be represented by JSON Schema alone; run `miftah validate` in addition to editor validation to verify profile, policy, routing, lock, and per-profile upstream references.

With `upstreams`, each profile may override `env`, `headers`, `args`, or `cwd` under a named upstream. Miftah namespaces discovered tools as `<upstream>__<tool>` so one wrapper can safely expose several providers. Tool discovery uses the active profile. Clients receive `notifications/tools/list_changed` after a profile change, restart, or upstream recovery that changes the public tool surface and must re-run `tools/list` before relying on cached tools or schemas. If a routing rule selects another profile, Miftah forwards only tools with an identical client-visible schema in both profiles; otherwise it returns `TOOL_SCHEMA_MISMATCH` instead of forwarding a call whose schema the client did not see.

For a multi-entry `upstreams` map, Miftah aggregates resources and prompts. Resource names and prompt names use `<upstream>__<name>`. Resource URIs use `miftah://resource/<encoded-upstream>?uri=<encoded-redacted-upstream-uri>` and resolve through an exact, per-profile route map; callers cannot select an upstream by supplying a raw URI or an unlisted namespaced identifier. Prompt links and sub-resource URIs become exact Miftah routes to their originating upstream as well. Before publication, Miftah strips URI userinfo/fragments and redacts every query value in resource and prompt URI metadata. Multi-upstream list cursors are opaque, bounded Miftah cursors, scoped to the active profile and capability type, and cannot be reused after a profile change or restart. Clients receive `notifications/resources/list_changed` and `notifications/prompts/list_changed` with the tool notification and must re-list all affected capabilities.

A standard `upstream` and a one-entry `upstreams` map retain credential-free raw resource URIs, prompt names, and native upstream pagination. Miftah still strips URI userinfo and fragments and redacts all query values in resource and prompt URI/icon fields before returning them. A zero-entry map omits resource and prompt capabilities.

## Discovery resilience

`tooling.toolDiscoveryMode` accepts `"permissive"` (the default) or `"strict"`:

- `"permissive"` returns tools, resources, and prompts from healthy upstreams when a peer cannot start or list a capability. Failed resource and prompt routes are removed rather than remaining callable. Incomplete tool snapshots are retried by later tool list or call requests. If no configured upstream succeeds, the operation fails with `UPSTREAM_DISCOVERY_FAILED`.
- `"strict"` rejects a capability list if any configured upstream is unavailable. For tools, it discovers every configured profile and requires the complete exposed tool names and client-visible schemas to match; an availability failure returns `UPSTREAM_DISCOVERY_FAILED` and a mismatch returns `TOOL_SCHEMA_MISMATCH`.

Recovery that changes an aggregate surface emits the matching MCP list-change notification. `miftah_health` reports each started upstream with `upstreamName`, `profile`, overall `state`, `processState`, `lastTransition`, `restartCount`, redacted `error`, and `capabilities` for tools, resources, and prompts. Intentional stops include `lastStopReason`; pending automatic recovery includes `nextRestartAt`; exhausted recovery includes `restartLimitReached`.

Before loading secret sources or starting an upstream, Miftah validates that `defaultProfile`, profile policy names, routing-rule profiles, `security.lockToProfile`, and per-profile upstream override names all exist. Validation errors are human-readable and expose `MiftahError.details.diagnostics` for programs; each diagnostic includes a stable `code`, dotted `path`, `severity`, `message`, and remediation.

Profile `env` values can reference `${ENV_NAME}` or `secretref:env://ENV_NAME`. Put dotenv paths in `secrets.envFiles`; paths are resolved relative to the config file. Profile descriptions, tags, policy names, and upstream-specific `args` and `cwd` overrides are non-secret. Per-upstream `env` and `headers` values may contain credentials and use the same secret-resolution and redaction safeguards as profile-level values.

## Secret providers

`secrets` is a strict configuration object:

```json
{
  "secrets": {
    "envFiles": [".env"],
    "providerTimeoutMs": 10000,
    "allowPlaintextSecrets": false
  }
}
```

`providerTimeoutMs` is an optional deadline for one external provider command. It is an integer from **100 ms** through **120,000 ms** and defaults to **10 seconds**. The deadline includes provider launcher startup, lookup, and cleanup. Cancellation returns a stable secret-provider cancellation error; a deadline returns a timeout error. Miftah never retries an external lookup automatically.

The supported external reference forms are exactly:

| Provider | Reference | Lookup |
| --- | --- | --- |
| OS keychain | `secretref:keychain://<service>/<account>` | macOS Keychain, Linux Secret Service, or Windows Credential Manager |
| 1Password CLI | `secretref:op://<vault>/<item>/<field>` | `op read --no-newline op://<vault>/<item>/<field>` |

Each component is percent-decoded exactly once and must be nonempty, at most 255 characters, well-formed Unicode, and free of controls, dot segments, `@`, `?`, `#`, `/`, and `\\`. Use percent encoding for spaces or literal percent signs. Plaintext references remain opt-in only and never place their payload in a diagnostic.

On macOS Miftah runs the fixed `/usr/bin/security find-generic-password -s <service> -a <account> -w` form. On Linux it resolves `secret-tool` from an absolute `PATH` entry and runs `secret-tool lookup service <service> account <account>`. On Windows it reads the generic credential named `miftah:keychain:<percent-encoded-service>:<percent-encoded-account>` through a fixed Credential Manager helper. Miftah never executes these commands through a shell.

For `secretref:op`, noninteractive launches require an inherited `OP_SERVICE_ACCOUNT_TOKEN`; Miftah fails closed before invoking `op` when it is absent. Interactive 1Password desktop/CLI authentication is allowed only when both standard input and output are TTYs, and remains subject to `providerTimeoutMs`. Miftah registers a successful provider value and the inherited service-account token with the shared redactor before either can cross an error, audit, health, or response boundary.

## Remote upstream transports

Use `transport: "streamable-http"` for new remote MCP servers. The historical `transport: "http"` value remains a Streamable HTTP compatibility alias. `transport: "sse"` supports legacy SSE servers but is deprecated and should be used only while an upstream has not migrated. `transport: "stdio"` remains the local-process default.

Remote URLs must use `https`. Miftah accepts `http` only for loopback development URLs on `localhost`, `127.0.0.0/8`, or `::1`; other cleartext URLs and non-HTTP URL schemes fail config validation at the exact `upstream.url` or `upstreams.<name>.url` path. Profile headers override upstream headers case-insensitively, so `Authorization` and `authorization` are one credential slot rather than two combined values.

Miftah uses Node's normal TLS validation and does not disable certificate verification. A self-signed remote certificate therefore fails closed unless the operator establishes a trusted local CA through the normal Node trust configuration. Do not use cleartext remote HTTP to transport profile credentials.

For Streamable HTTP, an intentional restart, idle close, or wrapper shutdown sends DELETE for a negotiated MCP session before closing the local client transport. A remote server can return HTTP 405 to decline session termination; Miftah then completes local cleanup and the server retains control of its own session lifetime. If DELETE hangs, Miftah aborts the local transport at `shutdownTimeoutMs` rather than retrying an unbounded remote cleanup. Legacy SSE has no equivalent remote-session DELETE.

Remote HTTP status failures map to `UPSTREAM_HTTP_ERROR` with `profile`, `transport`, and numeric `status`. Remote MCP JSON-RPC failures map to `UPSTREAM_PROTOCOL_ERROR` with `profile`, `transport`, and `mcpCode`. Miftah intentionally omits upstream response bodies and protocol messages from these errors.

The SDK's default 60-second MCP request timeout applies to remote operations. Miftah does not expose a separate request-timeout setting. Streamable HTTP's SDK transport has its own bounded SSE reconnection behavior; if it closes permanently, `process.restartOnCrash` and `maxRestarts` govern the manager-level recovery described below.

The supported routing fallback values are:

- `activeProfile`: use the session's active profile.
- `default`: use `defaultProfile`.
- `ask`: return `ROUTING_AMBIGUOUS` when no unique rule applies.
- `block`: reject requests that do not match a rule.

## Routing context

The explicit `--config` file is the only runtime configuration authority. Miftah never auto-loads a second configuration file. It treats a discovered `.miftahrc.json` or non-runtime `miftah.json` as a metadata-only project marker only when it has this exact shape:

```json
{
  "profiles": {
    "<wrapper-name>": "<profile-name>"
  }
}
```

The marker's only top-level key must be `profiles`, and all values are strings. It may contain mappings for other wrapper names, but only `<wrapper-name>` is selected; that name is the trusted runtime configuration's `name`, and its `<profile-name>` must name one of the configured profiles. A marker cannot configure an upstream, policy, header, environment value, audit setting, secret source, or any other Miftah option; it does not merge with runtime configuration. Miftah reads only bounded known metadata files while walking from the process working directory to an applicable local boundary and ignores malformed, irrelevant, oversized, or out-of-boundary files. The nearest valid project marker wins; in one directory, `.miftahrc.json` is checked before `miftah.json`, and markers are not combined.

The metadata-only collector can provide rules with `context.*` values from:

- validated MCP client `file:` roots and the process working directory;
- `MIFTAH_PROFILE` and `MIFTAH_PROJECT`;
- the strict project marker above;
- bounded `package.json` name/repository and workspace metadata;
- the local Git `remote.origin.url`.

`MIFTAH_PROFILE` must name a configured profile or routing fails closed. `MIFTAH_PROJECT` is contextual metadata only: Miftah does not interpret it as a path or probe the filesystem from it. URI-like project and repository values, Git origins, and roots are structurally sanitized before evidence crosses an MCP or audit boundary.

Selection order is environment hint, project-marker hint, configured rule, then fallback. The marker stage is the one nearest valid marker above; matching rules that select different profiles return `ROUTING_AMBIGUOUS`, and Miftah does not guess. Context and profile hints do not replace the explicit-rule requirement for a destructive operation when `security.requireExplicitProfileForDestructive` is enabled.

MCP roots are optional client metadata. After initialization, Miftah calls `roots/list` only when the client advertises `roots` capability, stores a URI-only snapshot for that connection, and refreshes it only on an advertised `notifications/roots/list_changed`. An unsupported or failed roots request yields an empty-root snapshot; Miftah does not poll roots or request them for every operation.

`miftah_route_preview` resolves against one collector snapshot using the same context inputs as a proxied operation. Its response contains the selected profile, reason, policy decision (including `riskSource` and `riskConfidence`), and sanitized `evidence`. It never starts an upstream to inspect a tool: it uses only an already-cached compatible tool snapshot and otherwise reports the conservative heuristic or unknown classification. Proxied operation audit records carry the same snapshot as additive `routingEvidence`, including an ambiguity that prevents forwarding. Evidence contains only allowlisted metadata and redacted URI components; it never contains arbitrary project file content or the raw `MIFTAH_PROJECT` value.

## Identity verification

Identity verification is opt-in. Add `identity` at `profiles.<profile>.identity` to configure a profile fingerprint. For an `upstreams` bundle, `profiles.<profile>.upstreams.<upstream>.identity` replaces the profile identity for that exact named target; it does not merge fields from the profile identity.

An identity configuration is strict and contains:

- `expected`: a nonempty fingerprint with only optional `provider`, `login`, `organization`, and `host` string fields. Each identity fingerprint string, `probe.tool`, and any `probe.provider` is trimmed and must be nonempty, with a maximum 256 JavaScript characters;
- `probe`: `{ "tool": "<discovered-tool>", "resultFormat": "text" | "json" }`, with optional `provider` only for `"text"`;
- positive integer `maxAgeMs`, with a maximum 86,400,000 ms (24 hours); and
- optional nonempty, unique `requiredForRisk`, containing only `"write"` and/or `"destructive"`. `"read"` is not accepted.

The expected fingerprint has exactly these fields:

| Field | Meaning |
| --- | --- |
| `provider` | Provider identifier. |
| `login` | Account login. |
| `organization` | Organization identifier. |
| `host` | Provider host identifier. |

For example, this profile identity requires a GitHub login fingerprint before configured write or destructive risks:

```json
{
  "profiles": {
    "work": {
      "identity": {
        "expected": {
          "provider": "github",
          "login": "octo-work"
        },
        "probe": {
          "tool": "whoami",
          "resultFormat": "text",
          "provider": "github"
        },
        "maxAgeMs": 300000,
        "requiredForRisk": ["write", "destructive"]
      }
    }
  }
}
```

The probe must be a discovered read-risk tool with no required input fields; Miftah calls it with `{}`. A missing probe, a non-read probe, or a probe with required input is unsupported. A probe is an account-fingerprint observation only: it does not validate credentials, authentication, provider authorization, or token scopes.

Before parsing or normalization, a probe response must contain exactly one MCP text content item. Its text has a maximum 4,096 JavaScript characters; a response with another content shape or a longer text fails verification. For `"json"` probes, the text must parse to a JSON object, and Miftah retains only allowed string fields (`provider`, `login`, `organization`, and `host`) after their normal validation.

For a `"text"` response, Miftah uses the response as `login` and adds the configured static `provider` when supplied. Text probes require `expected.login`, cannot verify `organization` or `host`, and their static provider must equal `expected.provider` when an expected provider is configured. For a `"json"` response, Miftah retains only allowed string `provider`, `login`, `organization`, and `host` fields; provider must come from that response, so a static probe provider is prohibited. Matching uses exact equality for every configured expected field. Miftah retains only actual fields that were configured in `expected`.

Identity gating is applied only after routing, policy, and target resolution and before the protected operation executes. It applies only when `requiredForRisk` explicitly names the selected write or destructive risk. Read discovery, resource reads, and prompt retrieval are not gated. Mismatch, unsupported, or failed required checks block the protected operation; an identity configuration without `requiredForRisk` never gates an operation.

## Operation routing and policy

Miftah applies one safety pipeline to every proxied upstream tool call, resource read, and prompt retrieval. It captures the active profile once at request start, resolves the routing rule using that immutable fallback, evaluates the selected profile's policy before resolving an aggregate route or forwarding, redacts the result or error, and records the terminal operation metadata in audit output.

Routing rules receive a tool's original arguments unchanged. Resource reads expose the requested URI as `args.uri`; prompt retrieval exposes the prompt arguments and always sets `args.name` to the requested prompt name. Policies evaluate upstream tools by their original tool name, resource reads as `resources/read`, and prompt retrieval as `prompts/get`. For example, `deny: ["resources/read"]` blocks all resource reads for the selected profile, while `requireConfirmation: ["prompts/get"]` requires an approval before forwarding the request.

Policies classify operations as `read`, `write`, or `destructive` in this order:

1. an exact local `tooling.toolRiskOverrides` entry;
2. MCP tool annotations only when that exact base `upstream` or named `upstreams.<name>` declaration sets `trustToolAnnotations: true`;
3. conservative name heuristics; then
4. `tooling.unknownToolRisk`, which defaults to `"destructive"` and may be set only to `"write"` or `"destructive"`.

MCP annotations are hints, not authority. They cannot lower risk unless the operator explicitly trusts that configured upstream; profile-level upstream overrides cannot alter this trust boundary. A trusted `readOnlyHint: true` classifies as read, a trusted non-read-only `destructiveHint: false` classifies as write, and any contradictory `readOnlyHint`/`destructiveHint` combination classifies as destructive. `idempotentHint` and `openWorldHint` are retained as metadata but never lower mutation risk. Exact local overrides always win, including when an upstream annotation is incorrect.

Every policy decision carries stable `riskSource` and `riskConfidence` values. Route previews and audit events expose only those enum values, never raw upstream annotations or tool output. `denyRisk` takes precedence over `allowRisk`; `requireConfirmation` returns a structured error instead of forwarding the operation.

### MCP approvals

When `requireConfirmation` matches, Miftah binds one approval to the current MCP connection, the source and routed profiles, upstream, operation kind, exact target, a normalized argument digest, and a short expiry. It never forwards the protected operation until that approval is consumed, and a consumed, denied, expired, or prior-connection approval cannot be replayed.

Clients that advertise MCP **form elicitation** receive a generic boolean form (`approved`) and never receive the target arguments, digest, or bearer. Clients without that capability receive a one-time fallback bearer in `POLICY_CONFIRMATION_REQUIRED`; use `miftah_approve` with its `approval` field, then retry the exact operation. `miftah_deny` rejects that pending approval, and `miftah_list_approvals` returns only safe pending metadata. A fallback bearer is connection-bound and should be treated as a short-lived capability, not as a durable credential or a human-identity assertion.

Approval lifecycle events record request, approval, denial, expiry, and consumption when audit logging is configured. They contain safe profile/upstream/operation metadata and expiry only; they never contain the fallback bearer or full operation arguments.

Audit logging writes local JSONL when a path is configured. Every supported MCP request emits one terminal operation event with a request ID, per-process session ID, source/selected profiles, stable outcome/error code, duration, and any available upstream, routing, policy, and risk metadata; route previews and proxied operations add sanitized `routingEvidence` when a collector snapshot is available. Wrapper and upstream lifecycle transitions emit separate event records. Arguments are excluded unless `includeArguments` is true, and all configured secret values are redacted before writing. Audit directories and files are created with owner-only permissions where the platform supports them.

`audit.failureMode` accepts `"fail-closed"` (the default) or `"fail-open"`. Fail-closed verifies the configured sink before dispatch and refuses a request when the sink cannot be prepared; a terminal write error also surfaces as `AUDIT_WRITE_FAILED`. Because terminal writes occur after an upstream operation, that error can leave a non-idempotent operation's outcome indeterminate; do not blindly retry it. Fail-open preserves the request result and exposes a redacted `AUDIT_WRITE_FAILED` entry through `miftah_health`; it should be used only when availability is more important than complete auditability.

## Runtime-supported controls

Miftah rejects settings without a runtime implementation with `UNSUPPORTED_CONFIG_OPTION` and the exact config path. The only supported routing mode is `"hybrid"`; use `routing.rules` and `routing.fallback` to control its behavior. Routing plugins, profile metadata and matchers, UI settings, and configurable management-tool namespaces are not available yet.

### Active profile state

Active-profile persistence is disabled by default. With no `state` section, Miftah uses in-memory `process` scope. To opt in to a durable selection, configure one of the durable scopes explicitly:

```json
{
  "state": {
    "persistActiveProfile": true,
    "scope": "workspace"
  }
}
```

`state.scope` is configuration-owned: MCP callers can switch a profile but cannot select a scope or a file path.

| Scope | Lifetime and boundary |
| --- | --- |
| `process` | In memory for the lifetime of this Miftah runtime. |
| `session` | In memory and reset to the configured default (or lock) when a new MCP transport connects. The current STDIO runtime accepts one client transport at a time. |
| `workspace` | Durable beside the resolved configuration file at `.miftah/state/<config-identity>.json`. |
| `global` | Durable in the platform user-state directory under `miftah/state/<config-identity>.json`: `%LOCALAPPDATA%` on Windows, `~/Library/Application Support` on macOS, or absolute `$XDG_STATE_HOME` / `~/.local/state` elsewhere. |

`workspace` and `global` require `persistActiveProfile: true`; setting persistence for `process` or `session`, or choosing a durable scope without that opt-in, is invalid. Custom `state.path` values are rejected. The config-identity component is a hash of the resolved configuration path: global state is deliberately shared only by the same configuration, so one workspace or client cannot silently alter another configuration's active profile.

Only safe selection metadata is stored: a format version, scope, config identity, profile name, and ISO timestamp. No secret, raw configuration path, provider output, or other MCP request input is persisted. Writes use a unique same-directory temporary file, sync it, then atomically rename it; state directories and files use owner-only permissions where the platform supports them. Concurrent writers can replace a completed selection, but never leave a partial state record.

At startup, Miftah validates a stored profile against the current configuration. A `security.lockToProfile` always wins. Corrupt state, an unknown profile, or an unreadable state file falls back safely to the configured default; `miftah_current_profile` reports its `selectionSource`, `selectedAt`, `scope`, and, when applicable, `stateDiagnostic` (`PROFILE_STATE_INVALID`, `PROFILE_STATE_STALE`, or `PROFILE_STATE_UNAVAILABLE`). `miftah_reset_profile` persists the configured default for a durable scope.

### Process lifecycle

`process` controls real profile-bound upstream session behavior:

- `startupTimeoutMs` is a positive integer and defaults to 30 seconds. A hung startup is terminated and reported as `UPSTREAM_START_FAILED`.
- `shutdownTimeoutMs` is a positive integer and defaults to 5 seconds. Miftah closes the configured client transport; for STDIO it first requests graceful shutdown and force-terminates a child that exceeds the deadline or rejects close. Streamable HTTP cleanup sends DELETE before that local close. Health records `lastStopReason: "shutdown-timeout"` for a deadline and `"shutdown-error"` for a rejected close rather than treating either cleanup as a crash.
- `idleTimeoutMs` is a positive integer. When omitted, sessions stay warm until an explicit restart or wrapper shutdown. When set, an inactive profile session closes after the timeout; in-flight upstream requests hold the session open.
- `restartOnCrash` defaults to `false`. When `true`, only an unexpected upstream loss schedules automatic recovery; explicit restart, idle expiry, and wrapper shutdown do not.
- `maxRestarts` is a non-negative integer and requires `restartOnCrash: true`. It defaults to 3 automatic attempts. Retry delay is bounded exponential backoff from 100 ms to 5 seconds with 20% jitter. A profile that keeps crashing exhausts its budget, reports `UPSTREAM_RESTART_LIMIT_EXCEEDED`, and rejects ordinary demand starts until `miftah_restart_profile` explicitly retries it. A recovered session must remain up for 30 seconds before its consecutive-crash budget resets.
- `maxConcurrentProfiles` is a positive integer. It limits distinct live profile bundles across all named upstreams. Miftah never evicts a live credential session to make room: a new profile instead receives `UPSTREAM_CONCURRENCY_LIMIT`. All upstreams for one profile share one slot, and idle, final crash, failed start, or intentional close releases it.

`startMode` and `cache` remain unsupported because Miftah currently always lazily creates cached sessions. They are rejected rather than silently ignored.

Secret and audit redaction are force-on protections. `security.redactSecrets` and `audit.redact` may be declared as `true`, but setting either to `false` is rejected. Audit output is always JSONL; `audit.format` therefore accepts only `"jsonl"`.
