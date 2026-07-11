# Configuration

Miftah uses JSON. Generate the machine-readable schema with:

```bash
miftah schema > miftah.schema.json
```

`miftah schema` is generated from the same strict Zod contract that normalizes successful runtime configuration. Required fields are `version: "1"`, `name`, `defaultProfile`, `profiles`, and either `upstream` or `upstreams`. Closed configuration objects reject unknown or misspelled keys; intentionally open maps are limited to named profiles, policies, upstreams, environment/header values, tool-risk overrides, and `routing.rules[].when`.

Miftah accepts config version `"1"` only and does not silently migrate config files. A future migration must be explicit and documented; an unsupported version returns `UNSUPPORTED_CONFIG_VERSION` with remediation.

The generated JSON Schema enforces static structure, including exactly one of `upstream` or `upstreams`. References to names declared in dynamic maps cannot be represented by JSON Schema alone; run `miftah validate` in addition to editor validation to verify profile, policy, routing, lock, and per-profile upstream references.

With `upstreams`, each profile may override `env`, `headers`, `args`, or `cwd` under a named upstream. Miftah namespaces discovered tools as `<upstream>__<tool>` so one wrapper can safely expose several providers. Tool discovery uses the active profile. Clients receive `notifications/tools/list_changed` after a profile change or active-profile restart and must re-run `tools/list` before relying on a changed tool set or schema. If a routing rule selects another profile, Miftah forwards only tools with an identical client-visible schema in both profiles; otherwise it returns `TOOL_SCHEMA_MISMATCH` instead of forwarding a call whose schema the client did not see.

For a multi-entry `upstreams` map, Miftah aggregates resources and prompts. Resource names and prompt names use `<upstream>__<name>`. Resource URIs use `miftah://resource/<encoded-upstream>?uri=<encoded-redacted-upstream-uri>` and resolve through an exact, per-profile route map; callers cannot select an upstream by supplying a raw URI or an unlisted namespaced identifier. Prompt links and sub-resource URIs become exact Miftah routes to their originating upstream as well. Before publication, Miftah strips URI userinfo/fragments and redacts every query value in resource and prompt URI metadata. Multi-upstream list cursors are opaque, bounded Miftah cursors, scoped to the active profile and capability type, and cannot be reused after a profile change or restart. Clients receive `notifications/resources/list_changed` and `notifications/prompts/list_changed` with the tool notification and must re-list all affected capabilities.

A standard `upstream` and a one-entry `upstreams` map retain raw resource URIs, prompt names, and native upstream pagination. A zero-entry map omits resource and prompt capabilities. Multi-upstream discovery fails closed when any configured upstream fails to list resources or prompts; Miftah does not currently return a partial aggregate from healthy upstreams.

Before loading secret sources or starting an upstream, Miftah validates that `defaultProfile`, profile policy names, routing-rule profiles, `security.lockToProfile`, and per-profile upstream override names all exist. Validation errors are human-readable and expose `MiftahError.details.diagnostics` for programs; each diagnostic includes a stable `code`, dotted `path`, `severity`, `message`, and remediation.

Profile `env` values can reference `${ENV_NAME}` or `secretref:env://ENV_NAME`. Put dotenv paths in `secrets.envFiles`; paths are resolved relative to the config file. Profile descriptions, tags, policy names, and upstream-specific `args` and `cwd` overrides are non-secret. Per-upstream `env` and `headers` values may contain credentials and use the same secret-resolution and redaction safeguards as profile-level values.

The supported routing fallback values are:

- `activeProfile`: use the session's active profile.
- `default`: use `defaultProfile`.
- `ask`: return `ROUTING_AMBIGUOUS` when no unique rule applies.
- `block`: reject requests that do not match a rule.

Policies classify tools as `read`, `write`, or `destructive` using configurable overrides and conservative name heuristics. `denyRisk` takes precedence over `allowRisk`; `requireConfirmation` returns a structured error instead of forwarding the call.

Audit logging defaults to local JSONL when a path is configured. Arguments are excluded unless `includeArguments` is true, and all configured secret values are redacted before writing.

## Runtime-supported controls

Miftah rejects settings without a runtime implementation with `UNSUPPORTED_CONFIG_OPTION` and the exact config path. The only supported routing mode is `"hybrid"`; use `routing.rules` and `routing.fallback` to control its behavior. Routing plugins, profile metadata and matchers, persistent state, UI settings, configurable management-tool namespaces, and lifecycle tuning other than `process.startupTimeoutMs` are not available yet.

Secret and audit redaction are force-on protections. `security.redactSecrets` and `audit.redact` may be declared as `true`, but setting either to `false` is rejected. Audit output is always JSONL; `audit.format` therefore accepts only `"jsonl"`.
