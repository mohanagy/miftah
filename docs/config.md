# Configuration

Miftah uses JSON. Generate the machine-readable schema with:

```bash
miftah schema > miftah.schema.json
```

`miftah schema` is generated from the same strict Zod contract that normalizes successful runtime configuration. Required fields are `version`, `name`, `defaultProfile`, `profiles`, and either `upstream` or `upstreams`. Version `"2"` is the canonical format written by current presets and examples. Closed configuration objects reject unknown or misspelled keys; intentionally open maps are limited to named profiles, policies, upstreams, environment/header values, tool-risk overrides, and `routing.rules[].when`.

Miftah accepts versions `"1"` and `"2"` during the documented compatibility window. It never rewrites a file while loading or serving it. An unsupported version returns `UNSUPPORTED_CONFIG_VERSION` with remediation.

## Configuration version compatibility and migration

Version `"1"` remains supported for existing configurations. It allows the historical `upstream.transport: "http"` alias, `security.allowPlaintextSecrets`, and redundant true-only `security.redactSecrets` / `audit.redact` declarations. Version `"2"` rejects those aliases with `UNSUPPORTED_CONFIG_OPTION`: use `upstream.transport: "streamable-http"`, `secrets.allowPlaintextSecrets`, and omit force-on redaction declarations.

Run `miftah migrate-config --config <file>` to inspect a version-1 upgrade. The default is a JSON migration plan only; it does not alter the source file, resolve secrets, or start an upstream. Add `--write` only after reviewing that plan. Before it changes a file, Miftah requires valid UTF-8 JSON, validates the version-2 candidate, captures a regular non-symlink source snapshot, and moves the verified source into a dedicated same-directory transaction directory. It creates the exact-byte backup and synced candidate privately, then publishes each only to an absent destination path; it never uses an overwrite rename. A concurrent file is preserved, while uncertain original state is retained in the transaction directory whose path is reported in the error. Miftah restores the verified original when it can do so without overwriting anything. It preserves POSIX source mode where supported. On Windows, the transaction directory receives a current-user-only DACL at creation, and Miftah copies and verifies the source owner, group, and DACL before either private file receives source-derived bytes; inability to establish that boundary fails closed. It refuses to overwrite an existing backup and never prints a raw configuration or a configuration diff.

The migrator changes only aliases with proven equivalent behavior: `"http"` becomes `"streamable-http"`, the plaintext opt-in moves to `secrets.allowPlaintextSecrets`, and redundant force-on redaction declarations are removed. It fails closed for conflicting plaintext options or unrelated unsupported fields rather than discarding them. A version-2 input is validated and reported as unchanged; `--write` then creates no backup and performs no write.

Version `"1"` will remain accepted through at least the first published pre-1.0 minor release after version `"2"` ships. Removing it requires a later minor release, an **Unreleased** changelog entry, and a documented explicit migration path. Keep a byte-for-byte historical fixture for every supported released format in release CI.

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

### Local secret-provider plugins

`plugins.allowlist` can opt in to a local secret-provider scheme such as `secretref:company-vault://account`. Each plugin has a stable id, a local configuration-relative `.mjs` path, and `kind: "secret-provider"`; the manifest must exactly match before Miftah starts its MCP server. The plugin receives only the requested canonical reference, and its resolved value is added to the shared redactor before use. See the [local plugin API](plugins.md) for the configuration, timeout, containment, and operator-trust contract.

## HTTP server transport

`miftah serve --transport http --config <file>` exposes Miftah's Streamable HTTP endpoint at `/mcp`. This is a local Miftah server transport, distinct from an `upstream.transport: "streamable-http"` remote upstream. The default listener is the literal loopback endpoint `http://127.0.0.1:3000/mcp`.

Configure the listener under `server.http`:

```json
{
  "server": {
    "http": {
      "host": "127.0.0.1",
      "port": 3000,
      "maxSessions": 32,
      "sessionIdleTimeoutMs": 900000,
      "maxRequestBytes": 1048576
    }
  }
}
```

`port` accepts `0` through `65535` (`0` chooses an OS-assigned port); `maxSessions` is `1` through `256`; `sessionIdleTimeoutMs` is `1,000` through `86,400,000`; and `maxRequestBytes` is `1,024` through `10,485,760`. Miftah validates and bounds a POST body before it allocates a session. A session is removed on MCP DELETE, idle expiry, or shutdown; removal closes that session's runtime and retained upstream transports. A closing session is no longer addressable, but retains its capacity reservation until cleanup succeeds; a cleanup failure is reported and conservatively retains the reservation.

