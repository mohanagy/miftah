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
    "args": ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"]
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

Claude can call `miftah_list_profiles`, `miftah_current_profile`, `miftah_use_profile`, `miftah_profile_info`, `miftah_health`, `miftah_validate_config`, `miftah_list_upstream_tools`, `miftah_restart_profile`, and `miftah_route_preview`. Upstream tools are exposed unchanged unless they collide with a reserved `miftah_` name.

For account bundles, define `upstreams` instead of `upstream`. Tools are exposed as `<upstream>__<tool>` (for example `github__search_issues`) and each profile can provide per-upstream environment or header overrides. See `examples/multi-upstream.miftah.json`.

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

When several profiles match, Miftah refuses to guess. Use explicit profile switching for write and destructive actions. Local policies can deny risky tools or return a confirmation-needed result. Provider token scopes still matter: local policy cannot make a write-capable provider token read-only.

## Secret handling

Supported local references include environment variables (`${NAME}` and `secretref:env://NAME`), configured dotenv files (`secretref:dotenv://NAME`), and explicitly opt-in plaintext (`secretref:plain://...`). OS keychains and external secret CLIs are reserved extension points. Secrets are redacted from diagnostics, errors, stderr forwarding, audit entries, and tool responses.

Use `miftah doctor` to inspect config and upstream readiness without printing process environment values.

## CLI

| Command | Purpose |
| --- | --- |
| `miftah --config <file>` | Run the STDIO MCP wrapper |
| `miftah serve --config <file>` | Run the wrapper explicitly |
| `miftah validate --config <file>` | Parse and validate JSON config |
| `miftah doctor --config <file>` | Validate config and report redacted runtime details |
| `miftah init <name> --preset <generic\|github\|sentry>` | Generate a template |
| `miftah schema` | Print the JSON Schema |
| `miftah list-tools --config <file> [--profile <name>]` | Discover upstream tools |
| `miftah test-profile --config <file> --profile <name>` | Start and initialize one profile |
| `miftah logs --config <file>` | Read the configured JSONL audit log |

## Documentation

- [Architecture](docs/architecture.md)
- [Configuration](docs/config.md)
- [Security](docs/security.md)
- [Security reporting](SECURITY.md)
- [CLI](docs/cli.md)
- [Claude Desktop](docs/claude-desktop.md)
- [GitHub example](docs/examples/github.md)
- [Sentry example](docs/examples/sentry.md)
- [Changelog and release policy](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

## Current boundaries

The current experimental code implements local STDIO and remote HTTP/SSE upstream clients, profile switching, routing rules, policies, tools/resources/prompts proxying, process/session caching, redacted audit logging, and a packageable CLI. The configuration model reserves interfaces for multi-upstream account bundles, persisted state, and optional UI.

## License

MIT
