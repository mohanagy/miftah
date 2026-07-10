# Configuration

Miftah uses JSON. Generate the machine-readable schema with:

```bash
miftah schema > miftah.schema.json
```

Required fields are `version: "1"`, `name`, `defaultProfile`, `profiles`, and either `upstream` or `upstreams`. A local STDIO upstream has `transport`, `command`, optional `args`, `env`, and `cwd`.

With `upstreams`, each profile may override `env`, `headers`, `args`, or `cwd` under a named upstream. Miftah namespaces discovered tools as `<upstream>__<tool>` so one wrapper can safely expose several providers.

Profile `env` values can reference `${ENV_NAME}` or `secretref:env://ENV_NAME`. Put dotenv paths in `secrets.envFiles`; paths are resolved relative to the config file. Profile descriptions, tags, policy names, and upstream-specific `args`, `env`, `cwd`, and `headers` overrides are non-secret.

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