Only literal `127.0.0.1` and `::1` are loopback bind values. A hostname, `localhost`, `0.0.0.0`, or any other address is a deliberate non-loopback exposure and must include all of the following:

```json
{
  "server": {
    "http": {
      "host": "0.0.0.0",
      "port": 8443,
      "allowNonLoopback": true,
      "authToken": "${MIFTAH_HTTP_TOKEN}",
      "allowedHosts": ["mcp.example.test"],
      "allowedOrigins": ["https://client.example.test"]
    }
  }
}
```

`authToken` is an exact environment or `secretref:` reference, never a plaintext token. `allowedHosts` is an exact canonical host allowlist (the request port is ignored); it defaults to the bind host only for literal-loopback configuration. An absent `Origin` is permitted for non-browser MCP clients. A present `Origin` is rejected unless it exactly matches `allowedOrigins`; no permissive CORS response is emitted. Do not put a bearer token in CLI arguments, URLs, or configuration literals.

Each accepted HTTP session owns a fresh Miftah runtime, profile manager, routing/approval/lock/lease state, and upstream manager. HTTP sessions always use in-memory `session` profile state, even when the base configuration opts into durable state, so one client's selection cannot persist into or alter another client's session.

## Profile credential isolation

`profiles.<profile>.isolation` is an opt-in, POSIX-only filesystem boundary for a local STDIO target. Miftah derives a deterministic runtime tree from the canonical configuration file, profile, and upstream name; it never accepts an operator-selected runtime root. The tree contains `home`, `appdata`, `localappdata`, and `xdg/config`, `xdg/cache`, `xdg/data`, `xdg/state`, and `xdg/runtime`. On macOS and Linux, Miftah verifies owner control, uses restrictive `0700` directories and `0600` copied files where the platform supports those modes, and refuses a reused target without its matching Miftah marker.

Use `files` to copy an existing regular file below the canonical configuration directory into that runtime tree. Both `source` and `destination` are bounded relative paths; every traversed source directory and the mapped source file must be owned by the effective user and not group- or world-writable. Symlinks, traversal, non-regular files, files larger than 1 MiB, and paths outside the canonical configuration directory fail closed. An optional `environment` binding receives the generated host path. Miftah injects the generated HOME/XDG and Windows-compatible environment names after configured upstream/profile environment values, and mappings cannot replace those generated names.

```json
{
  "upstream": {
    "transport": "stdio",
    "command": "docker",
    "args": ["run", "-i", "--rm", "example/mcp@sha256:<digest>", "stdio"]
  },
  "profiles": {
    "work": {
      "isolation": {
        "files": [
          {
            "source": "credentials/work-oauth.json",
            "destination": "credentials/oauth.json",
            "environment": "OAUTH_CREDENTIAL_PATH"
          }
        ],
        "containerVolumes": [
          {
            "source": "credentials/oauth.json",
            "destination": "/run/miftah/oauth.json",
            "environment": "OAUTH_CREDENTIAL_PATH"
          }
        ]
      }
    }
  }
}
```

`containerVolumes` is available only for an exact local Docker/Podman `run` STDIO command. Its `source` is relative to the generated runtime tree, while its `destination` is a normalized absolute POSIX path in the container. `readOnly` defaults to `true`; set `readOnly: false` only when the container must write that path. Miftah emits fixed `--mount` and `--env` argument arrays before the image, never a shell string. It maps known runtime directories to HOME/XDG/platform environment names in the container and maps an explicit `environment` to its container destination. Existing mount, tmpfs, device, `--env-file`, or conflicting generated environment flags fail closed instead of relying on Docker/Podman flag precedence. A host runtime path containing Docker mount grammar delimiters also fails closed.

