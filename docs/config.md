# Configuration

Miftah uses JSON. Generate the machine-readable schema with:

```bash
miftah schema > miftah.schema.json
```

`miftah schema` is generated from the same strict Zod contract that normalizes successful runtime configuration. Required fields are `version: "1"`, `name`, `defaultProfile`, `profiles`, and either `upstream` or `upstreams`. Closed configuration objects reject unknown or misspelled keys; intentionally open maps are limited to named profiles, policies, upstreams, environment/header values, tool-risk overrides, and `routing.rules[].when`.

Miftah accepts config version `"1"` only and does not silently migrate config files. A future migration must be explicit and documented; an unsupported version returns `UNSUPPORTED_CONFIG_VERSION` with remediation.

The generated JSON Schema enforces static structure, including exactly one of `upstream` or `upstreams`. References to names declared in dynamic maps cannot be represented by JSON Schema alone; run `miftah validate` in addition to editor validation to verify profile, policy, routing, lock, and per-profile upstream references.

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

The supported routing fallback values are:

- `activeProfile`: use the session's active profile.
- `default`: use `defaultProfile`.
- `ask`: return `ROUTING_AMBIGUOUS` when no unique rule applies.
- `block`: reject requests that do not match a rule.

## Operation routing and policy

Miftah applies one safety pipeline to every proxied upstream tool call, resource read, and prompt retrieval. It captures the active profile once at request start, resolves the routing rule using that immutable fallback, evaluates the selected profile's policy before resolving an aggregate route or forwarding, redacts the result or error, and records the terminal operation metadata in audit output.

Routing rules receive a tool's original arguments unchanged. Resource reads expose the requested URI as `args.uri`; prompt retrieval exposes the prompt arguments and always sets `args.name` to the requested prompt name. Policies evaluate upstream tools by their original tool name, resource reads as `resources/read`, and prompt retrieval as `prompts/get`. For example, `deny: ["resources/read"]` blocks all resource reads for the selected profile, while `requireConfirmation: ["prompts/get"]` returns `POLICY_CONFIRMATION_REQUIRED` without forwarding the request.

Policies classify these operation names as `read`, `write`, or `destructive` using configurable overrides and conservative name heuristics. `denyRisk` takes precedence over `allowRisk`; `requireConfirmation` returns a structured error instead of forwarding the operation.

Audit logging defaults to local JSONL when a path is configured. Arguments are excluded unless `includeArguments` is true, and all configured secret values are redacted before writing.

## Runtime-supported controls

Miftah rejects settings without a runtime implementation with `UNSUPPORTED_CONFIG_OPTION` and the exact config path. The only supported routing mode is `"hybrid"`; use `routing.rules` and `routing.fallback` to control its behavior. Routing plugins, profile metadata and matchers, persistent state, UI settings, and configurable management-tool namespaces are not available yet.

### Process lifecycle

`process` controls real local session behavior:

- `startupTimeoutMs` is a positive integer and defaults to 30 seconds. A hung startup is terminated and reported as `UPSTREAM_START_FAILED`.
- `shutdownTimeoutMs` is a positive integer and defaults to 5 seconds. Miftah first closes STDIO gracefully, then force-terminates a child that exceeds the deadline or rejects close. Health records `lastStopReason: "shutdown-timeout"` for a deadline and `"shutdown-error"` for a rejected close rather than treating either cleanup as a crash.
- `idleTimeoutMs` is a positive integer. When omitted, sessions stay warm until an explicit restart or wrapper shutdown. When set, an inactive profile session closes after the timeout; in-flight upstream requests hold the session open.
- `restartOnCrash` defaults to `false`. When `true`, only an unexpected upstream loss schedules automatic recovery; explicit restart, idle expiry, and wrapper shutdown do not.
- `maxRestarts` is a non-negative integer and requires `restartOnCrash: true`. It defaults to 3 automatic attempts. Retry delay is bounded exponential backoff from 100 ms to 5 seconds with 20% jitter. A profile that keeps crashing exhausts its budget, reports `UPSTREAM_RESTART_LIMIT_EXCEEDED`, and rejects ordinary demand starts until `miftah_restart_profile` explicitly retries it. A recovered session must remain up for 30 seconds before its consecutive-crash budget resets.
- `maxConcurrentProfiles` is a positive integer. It limits distinct live profile bundles across all named upstreams. Miftah never evicts a live credential session to make room: a new profile instead receives `UPSTREAM_CONCURRENCY_LIMIT`. All upstreams for one profile share one slot, and idle, final crash, failed start, or intentional close releases it.

`startMode` and `cache` remain unsupported because Miftah currently always lazily creates cached sessions. They are rejected rather than silently ignored.

Secret and audit redaction are force-on protections. `security.redactSecrets` and `audit.redact` may be declared as `true`, but setting either to `false` is rejected. Audit output is always JSONL; `audit.format` therefore accepts only `"jsonl"`.
