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
miftah init github --preset github --output ~/.config/miftah/github.json
```

Edit the profile environment to reference shell variables, then validate it:

```bash
export GITHUB_WORK_TOKEN='...'
miftah validate --config ~/.config/miftah/github.json
```

Run a wrapped server directly:

```bash
miftah --config ~/.config/miftah/github.json
```

The same process can be configured in Claude Desktop:

```json
{
  "mcpServers": {
    "github": {
      "command": "miftah",
      "args": ["--config", "/Users/me/.config/miftah/github.json"]
    }
  }
}
```

## Profiles

Profiles are named credential environments. Keep secret values outside JSON whenever possible:

```json
{
  "version": "1",
  "name": "github",
  "defaultProfile": "work",
  "upstream": {
    "transport": "stdio",
    "command": "docker",
    "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server:v1.5.0"]
  },
  "profiles": {
    "work": {
      "description": "Work GitHub",
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_WORK_TOKEN}"
      },
      "policy": "safe-write"
    },
    "personal": {
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_TOKEN}"
      },
      "policy": "readonly"
    }
  },
  "policies": {
    "readonly": {
      "allowRisk": ["read"],
      "denyRisk": ["write", "destructive"]
    },
    "safe-write": {
      "allowRisk": ["read", "write"],
      "denyRisk": ["destructive"],
      "requireConfirmation": ["write"]
    }
  },
  "security": {
    "allowPlaintextSecrets": false,
    "allowProfileSwitchingFromMcp": true,
    "requireExplicitProfileForDestructive": true
  }
}
```

The GitHub preset pins `ghcr.io/github/github-mcp-server:v1.5.0`. To upgrade safely, read the release notes first, update the tag in your config, run `miftah validate`, then smoke-test both profiles before rollout.

Claude can call `miftah_list_profiles`, `miftah_current_profile`, `miftah_use_profile`, `miftah_profile_info`, `miftah_health`, `miftah_validate_config`, `miftah_list_upstream_tools`, `miftah_restart_profile`, and `miftah_route_preview`. Upstream tools are exposed unchanged unless they collide with a reserved management name. After a profile change, restart, upstream failure, or recovery that changes a public capability surface, MCP clients receive list-change notifications and should re-list the affected tools, resources, or prompts before relying on cached capabilities.

For account bundles, define `upstreams` instead of `upstream`. Tools, resource names, and prompt names are exposed as `<upstream>__<name>` (for example `github__search_issues` and `github__account_prompt`), and each profile can provide per-upstream environment or header overrides. A multi-upstream resource URI is a Miftah-owned route such as `miftah://resource/github?uri=account%3A%2F%2Fcurrent`; its encoded value is redacted before exposure, while Miftah retains the exact original URI only in its per-profile route map. Before exposing multi-upstream resource or prompt URI metadata, Miftah strips URI userinfo and fragments and redacts every query value. Reads and prompt gets are routed only through the exact route map, never by guessing from a client identifier.

Multi-upstream resource and prompt lists use opaque, bounded in-memory Miftah cursors so individual upstream cursors are not exposed. Re-list after a profile change or restart instead of retaining an old cursor. A standard `upstream` or a one-entry `upstreams` map preserves credential-free raw resource URIs, prompt names, and native upstream cursors for compatibility; URI and icon fields with userinfo, query values, or fragments are structurally redacted before they cross the boundary. A zero-entry bundle still omits resource and prompt capabilities.

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

Header names are case-insensitive, and a profile header always replaces the upstream header of the same name. Miftah requires HTTPS for non-loopback remote URLs; HTTP is accepted only for local development endpoints on `localhost`, `127.0.0.0/8`, or `::1`. The `"http"` transport is a compatibility alias for `"streamable-http"`. `"sse"` remains available for legacy MCP servers but is deprecated; prefer Streamable HTTP for new deployments.

An intentional Streamable HTTP restart or wrapper shutdown sends the MCP session DELETE request before closing the local client transport. A server may decline DELETE with HTTP 405, in which case Miftah still closes its local session but the remote server controls any remaining server-side state. If DELETE does not settle before the configured shutdown deadline, Miftah aborts the local transport rather than leaving a live credential session behind. HTTP status failures are returned as `UPSTREAM_HTTP_ERROR` and MCP JSON-RPC failures as `UPSTREAM_PROTOCOL_ERROR`; response bodies and remote error messages are not exposed to callers.

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