Miftah rejects an explicit `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, `CONTAINER_HOST`, `CONTAINER_CONNECTION`, `PODMAN_CONNECTIONS_CONF`, or `CONTAINERS_CONF` because a remote engine would interpret a local runtime path on another machine. It also rejects Podman isolation on macOS, where the normal Podman machine is remote from the client. The Docker/Podman daemon and its default local connection remain an operator trust boundary; Miftah does not inspect daemon configuration. It rechecks the runtime root and each volume source before returning argv, but a hostile same-user process can still race a filesystem path after that check and before the engine resolves it.

A named-upstream isolation object augments its profile isolation object for that target. Duplicate destinations and generated environment bindings fail configuration validation; the one intentional exception is a container volume that mounts the exact copied-file destination and carries that file's same `environment` name, as in the example above. The native child receives the generated host path, while Docker/Podman receives the explicit container path.

Miftah copies files atomically before startup, registers copied content and generated paths with its redactor, and replaces all stderr from a child that receives copied files or container volumes with a fixed `[REDACTED]` marker. It does not create backups, perform automatic migration, or clean up profile runtime trees: **Miftah never removes** an existing runtime tree or an upstream-created OAuth session. Stop the wrapper before manually removing only a directory whose marker you have verified; Miftah has no cleanup command.

Windows profile credential isolation is currently rejected before any runtime file is materialized, because Node mode bits cannot install and verify the restrictive Windows DACL this boundary requires. Remote HTTP/SSE transports are also rejected. Use normal secret references on Windows until a verified ACL implementation is available.

## Remote upstream transports

Use `transport: "streamable-http"` for new remote MCP servers. The historical `transport: "http"` value remains a Streamable HTTP compatibility alias only in configuration version 1; version 2 requires `"streamable-http"`. `transport: "sse"` supports legacy SSE servers but is deprecated and should be used only while an upstream has not migrated. `transport: "stdio"` remains the local-process default.

Remote URLs must use `https`. Miftah accepts `http` only for loopback development URLs on `localhost`, `127.0.0.0/8`, or `::1`; other cleartext URLs and non-HTTP URL schemes fail config validation at the exact `upstream.url` or `upstreams.<name>.url` path. Profile headers override upstream headers case-insensitively, so `Authorization` and `authorization` are one credential slot rather than two combined values.

Remote authentication is static: configure only explicit `headers`/secret references that the upstream documents. There is no OAuth configuration object, callback URL, client-registration setting, browser flow, token refresh, or token revoke command in the current strict schema. Unknown OAuth keys are rejected instead of being silently accepted. See [OAuth support](oauth-support.md) for the exact provider, local-stdio, and future remote-HTTP boundary.

Miftah uses Node's normal TLS validation and does not disable certificate verification. A self-signed remote certificate therefore fails closed unless the operator establishes a trusted local CA through the normal Node trust configuration. Do not use cleartext remote HTTP to transport profile credentials.

For Streamable HTTP, an intentional restart, idle close, or wrapper shutdown sends DELETE for a negotiated MCP session before closing the local client transport. A remote server can return HTTP 405 to decline session termination; Miftah then completes local cleanup and the server retains control of its own session lifetime. If DELETE hangs, Miftah aborts the local transport at `shutdownTimeoutMs` rather than retrying an unbounded remote cleanup. Legacy SSE has no equivalent remote-session DELETE.

Remote HTTP status failures map to `UPSTREAM_HTTP_ERROR` with `profile`, `transport`, and numeric `status`. Remote MCP JSON-RPC failures map to `UPSTREAM_PROTOCOL_ERROR` with `profile`, `transport`, and `mcpCode`. Miftah intentionally omits upstream response bodies and protocol messages from these errors.

The SDK's default 60-second MCP request timeout applies to remote operations. Miftah does not expose a separate request-timeout setting. Request cancellation and requested progress notifications preserve their MCP request context across STDIO and Streamable HTTP upstreams. Streamable HTTP's SDK transport has its own bounded SSE reconnection behavior; if it closes permanently, `process.restartOnCrash` and `maxRestarts` govern the manager-level recovery described below.

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

Selection order is environment hint, project-marker hint, configured rule, the matcher band (fixed static matchers plus allowlisted plugin matchers), then fallback. The marker stage is the one nearest valid marker above; matching rules that select different profiles return `ROUTING_AMBIGUOUS`, and Miftah does not guess. Context and profile hints do not replace the explicit-rule requirement for a destructive operation when `security.requireExplicitProfileForDestructive` is enabled.

MCP roots are optional client metadata. After initialization, Miftah calls `roots/list` only when the client advertises `roots` capability, stores a URI-only snapshot for that connection, and refreshes it only on an advertised `notifications/roots/list_changed`. An unsupported or failed roots request yields an empty-root snapshot; Miftah does not poll roots or request them for every operation.

`miftah_route_preview` resolves against one collector snapshot using the same context inputs as a proxied operation. Its response contains the selected profile, reason, policy decision (including `riskSource` and `riskConfidence`), an additive local-policy `enforcement` result, sanitized `evidence`, and `matcherEvidence` when a fixed or plugin matcher selected a profile. It never starts an upstream to inspect a tool: it uses only an already-cached compatible tool snapshot, except for the fixed origin-pinned PostHog command adapter described below, which can classify its bounded command payload from configuration alone. For an ordinary unknown tool it reports the conservative heuristic or unknown classification. `enforcement.status: "blocked"` carries the same stable error code and safe message that a real call receives from the explicit-routing or policy-deny boundary; preview does not resolve a target, request approval, or perform identity verification. Proxied operation audit records carry the same snapshot as additive `routingEvidence` and carry canonical `routingMatcherEvidence` for a successful or ambiguous match. Evidence contains only allowlisted metadata and redacted URI components; it never contains arbitrary project file content or the raw `MIFTAH_PROJECT` value.

### Provider routing matchers

`profiles.<profile>.routing.match` is an opt-in, declarative binding to Miftah's fixed in-tree provider registry. It never loads configured code, starts a process, resolves a secret, or makes a network request. Every provider declaration and `match` object must be nonempty; each identifier array has at most 32 distinct canonical values.

```json
{
  "profiles": {
    "work": {
      "routing": {
        "match": {
          "github": {
            "repositories": ["acme/miftah"],
            "organizations": ["acme"]
          },
          "sentry": {
            "organizations": ["acme"],
            "projects": ["acme/api"],
            "environments": ["production"]
          }
        }
      }
    }
  }
}
```

The supported fixed providers are GitHub (`repositories`, `organizations`), Sentry (`organizations`, `projects`, `environments`), Jira (`sites`, `projects`), Linear (`workspaces`, `teams`), and PostHog (`hosts`, `projects`). GitHub repositories are lowercase `owner/repository`; Sentry projects are lowercase `organization/project`; Jira sites and PostHog hosts are canonical credential-free HTTPS origins; Jira project keys are uppercase; Linear names are lowercase slugs; and PostHog projects are decimal IDs. The validator rejects credentials, query strings, fragments, paths, controls, noncanonical case, duplicates, and unknown provider fields.

Argument-only signals require an exact provider token in the client-visible tool name, such as `github__search_issues`; a generic tool with `{ "repo": "acme/miftah" }` cannot select a GitHub profile. Canonical HTTPS provider URLs in allowlisted `url` and `uri` fields are stronger signals, so a standard resource read can match its requested provider URI; userinfo, query strings, fragments, and non-HTTPS URIs are ignored. GitHub repository context may come from a canonical package/workspace repository or a local `remote.origin.url` in HTTPS, SSH, or scp syntax. The matcher receives only those bounded canonical signals: it never reads arbitrary nested arguments, arbitrary routing context, or `MIFTAH_PROJECT`.

If one profile has several matching signals, it remains one selection. If fixed and/or plugin bindings select different profiles, Miftah returns `ROUTING_AMBIGUOUS` before resolving an upstream. A matcher reason is `matcher:<provider>` or `matcher:plugin:<id>` and does not satisfy `security.requireExplicitProfileForDestructive`; destructive operations still require an explicit `routing.rules` match. `routing.plugins` remains unsupported; use the root [`plugins.allowlist`](plugins.md) API for explicitly reviewed local modules.

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

Miftah applies one safety pipeline to every proxied upstream tool call, resource read, resource subscription, and prompt retrieval. It captures the active profile once at request start, resolves the routing rule using that immutable fallback, evaluates the selected profile's policy before resolving an aggregate route or forwarding, redacts the result or error, and records the terminal operation metadata in audit output.

Routing rules receive a tool's original arguments unchanged. Resource reads and subscriptions expose the requested URI as `args.uri`; prompt retrieval exposes the prompt arguments and always sets `args.name` to the requested prompt name. Policies evaluate upstream tools by their original tool name, resource reads and subscriptions as `resources/read`, and prompt retrieval as `prompts/get`. Resource templates resolve to a concrete resource URI before this same resource-read boundary. Miftah advertises `resources.subscribe` only when every selectable profile/upstream supports it; otherwise subscription attempts return the stable `RESOURCE_SUBSCRIPTION_UNSUPPORTED` error. It probes that support serially before the downstream connection, then closes every probe profile, so a `maxConcurrentProfiles` limit is not held by capability detection. Per-URI subscribe/unsubscribe transitions are serialized. Any active-profile change clears all connection-bound subscriptions, including one routed to a third profile, and upstream cleanup is cancelled at `process.shutdownTimeoutMs` rather than delaying the profile change indefinitely. For example, `deny: ["resources/read"]` blocks all resource reads and subscriptions for the selected profile, while `requireConfirmation: ["prompts/get"]` requires an approval before forwarding the request.

Policies classify operations as `read`, `write`, or `destructive` in this order:

1. an exact local `tooling.toolRiskOverrides` entry;
2. Miftah's fixed PostHog command adapter, only for an `exec` tool on the canonical official Streamable HTTP endpoint `https://mcp.posthog.com/mcp` (the version-1 `http` compatibility alias is equivalent);
3. MCP tool annotations only when that exact base `upstream` or named `upstreams.<name>` declaration sets `trustToolAnnotations: true`;
4. conservative name heuristics; then
5. `tooling.unknownToolRisk`, which defaults to `"destructive"` and may be set only to `"write"` or `"destructive"`.

