# Miftah

**Wrap any MCP. Use the right account without reconnecting.**

Miftah (`@lubab/miftah`) is a local MCP auth wrapper and credential broker for multi-account workflows. It sits between an MCP client such as Claude Desktop and an existing upstream MCP server, injects the selected profile's credentials, forwards MCP operations, and records redacted audit metadata.

Miftah is **not** a replacement for GitHub MCP, Sentry MCP, PostHog MCP, or any other provider MCP. It wraps them. The upstream server remains responsible for provider behavior; Miftah handles profile selection, secret injection, lifecycle, routing, policy, and redaction.

> **Status:** Miftah is experimental and pre-1.0. Interfaces and security behavior may change between minor versions. See the [release policy](CHANGELOG.md#release-policy) and use the [private disclosure process](SECURITY.md) for vulnerabilities.

## Install

For a published release:

```bash
npm install -g @lubab/miftah
```

Miftah runs locally by default. It has no cloud dependency or telemetry.

## Quick start

Generate a safe template:

```bash
miftah init github --preset github --output ~/.config/miftah/github.json --client claude-desktop
```

Set the generated profile environment references in the environment that launches your client, then validate the configuration:

```bash
miftah validate --config ~/.config/miftah/github.json
```

`init --client` prints a host-specific JSON snippet with absolute launcher paths. Copy that JSON to the appropriate client configuration; Miftah does not write a client file. See the [preset and client compatibility matrix](docs/presets-and-clients.md) for the catalog pin, client location, and security boundaries.

Run a wrapped server directly when testing local STDIO:

```bash
miftah --config ~/.config/miftah/github.json
```

To serve a local Streamable HTTP endpoint instead, configure `server.http` and run:

```bash
miftah serve --transport http --config ~/.config/miftah/github.json
```

The default endpoint is `http://127.0.0.1:3000/mcp`; see [HTTP server transport](docs/config.md#http-server-transport) before exposing any non-loopback address.

## Profiles

Profiles are named credential environments. Keep secret values outside JSON and use the exact generated references in the checked-in [GitHub](examples/github.miftah.json), [Sentry](examples/sentry.miftah.json), or [generic reference](examples/generic.miftah.json) example. The strict catalog pins GitHub to `ghcr.io/github/github-mcp-server:v1.5.0` with its documented read-only tool configuration; it does not claim a digest. The [compatibility matrix](docs/presets-and-clients.md) describes safe promotion and deployment recording for that tag.

Claude can call `miftah_list_profiles`, `miftah_current_profile`, `miftah_use_profile`, `miftah_reset_profile`, `miftah_lock_profile`, `miftah_unlock_profile`, `miftah_profile_info`, `miftah_health`, `miftah_validate_config`, `miftah_list_upstream_tools`, `miftah_restart_profile`, `miftah_verify_identity`, `miftah_route_preview`, `miftah_list_approvals`, `miftah_approve`, and `miftah_deny`. In a multi-upstream bundle, upstream tools are exposed as `<upstream>__<tool>`. For a single upstream whose exact tool name collides with a reserved management name, the default is `upstream_<name>`; `tooling.collisionStrategy: "fail"` instead rejects it. Other upstream names that merely start with `miftah_` are not reserved. After a profile change, restart, upstream failure, recovery, or upstream list-change notification that changes a public capability surface, MCP clients receive list-change notifications and should re-list the affected tools, resources, resource templates, or prompts before relying on cached capabilities.

Active profile state is in-memory by default. `state.scope: "session"` resets on a new MCP transport; opt-in `workspace` or config-identity-namespaced `global` scope persists only safe selection metadata (the profile and timestamp) using atomic owner-restricted storage. Clients cannot choose a scope or state path. Optional runtime locks and risk leases are connection-bound and never enter that durable state. See [active profile state](docs/config.md#active-profile-state) for lock precedence, fallback diagnostics, and platform paths.

For credential-file workflows, opt in to [profile credential isolation](docs/config.md#profile-credential-isolation). It gives each POSIX profile/upstream target a Miftah-managed HOME/XDG tree, can copy approved configuration-relative files into it, and can generate fixed Docker/Podman bind-mount arguments. It is deliberately not a sandbox for a hostile native process running as the same OS user.

For account bundles, define `upstreams` instead of `upstream`. Tools, resource names, resource-template names, and prompt names are exposed as `<upstream>__<name>` (for example `github__search_issues` and `github__account_prompt`), and each profile can provide per-upstream environment or header overrides. A multi-upstream resource URI is a Miftah-owned route such as `miftah://resource/github?uri=account%3A%2F%2Fcurrent`; resource templates use opaque Miftah-owned template bases. Their encoded values are redacted before exposure, while Miftah retains the exact original upstream URI or URI template only in its per-profile route map. Before exposing multi-upstream resource or prompt URI metadata, Miftah strips URI userinfo and fragments and redacts every query value. Reads and prompt gets are routed only through the exact route map, never by guessing from a client identifier.

For repeatable account selection, opt in to [provider routing matchers](docs/config.md#provider-routing-matchers) on a profile. Miftah's fixed built-in GitHub, Sentry, Jira, Linear, and PostHog matchers use only typed canonical identifiers and safe context, including an allowlisted canonical HTTPS provider URI on a standard resource read. Explicit hints and routing rules remain stronger, a matcher never authorizes a destructive operation by itself, and competing profile matches fail closed. For an explicit local extension, use the versioned [plugin API](docs/plugins.md); plugins run in contained child hosts and remain operator-trusted local code.

Multi-upstream resource, resource-template, and prompt lists use opaque, bounded in-memory Miftah cursors so individual upstream cursors are not exposed. Re-list after a profile change, restart, or upstream list-change notification instead of retaining an old cursor. When every selectable profile and upstream supports subscriptions, Miftah advertises `resources.subscribe`, proxies subscribe/unsubscribe calls through the same resource-read routing and policy boundary, and forwards only matching Miftah-namespaced resource-update URIs. Miftah probes those finite upstream capability handshakes sequentially, closes each probe session before accepting the client connection, and therefore does not guess an immutable MCP capability or hold profile capacity for the probe. Subscription transitions for one URI are serialized; a profile change clears every connection-bound subscription and bounds upstream cleanup by `process.shutdownTimeoutMs`. A standard `upstream` or a one-entry `upstreams` map preserves credential-free raw resource URIs, prompt names, and native upstream cursors for compatibility; URI and icon fields with userinfo, query values, or fragments are structurally redacted before they cross the boundary. A zero-entry bundle still omits resource and prompt capabilities.

`tooling.toolDiscoveryMode` defaults to `"permissive"`. In that mode, a bundled list returns only healthy upstream contributions, removes routes for failed upstreams, and retries incomplete tool discovery on later tool requests. If every upstream fails a capability list, Miftah returns `UPSTREAM_DISCOVERY_FAILED` instead of advertising an empty upstream surface. Set it to `"strict"` to reject any unavailable upstream; strict tool discovery additionally checks every configured profile for an identical client-visible tool contract. `miftah_health` reports the profile, upstream name, overall and process state, transition time, automatic restart count, redacted error, intentional stop reason, pending recovery time, and per-capability discovery state for each started upstream. See `examples/multi-upstream.miftah.json`.

## Remote upstreams

Use `"streamable-http"` for a remote MCP server:

```json
{
  "upstream": {
    "transport": "streamable-http",
    "url": "https://mcp.example.com/mcp",
    "headers": {
      "Authorization": "Bearer ${MCP_TOKEN}"
    }
  },
  "profiles": {
    "work": {
      "headers": {
        "authorization": "Bearer ${WORK_MCP_TOKEN}"
      }
    }
  }
}
```

Header names are case-insensitive, and a profile header always replaces the upstream header of the same name. Miftah requires HTTPS for non-loopback remote URLs; HTTP is accepted only for local development endpoints on `localhost`, `127.0.0.0/8`, or `::1`. The `"http"` transport is a version-1-only compatibility alias for `"streamable-http"`; version 2 requires `"streamable-http"`. `"sse"` remains available for legacy MCP servers but is deprecated; prefer Streamable HTTP for new deployments.

Remote authentication currently means explicitly configured static headers; Miftah does not yet run an upstream OAuth browser, callback, refresh, or revoke flow. Read [OAuth support](docs/oauth-support.md) before assuming a provider's remote or local OAuth mechanism is compatible.

An intentional Streamable HTTP restart or wrapper shutdown sends the MCP session DELETE request before closing the local client transport. A server may decline DELETE with HTTP 405, in which case Miftah still closes its local session but the remote server controls any remaining server-side state. If DELETE does not settle before the configured shutdown deadline, Miftah aborts the local transport rather than leaving a live credential session behind. Requested cancellation and requested progress notifications are forwarded across both local STDIO and Streamable HTTP upstreams. HTTP status failures are returned as `UPSTREAM_HTTP_ERROR` and MCP JSON-RPC failures as `UPSTREAM_PROTOCOL_ERROR`; response bodies and remote error messages are not exposed to callers.

Miftah uses the SDK's existing 60-second MCP request timeout and does not add a second request-timeout setting. Startup and shutdown retain the configured 30-second and 5-second defaults. The SDK performs its bounded Streamable HTTP SSE reconnection behavior; if the transport ultimately closes, Miftah's opt-in `process.restartOnCrash` policy and bounded `maxRestarts` budget control profile recovery.

## Routing and safety

Routing can use the active profile or rules matching tool arguments:

```json
{
  "routing": {
    "mode": "hybrid",
    "fallback": "ask",
    "rules": [
      {
        "name": "work-repository",
        "when": { "args.repo": "my-org/work" },
        "profile": "work"
      }
    ]
  }
}
```

When several profiles match, Miftah refuses to guess. Use explicit profile switching for write and destructive actions. The same routing, policy, redaction, and audit pipeline applies to upstream tool calls, resource reads and subscriptions, and prompt retrieval. Policy patterns use each upstream tool's original name for tools, `resources/read` for reads and subscriptions, and `prompts/get` for prompt retrieval. A deny, blocked, or ambiguous decision is returned before Miftah forwards the request. A confirmation-required operation pauses for a connection-bound, one-time approval: form-capable MCP clients receive a generic boolean elicitation, while other clients receive a short-lived fallback bearer for `miftah_approve` or `miftah_deny`. Provider token scopes still matter: local policy cannot make a write-capable provider token read-only. Profiles that set a policy name must reference an existing entry in `policies`, while profiles with no `policy` field keep the default allow behavior.

Miftah can also match bounded workspace metadata without treating a project file as configuration. It resolves a valid environment hint, then the nearest valid project-marker hint, then matching rules over tool arguments and collected context, then the configured fallback. Rules that select different profiles return `ROUTING_AMBIGUOUS`, and a context hint never authorizes a destructive operation that requires an explicit rule. `miftah_route_preview` and eligible audit records expose only sanitized routing evidence plus risk-classification source/confidence, not raw project environment values, upstream metadata, or project file contents. See [routing context](docs/config.md#routing-context) for the marker schema, root behavior, and evidence boundary.

## Identity verification

Identity verification is an optional account-fingerprint check, not provider authentication or authorization. Configure it under `profiles.<profile>.identity`, or under `profiles.<profile>.upstreams.<upstream>.identity` to replace that profile-level configuration for one named upstream. It can require a fresh matching fingerprint before explicitly configured write or destructive operations execute. Read discovery, resources, and prompts are not identity-gated.

`miftah_current_profile`, `miftah_health`, and `miftah_route_preview` show configured or cached safe status without starting an upstream or probing it. Use `miftah_verify_identity` to explicitly refresh configured targets; it returns safe structured status even if verification does not complete. See [identity verification configuration](docs/config.md#identity-verification) and the [security boundary](docs/security.md#identity-verification-boundary).

## Secret handling

Supported local references include environment variables (`${NAME}` and `secretref:env://NAME`), configured dotenv files (`secretref:dotenv://NAME`), explicitly opt-in plaintext (`secretref:plain://...`), OS keychain entries (`secretref:keychain://<service>/<account>`), 1Password fields (`secretref:op://<vault>/<item>/<field>`), and explicitly allowlisted local plugin schemes (`secretref:<plugin-id>://...`). External reference components are strictly percent-decoded once; keep credentials out of references and config files. Secrets are redacted from diagnostics, errors, stderr forwarding, audit entries, and tool responses. See [secret provider configuration](docs/config.md#secret-providers) and the [local plugin API](docs/plugins.md) for bounded execution and trust boundaries.

Use `miftah doctor` to inspect config and upstream readiness without printing process environment values.

## Audit logging

Set `audit.path` to record one terminal JSONL event for every supported MCP operation, including discovery, management, tool, resource, and prompt requests. Events include a per-process session ID, request/event ID, source and selected profiles, upstream, routing and policy metadata where applicable, terminal outcome, stable error code, and duration. Route previews and proxied operations additionally include sanitized `routingEvidence` from their collector snapshot. Wrapper and upstream lifecycle transitions are recorded separately. Arguments are omitted unless `audit.includeArguments` is `true`.

New audit directories and files use owner-only permissions where the platform supports them. `audit.failureMode` defaults to `"fail-closed"`, which verifies the audit sink before dispatch and refuses the request if it cannot be prepared. A terminal write can still fail after an upstream side effect completes, so treat a post-dispatch `AUDIT_WRITE_FAILED` as an indeterminate outcome and do not blindly retry non-idempotent tools. Set it to `"fail-open"` only when availability outweighs that guarantee; the original operation remains available and `miftah_health` reports a redacted `AUDIT_WRITE_FAILED` audit-health entry.

Optional rotation keeps a bounded local journal without breaking JSONL records:

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

At least one rotation trigger is required; `retainFiles` is the number of completed archive segments to keep in addition to the active file (maximum `2000`). Rotation and integrity require a non-empty `audit.path` and cannot be combined with `audit.enabled: false`. Miftah manages only its own regular archive files in the configured audit directory and refuses unsafe paths. Journal coordination is local to one host, so do not concurrently share a managed journal through a network filesystem. The optional integrity chain provides local tamper evidence across retained segments; use `miftah audit-verify --config <file>` to report the first safe broken location. It is not a signature or a remote immutable log, so preserve required evidence in an independently protected system.

`miftah audit-export --config <file> --output <file>` is an explicit local support export: it never uploads telemetry, redacts records again, and removes stored `arguments` by default. `--include-arguments` is an intentional opt-in and still redacts those values.

## CLI

Use `miftah --help` for the generated command list and `miftah <command> --help` for command-specific options. The available commands are:

| Command | Purpose |
| --- | --- |
| `miftah --config <file>` / `miftah serve --config <file>` | Run the STDIO MCP wrapper. Add `--transport http` to serve the configured local Streamable HTTP endpoint. |
| `miftah validate --config <file>` | Parse and validate JSON config; writes JSON. |
| `miftah doctor --config <file> [--json]` | Report redacted configuration and upstream readiness. |
| `miftah init [name] [--name <name>] [--preset <name>] [--output <file>] [--interactive] [--client <client>] [--credential-env <name>] [--npm-package <package>] [--docker-image <image>] [--url <url>] [--header-name <name>] [--header-prefix <prefix>]` | Generate a strict catalog template and optionally print client JSON. |
| `miftah migrate-config --config <file> [--write]` | Plan an explicit configuration-format migration; `--write` creates an exact backup before a same-directory non-overwriting publication. |
| `miftah schema` | Print the JSON Schema. |
| `miftah list-tools --config <file> [--profile <name>]` | Discover upstream tools as JSON. |
| `miftah test-profile --config <file> [--profile <name>]` | Start and initialize one profile; writes JSON. |
| `miftah logs --config <file> [--follow]` | Read normalized, redacted audit JSONL; follow rotation safely when requested. |
| `miftah audit-export --config <file> --output <file> [--include-arguments]` | Create an explicit, redacted audit support export. |
| `miftah audit-verify --config <file> [--json]` | Verify configured local audit-chain integrity without starting an upstream. |
| `miftah --version` / `miftah -v` / `miftah version [--json]` | Print the package SemVer. `--json` intentionally preserves bare SemVer output. |

Structured success output is written to stdout with stderr empty. Stable nonzero categories are usage (`2`), configuration (`3`), secret resolution (`4`), upstream (`5`), and policy (`6`); `1` is an uncategorized operational failure. Quote config and output paths with spaces. `logs --follow` handles appends, truncation, and rotation, and exits cleanly on `SIGINT` or `SIGTERM` without starting an upstream. See the complete [CLI reference](docs/cli.md) for help behavior, defaults, JSON contracts, redaction, and audit reader boundaries.

## Documentation

- [Architecture](docs/architecture.md)
- [Configuration](docs/config.md)
- [Security](docs/security.md)
- [Threat model](docs/threat-model.md)
- [OAuth and Console security design](docs/oauth-console-threat-model.md)
- [Security reporting](SECURITY.md)
- [CLI](docs/cli.md)
- [Library API](docs/library-api.md)
- [Claude Desktop](docs/claude-desktop.md)
- [Preset and client compatibility](docs/presets-and-clients.md)
- [GitHub example](docs/examples/github.md)
- [Sentry example](docs/examples/sentry.md)
- [Changelog and release policy](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

## Current boundaries

The current experimental code implements local STDIO plus loopback-first Streamable HTTP serving, remote HTTP/SSE upstream clients, profile switching with opt-in scoped persistence, hybrid routing rules plus fixed and explicitly allowlisted local plugin matchers, typed secret-provider plugins, policies, optional upstream identity verification, namespaced tools/resources/prompts for account bundles, resilient healthy-upstream discovery, configurable local process lifecycle controls, in-memory process/session caching, rotated redacted JSONL audit journals with optional local tamper evidence, and a packageable CLI. HTTP sessions are bounded, isolated, and cleaned up on expiry, DELETE, or shutdown; local process controls cover startup and shutdown deadlines, optional idle cleanup, opt-in crash recovery with a bounded retry budget, and no-eviction profile-session capacity limits. UI, legacy `routing.plugins`, `process.startMode`, `process.cache`, custom state paths, and configurable tool namespaces are rejected with `UNSUPPORTED_CONFIG_OPTION` rather than silently ignored.

## License

MIT