When several profiles match, Miftah refuses to guess. Use explicit profile switching for write and destructive actions. The same routing, policy, redaction, and audit pipeline applies to upstream tool calls, resource reads, and prompt retrieval. Policy patterns use each upstream tool's original name for tools, `resources/read` for reads, and `prompts/get` for prompt retrieval. A deny, confirmation-required, blocked, or ambiguous decision is returned before Miftah forwards the read or prompt request. Provider token scopes still matter: local policy cannot make a write-capable provider token read-only. Profiles that set a policy name must reference an existing entry in `policies`, while profiles with no `policy` field keep the default allow behavior.

## Secret handling

Supported local references include environment variables (`${NAME}` and `secretref:env://NAME`), configured dotenv files (`secretref:dotenv://NAME`), and explicitly opt-in plaintext (`secretref:plain://...`). OS keychains and external secret CLIs are reserved extension points. Secrets are redacted from diagnostics, errors, stderr forwarding, audit entries, and tool responses.

Use `miftah doctor` to inspect config and upstream readiness without printing process environment values.

## Audit logging

Set `audit.path` to record one terminal JSONL event for every supported MCP operation, including discovery, management, tool, resource, and prompt requests. Events include a per-process session ID, request/event ID, source and selected profiles, upstream, routing and policy metadata where applicable, terminal outcome, stable error code, and duration. Wrapper and upstream lifecycle transitions are recorded separately. Arguments are omitted unless `audit.includeArguments` is `true`.

New audit directories and files use owner-only permissions where the platform supports them. `audit.failureMode` defaults to `"fail-closed"`, which verifies the audit sink before dispatch and refuses the request if it cannot be prepared. A terminal write can still fail after an upstream side effect completes, so treat a post-dispatch `AUDIT_WRITE_FAILED` as an indeterminate outcome and do not blindly retry non-idempotent tools. Set it to `"fail-open"` only when availability outweighs that guarantee; the original operation remains available and `miftah_health` reports a redacted `AUDIT_WRITE_FAILED` audit-health entry.

## CLI

Use `miftah --help` for the generated command list and `miftah <command> --help` for command-specific options. The available commands are:

| Command | Purpose |
| --- | --- |
| `miftah --config <file>` / `miftah serve --config <file>` | Run the STDIO MCP wrapper. |
| `miftah validate --config <file>` | Parse and validate JSON config; writes JSON. |
| `miftah doctor --config <file> [--json]` | Report redacted configuration and upstream readiness. |
| `miftah init [name] [--name <name>] [--preset <name>] [--output <file>]` | Generate a generic, GitHub, or Sentry template. |
| `miftah schema` | Print the JSON Schema. |
| `miftah list-tools --config <file> [--profile <name>]` | Discover upstream tools as JSON. |
| `miftah test-profile --config <file> [--profile <name>]` | Start and initialize one profile; writes JSON. |
| `miftah logs --config <file> [--follow]` | Read normalized, redacted audit JSONL; follow rotation safely when requested. |
| `miftah --version` / `miftah -v` / `miftah version [--json]` | Print the package SemVer. `--json` intentionally preserves bare SemVer output. |

Structured success output is written to stdout with stderr empty. Stable nonzero categories are usage (`2`), configuration (`3`), secret resolution (`4`), upstream (`5`), and policy (`6`); `1` is an uncategorized operational failure. Quote config and output paths with spaces. `logs --follow` handles appends, truncation, and rotation, and exits cleanly on `SIGINT` or `SIGTERM` without starting an upstream. See the complete [CLI reference](docs/cli.md) for help behavior, defaults, JSON contracts, redaction, and audit reader boundaries.

## Documentation

- [Architecture](docs/architecture.md)
- [Configuration](docs/config.md)
- [Security](docs/security.md)
- [Security reporting](SECURITY.md)
- [CLI](docs/cli.md)
- [Library API](docs/library-api.md)
- [Claude Desktop](docs/claude-desktop.md)
- [GitHub example](docs/examples/github.md)
- [Sentry example](docs/examples/sentry.md)
- [Changelog and release policy](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

## Current boundaries

The current experimental code implements local STDIO and remote HTTP/SSE upstream clients, profile switching, hybrid routing rules, policies, namespaced tools/resources/prompts for account bundles, resilient healthy-upstream discovery, configurable local process lifecycle controls, in-memory process/session caching, redacted JSONL audit logging, and a packageable CLI. Local process controls cover startup and shutdown deadlines, optional idle cleanup, opt-in crash recovery with a bounded retry budget, and no-eviction profile-session capacity limits. Persisted state, UI, routing plugins, profile matchers, `process.startMode`, `process.cache`, and configurable tool namespaces are rejected with `UNSUPPORTED_CONFIG_OPTION` rather than silently ignored.

## License

MIT