MCP annotations are hints, not authority. They cannot lower risk unless the operator explicitly trusts that configured upstream; profile-level upstream overrides cannot alter this trust boundary. A trusted `readOnlyHint: true` classifies as read, a trusted non-read-only `destructiveHint: false` classifies as write, and any contradictory `readOnlyHint`/`destructiveHint` combination classifies as destructive. `idempotentHint` and `openWorldHint` are retained as metadata but never lower mutation risk. Exact local overrides always win, including when an upstream annotation is incorrect.

The PostHog adapter reports `riskSource: "trusted-command-adapter"`; it is deliberately not a generic exception for tools named `exec`. It accepts only the official origin with no query, fragment, credentials, alternate path, or port; it then parses the entire bounded command language without executing a shell. `tools`, safe `search`, `info`, and `schema` discovery forms are read-only. A `call` command is classified from its canonical nested PostHog tool name; read-like names remain read, write-like names remain write, destructive names remain destructive, and unknown, malformed, multi-command, shell-like, or invalid-JSON forms are destructive. `--confirm` never lowers risk. A different origin, a local STDIO command wrapper, or any other generic `exec` tool keeps the normal conservative classification.

Every policy decision carries stable `riskSource` and `riskConfidence` values. Route previews and audit events expose only those enum values, never raw upstream annotations or tool output. `denyRisk` takes precedence over `allowRisk`; `requireConfirmation` returns a structured error instead of forwarding the operation.

