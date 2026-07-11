# Presets and client onboarding

This is the compatibility source of truth for generated `miftah init` configurations and client snippets.

- Catalog version: `1`
- Miftah package version: `0.1.1`
- Last tested / validation boundary: the catalog builds strict Miftah configuration that `validateConfig` accepts. The docs contract test checks generated configuration and runtime construction only; it does **not** start, authenticate to, or smoke-test external providers.

Miftah itself requires Node.js `>=20`. That does not establish an upstream server's Node requirement.

## Catalog compatibility matrix

| Catalog key | Exact generated command or required input | Upstream requirements and security boundary |
| --- | --- | --- |
| `generic` | `npx --yes @modelcontextprotocol/server-everything@2026.7.4 stdio` | This is the MCP reference/test server, not a production-ready provider recommendation. Its npm metadata declares no upstream Node engine floor. An optional `--credential-env <name>` adds only a `${ENV_NAME}` reference. |
| `github` | Docker STDIO: `docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server:v1.5.0 stdio --read-only --toolsets=repos,issues,pull_requests` | Docker is required. Supply least-privilege GitHub provider tokens through the generated environment references. The catalog intentionally pins a tag, **not** an invented OCI digest. Before a reproducible production deployment, use an authenticated registry process to promote the approved tag, inspect and record its resolved digest in deployment records, then deploy that recorded digest according to the [GitHub digest guidance](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pull-by-digest). |
| `sentry` | `npx --yes @sentry/mcp-server@0.36.0 --skills=inspect`; generated environment reference: `SENTRY_ACCESS_TOKEN` | The upstream package requires Node.js `>=20`. Use least-privilege Sentry token scopes. `--skills=inspect` filters CLI skills; it is not provider-token authorization and is not a read-only flag or preset. Miftah local policy does not reduce provider token permissions. |
| `generic-npx` | Required: `--npm-package <exact-package@x.y.z>`; optional `--credential-env <name>` | Only an exact npm package SemVer is accepted. The selected external package, not Miftah, declares its own Node requirement. |
| `generic-docker` | Required: `--docker-image <canonical-image@sha256:...>`; optional `--credential-env <name>` | Docker is required. Only a canonical image reference with a 64-hex-character `@sha256:` digest is accepted. |
| `streamable-http` | Required: `--url <https-url>`; optional credential metadata: `--credential-env`, `--header-name`, and `--header-prefix` | The URL must be HTTPS and must not contain userinfo, a query, or a fragment. Credentials may appear only as `${ENV_NAME}` through validated header metadata; allowed prefixes are empty, `Bearer `, and `Sentry `. Never place a credential in a URL or URL component. |

The three checked-in provider/reference examples are exact catalog output: `examples/generic.miftah.json`, `examples/github.miftah.json`, and `examples/sentry.miftah.json`. They contain secret references only, never credentials.

## Provenance and last-tested sources

Use the following upstream materials when assessing a pin or provider configuration. They describe upstream behavior; Miftah's validation boundary above does not assert that a provider was started in CI.

### GitHub MCP

- [GitHub MCP source](https://github.com/github/github-mcp-server)
- [GitHub IDE setup](https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server)
- [GitHub read-only mode](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md#read-only-mode)
- [GitHub tool configuration](https://github.com/github/github-mcp-server#tool-configuration)
- [GitHub Container registry pull by digest](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#pull-by-digest)

### Sentry MCP and MCP Everything

- [Sentry MCP source at `0.36.0`](https://github.com/getsentry/sentry-mcp/tree/0.36.0)
- [Sentry package metadata at `0.36.0`](https://registry.npmjs.org/@sentry/mcp-server/0.36.0)
- [Sentry `0.36.0` CLI usage](https://github.com/getsentry/sentry-mcp/blob/0.36.0/packages/mcp-server/src/cli/usage.ts)
- [MCP Everything source](https://github.com/modelcontextprotocol/servers/tree/main/src/everything)
- [MCP Everything npm package](https://www.npmjs.com/package/@modelcontextprotocol/server-everything)

## First run

`init` uses the strict catalog. The default preset is `generic`; an unknown preset is rejected rather than falling back. (The legacy library-only `presetConfig` fallback does not describe CLI behavior.)

```sh
miftah init [name] \
  [--name <name>] [--preset <name>] [--output <file>] \
  [--interactive] [--client <claude-desktop|claude-code|cursor|vscode|all>] \
  [--credential-env <name>] [--npm-package <package>] \
  [--docker-image <image>] [--url <url>] \
  [--header-name <name>] [--header-prefix <prefix>]
```

Without `--interactive`, `init` creates only a configuration unless `--client` is supplied. With `--client`, it still creates the configuration and prints JSON snippets; it never writes a client file. Creation is exclusive and never overwrites an existing output path.

`--interactive` is available only when both input and output are real TTYs. EOF or Ctrl-C cancels before the configuration write. The wizard asks only for a name, catalog preset, safe preset metadata (variable names, URLs, header metadata, pins), output location, and client selection. It never asks for or echoes a secret value.

The printed snippets use absolute paths to the Node executable and compiled Miftah CLI so GUI clients do not depend on `PATH`. Regenerate them after moving or upgrading Miftah, or after changing the configuration path. Copy generated JSON as JSON; do not hand-edit the command into a shell string.

## Client destinations and JSON shapes

Miftah does not create any of these files. Copy only the generated JSON into the matching host configuration.

| Client | Target and scope | Required shape |
| --- | --- | --- |
| Claude Desktop | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`; Linux: `~/.config/Claude/claude_desktop_config.json`. Use Claude Desktop’s **Developer → Edit Config** flow as the source of truth for the installed app. | `mcpServers` with the generated command/args object. |
| Claude Code | Project `.mcp.json` is the generated-snippet target. Claude Code also supports user and local scopes; consult its own scope behavior before choosing either instead of treating the project file as global. | `mcpServers` with the generated command/args object. The generated `.mcp.json` is authoritative for this workflow. |
| Cursor | Project `.cursor/mcp.json`, or global `~/.cursor/mcp.json`. | `mcpServers`, with each generated server explicitly declaring `"type": "stdio"`. |
| VS Code | Use **MCP: Open User Configuration** for user scope, or workspace `.vscode/mcp.json`. | `servers`, with each generated server explicitly declaring `"type": "stdio"`. |

For Claude Code, the official [`claude mcp add` workflow](https://code.claude.com/docs/en/mcp) is a secondary way to manage its own configuration. Prefer the generated project `.mcp.json` here so the copied JSON remains reviewable and matches Miftah's output.

## Client references

- [Claude Code MCP](https://code.claude.com/docs/en/mcp)
- [Cursor MCP](https://cursor.com/docs/mcp)
- [VS Code MCP servers](https://code.visualstudio.com/docs/agent-customization/mcp-servers)
- [VS Code MCP configuration reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration)