### MCP approvals

When `requireConfirmation` matches, Miftah binds one approval to the current MCP connection, the source and routed profiles, upstream, operation kind, exact target, a normalized argument digest, and a short expiry. It never forwards the protected operation until that approval is consumed, and a consumed, denied, expired, or prior-connection approval cannot be replayed.

The default `security.approvalMode` is `"human"`. Clients that advertise MCP **form elicitation** receive a generic boolean form (`approved`) and never receive target arguments, a digest, or a bearer. A client without form elicitation fails closed with `POLICY_CONFIRMATION_REQUIRED`; it receives no approval bearer and cannot self-approve. Set `security.approvalMode: "delegated-agent"` only for intentionally delegated automation. When form elicitation is unavailable, that explicit mode exposes a connection-bound, one-time bearer in `POLICY_CONFIRMATION_REQUIRED`; use `miftah_approve` or `miftah_deny` with its `approval` field, then retry the exact operation. Delegated-agent approval is not a human-identity assertion. `miftah_list_approvals` returns only safe pending metadata.

Approval lifecycle events record request, approval, denial, expiry, and consumption when audit logging is configured. They contain safe profile/upstream/operation metadata, expiry, and `approvalMechanism` (`"form"` or `"delegated-agent"`) only; they never contain an approval bearer or full operation arguments.

Audit logging writes local JSONL when a path is configured. Every supported MCP request emits one terminal operation event with a request ID, per-process session ID, source/selected profiles, stable outcome/error code, duration, and any available upstream, routing, policy, and risk metadata; route previews and proxied operations add sanitized `routingEvidence` when a collector snapshot is available and canonical `routingMatcherEvidence` for a static matcher result or ambiguity. Wrapper and upstream lifecycle transitions emit separate event records. Arguments are excluded unless `includeArguments` is true, and all configured secret values are redacted before writing. Audit directories and files are created with owner-only permissions where the platform supports them.

Every newly written record carries writer-controlled `schemaVersion: 1`; an event cannot select or override that marker. Miftah continues to read existing unversioned local JSONL records as legacy input. Additive fields may be introduced to schema version 1, but an incompatible audit-record interpretation requires a later minor release, an **Unreleased** changelog entry, and a documented reader or export migration path. When integrity is enabled, the schema marker is inside the chained payload and is therefore tamper-evident.

`audit.failureMode` accepts `"fail-closed"` (the default) or `"fail-open"`. Fail-closed verifies the configured sink before dispatch and refuses a request when the sink cannot be prepared; a terminal write error also surfaces as `AUDIT_WRITE_FAILED`. Because terminal writes occur after an upstream operation, that error can leave a non-idempotent operation's outcome indeterminate; do not blindly retry it. Fail-open preserves the request result and exposes a redacted `AUDIT_WRITE_FAILED` entry through `miftah_health`; it should be used only when availability is more important than complete auditability.

### Audit journal rotation and integrity

`audit.rotation` is opt-in and requires `retainFiles` plus at least one positive trigger: `maxBytes` or `maxAgeMs`. Rotation and integrity both require a non-empty `audit.path` and cannot be combined with `audit.enabled: false`. `retainFiles` is a count of completed archive segments (maximum `2000`); the active JSONL file remains separately available. Miftah rotates only between complete write batches, so a successful event is never split across JSONL records or a rotation boundary. It keeps only managed, single-link regular archive files with stable identities below the configured audit directory, refuses unsafe active/managed paths (including externally hard-linked paths), and never follows a symlink during retention. Journal coordination is local to one host; do not concurrently write one managed journal through a shared filesystem from multiple machines. Disk-full, permissions, corrupt-journal, or rotation failures before the event commits obey `audit.failureMode`. If post-commit retention cleanup cannot finish, Miftah warns and preserves the completed segments for a later safe retry rather than turning an acknowledged event into a retry duplicate.

```json
{
  "audit": {
    "path": "./audit/events.jsonl",
    "rotation": {
      "maxBytes": 10485760,
      "maxAgeMs": 86400000,
      "retainFiles": 14
    },
    "integrity": { "algorithm": "sha256-chain" }
  }
}
```

`audit.integrity.algorithm: "sha256-chain"` adds a hash-chain envelope to already-redacted audit records and maintains continuation metadata across rotation and retention. `miftah audit-verify --config <file>` scans the managed retained set and reports only the first segment name, record number, and stable reason when verification fails; it does not start an upstream or print audit bytes, hashes, or absolute paths. Enable integrity before writing the journal: Miftah will not silently adopt a nonempty unchained active file.

This is local tamper evidence, not signing, nonrepudiation, or remote immutable storage. An attacker able to replace every local journal and its local integrity metadata can defeat it; preserve required evidence externally under an independent protection boundary.

`miftah audit-export --config <file> --output <file>` takes an explicit private snapshot, repeats configured redaction, and writes a new JSONL export without stored `arguments` by default. It does not upload telemetry or contact an upstream. `--include-arguments` is an explicit support opt-in; values remain subject to redaction, and arguments omitted when the event was recorded cannot be reconstructed.

## Runtime-supported controls

Miftah rejects settings without a runtime implementation with `UNSUPPORTED_CONFIG_OPTION` and the exact config path. The only supported routing mode is `"hybrid"`; use `routing.rules`, profile-local static matchers, explicitly allowlisted root `plugins`, and `routing.fallback` to control its behavior. Legacy `routing.plugins`, profile metadata, UI settings, and configurable management-tool namespaces are not available.

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

### Profile confirmation, locks, and leases

Profile changes can require connection-bound confirmation:

```json
{
  "security": {
    "approvalMode": "human",
    "requireProfileSwitchConfirmation": true,
    "allowProfileLockingFromMcp": true,
    "requireExplicitSelectionForDestructive": true
  },
  "profiles": {
    "work": {
      "lease": {
        "ttlMs": 300000,
        "requiredForRisk": ["write", "destructive"]
      }
    }
  }
}
```

`security.requireProfileSwitchConfirmation` makes each `miftah_use_profile` and `miftah_reset_profile` exact-action confirmation-bound. With the default `security.approvalMode: "human"`, form-capable MCP clients receive a generic boolean form and clients without form elicitation fail closed. The explicit `"delegated-agent"` mode instead allows a short-lived bearer through `miftah_approve` or `miftah_deny`, then requires the exact same change to be retried; it cannot bypass confirmation, change profile, source selection generation, or connection session. This mode authorizes an agent, not a human.

The generated multi-profile GitHub preset enables `requireProfileSwitchConfirmation` and `requireExplicitSelectionForDestructive` by default. It therefore cannot silently switch a profile or let an implicit default/profile hint satisfy the destructive-selection boundary. Choose a form-capable MCP client for human confirmation, or explicitly opt in to delegated-agent automation after reviewing that trade-off.

`security.allowProfileLockingFromMcp` is an explicit opt-in for `miftah_lock_profile` and `miftah_unlock_profile`. A runtime lock is connection-bound, in-memory, and clears for a new transport. It does not change `state` files. `security.lockToProfile` remains the stronger operator-controlled lock and cannot be removed through MCP.

A profile `lease` is optional and has `ttlMs` from 1,000 through 3,600,000 milliseconds plus a nonempty, unique `requiredForRisk` list containing only `"write"` and/or `"destructive"`. An explicit successful `miftah_use_profile` or `miftah_reset_profile` issues that profile's lease. Configured defaults, persisted selections, hints, and fallback routing do not silently issue one. Miftah checks the captured lease before target resolution and again immediately before execution; a route to another profile cannot borrow a lease from the active profile.

`security.requireExplicitSelectionForDestructive` blocks destructive operations unless the captured target is a current-connection `miftah_use_profile`/`miftah_reset_profile` selection or a configured static lock. It is independent of `security.requireExplicitProfileForDestructive`, which still requires an explicit routing rule. A runtime lock alone does not turn a default or persisted selection into an explicit destructive authorization.

`miftah_current_profile` exposes only safe `confirmation`, `lease`, and `lock` summaries in addition to existing selection metadata. `miftah_health` returns the same summary under `profileState`; lock and unlock management results also return `profileState`. Dedicated profile audit events contain action names and safe selection state only; no approval bearer, raw request data, state path, or lease credential is recorded.

### Process lifecycle

`process` controls real profile-bound upstream session behavior:

- `startupTimeoutMs` is a positive integer and defaults to 30 seconds. A hung startup is terminated and reported as `UPSTREAM_START_FAILED`.
- `shutdownTimeoutMs` is a positive integer and defaults to 5 seconds. Miftah closes the configured client transport; for STDIO it first requests graceful shutdown and force-terminates a child that exceeds the deadline or rejects close. Streamable HTTP cleanup sends DELETE before that local close. Health records `lastStopReason: "shutdown-timeout"` for a deadline and `"shutdown-error"` for a rejected close rather than treating either cleanup as a crash.
- `idleTimeoutMs` is a positive integer. When omitted, sessions stay warm until an explicit restart or wrapper shutdown. When set, an inactive profile session closes after the timeout; in-flight upstream requests hold the session open.
- `restartOnCrash` defaults to `false`. When `true`, only an unexpected upstream loss schedules automatic recovery; explicit restart, idle expiry, and wrapper shutdown do not.
- `maxRestarts` is a non-negative integer and requires `restartOnCrash: true`. It defaults to 3 automatic attempts. Retry delay is bounded exponential backoff from 100 ms to 5 seconds with 20% jitter. A profile that keeps crashing exhausts its budget, reports `UPSTREAM_RESTART_LIMIT_EXCEEDED`, and rejects ordinary demand starts until `miftah_restart_profile` explicitly retries it. A recovered session must remain up for 30 seconds before its consecutive-crash budget resets.
- `maxConcurrentProfiles` is a positive integer. It limits distinct live profile bundles across all named upstreams. Miftah never evicts a live credential session to make room: a new profile instead receives `UPSTREAM_CONCURRENCY_LIMIT`. All upstreams for one profile share one slot, and idle, final crash, failed start, or intentional close releases it.

`startMode` and `cache` remain unsupported because Miftah currently always lazily creates cached sessions. They are rejected rather than silently ignored.

Secret and audit redaction are force-on protections. Version `"1"` accepts `security.redactSecrets` and `audit.redact` only when they are `true` for compatibility; version `"2"` rejects both redundant declarations. Setting either to `false` is rejected in every supported version. Audit output is always JSONL; `audit.format` therefore accepts only `"jsonl"`.
