# Miftah

## One MCP connector. Deliberate account selection.

You already have an MCP for GitHub, Sentry, PostHog, or another service. The hard part starts when you use that same MCP service across more than one account, client, project, or environment.

Miftah is a local MCP profile manager and safety layer. It wraps the upstream server you already use, gives it named profiles such as `personal`, `work`, `client-a`, or `production`, and keeps account selection intentional.

```text
Claude, Cursor, or VS Code
            │
    one Miftah connector
            │
       ┌────┴────┐
     work     personal
       │          │
       same upstream MCP
```

Miftah runs locally by default. Miftah itself has no cloud service or telemetry; it connects only to the upstreams you configure.

> **Status:** Miftah is experimental and pre-1.0. Interfaces and security behavior may change between minor versions. See the [release policy](CHANGELOG.md#release-policy) and use the [private disclosure process](SECURITY.md) for vulnerabilities.

## Why Miftah exists

Without Miftah, a multi-account setup usually becomes a growing list of client entries: `github-personal`, `github-work`, `sentry-client-a`, `sentry-client-b`, and so on. That works, but every new account duplicates launch configuration and makes the client entry—not the account context—the thing you have to manage.

| Instead of this | Miftah gives you this |
| --- | --- |
| One client entry for every account | One Miftah connector per service, with named profiles for each account or environment |
| Repeated launch settings and credential wiring | Profile-scoped credential references that stay outside client configuration |
| Manual connector selection with little context | Explicit profile switching and optional routing rules for stable, known context |
| No consistent local record of what happened | Optional, redacted local audit metadata and health/diagnostic tools |

Do not create one client entry for every account. Add one Miftah connector per service, then manage the accounts behind it as profiles.

Miftah wraps an existing upstream MCP server. It does not replace it. The upstream still owns its provider tools and provider behavior. Miftah adds the local profile, credential, routing, policy, approval, lifecycle, redaction, and audit boundaries around it.

## Choose your setup path

Start with the row that describes how your upstream MCP authenticates.

| Your upstream MCP | Use this Miftah path |
| --- | --- |
| GitHub or Sentry | Generate a strict built-in preset with `miftah init`. |
| Another exact-pinned local STDIO server | Use `generic-npx` or `generic-docker`, then add profiles around it. |
| Remote HTTPS Streamable HTTP with a token or API key | Use the `streamable-http` preset with a secret-backed header. |
| Remote HTTPS Streamable HTTP with standards-compatible OAuth | Use Native remote OAuth through `miftah dashboard` or the `connection` and `auth` CLI commands. |
| Local or provider-specific MCP that opens its own OAuth flow | Use Upstream-owned OAuth. Miftah wraps the process but does not take over its token cache. |
| Google Search Console | Use the reviewed `google-search-console` adapter preset. OAuth remains upstream-owned. |
| One account and no need for profile, policy, routing, or audit controls | Keep the direct MCP entry; Miftah may not add value for this case. |

Miftah requires Node.js 20 or newer. Each upstream keeps its own runtime and installation requirements; for example, the GitHub preset requires Docker and the Google Search Console adapter requires Python 3.11 or newer plus `uvx`.

Shell examples below use POSIX syntax, including `~`, `$HOME`, and `\` line continuations. On Windows, run the same Miftah options from PowerShell with Windows paths and PowerShell line continuation, or put the command on one line.

## First setup: GitHub with Claude Desktop

This path creates one Claude connector backed by two GitHub profiles: `work` and `personal`.

### 1. Install Miftah

```bash
npm install -g @lubab/miftah
miftah version
```

### 2. Generate the Miftah configuration and client JSON

```bash
miftah init github --preset github --output ~/.config/miftah/github.json --client claude-desktop
```

The command:

- creates `~/.config/miftah/github.json`;
- generates the `work` and `personal` profiles;
- configures the exact-pinned GitHub MCP Docker launch;
- puts the generated profiles behind a read-only Miftah policy; and
- prints a Claude Desktop `mcpServers` snippet with absolute launcher paths.

It does not modify Claude Desktop and does not ask for or write a token value. The complete generated configuration is checked in as the [GitHub example](examples/github.miftah.json).

### 3. Provide the two credentials

The generated profiles refer to `GITHUB_WORK_TOKEN` and `GITHUB_PERSONAL_TOKEN`. Supply least-privilege provider tokens through one supported secret source:

- a GUI-visible process environment using `${ENV_NAME}` or `secretref:env://ENV_NAME`;
- a configured dotenv file;
- the OS keychain using `secretref:keychain://<service>/<account>`;
- 1Password using `secretref:op://<vault>/<item>/<field>`; or
- an explicitly reviewed local secret-provider plugin.

Claude Desktop is a GUI app and does not inherit terminal startup files such as `~/.zshrc`. A token exported only from an interactive shell can pass a terminal check and still be missing when Claude starts Miftah. Use a supported secret provider, configured dotenv file, or an environment visible to the GUI process.

Keep raw token values out of the Miftah JSON and Claude JSON. See [secret providers](docs/config.md#secret-providers) for the exact reference grammar and prerequisites.

### 4. Validate configuration and readiness

```bash
miftah validate --config ~/.config/miftah/github.json
miftah doctor --config ~/.config/miftah/github.json
miftah test-profile --config ~/.config/miftah/github.json --profile work
miftah list-tools --config ~/.config/miftah/github.json --profile personal
```

These commands answer different questions:

- `validate` checks the JSON and cross-references without starting the upstream.
- `doctor` resolves the required secret references and checks redacted upstream readiness.
- `test-profile` starts and initializes one exact profile.
- `list-tools` shows the tools exposed by one profile, then shuts it down.

Do not treat a successful `validate` as proof that the credential, Docker launch, provider scopes, or account identity are correct.

### 5. Add the generated connector to Claude Desktop

Open Claude Desktop and use **Developer → Edit Config**. The normal locations are:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Merge the generated top-level `mcpServers` property into the host file. If the file already has an `mcpServers` object, add only the generated server entry inside it; do not nest a second `mcpServers` object.

Keep the generated `command` as a string and `args` as an array, with the absolute paths exactly as printed. Do not turn them into a shell command.

Save the file and restart Claude Desktop. Miftah cannot replace an already-running client's in-memory MCP session after a configuration, dashboard, or durable profile change.

For host-specific notes, use the [Claude Desktop setup](docs/claude-desktop.md). The same generator also supports Claude Code, Cursor, and VS Code; see [Preset and client compatibility](docs/presets-and-clients.md).

### 6. Select and verify the account in Claude

Miftah exposes profile management as MCP tools. The user or agent can call:

| MCP management tool | Purpose |
| --- | --- |
| `miftah_list_profiles` | List configured profiles and safe binding state. |
| `miftah_current_profile` | Show the active/default profile and how it was selected. |
| `miftah_profile_info` | Inspect one profile's non-secret configuration and identity state. |
| `miftah_use_profile` | Deliberately switch to a named profile. |
| `miftah_reset_profile` | Return to the configured default profile. |
| `miftah_route_preview` | Preview profile selection and policy without performing the provider operation. |
| `miftah_health` | Inspect wrapper and upstream lifecycle health. |
| `miftah_verify_identity` | Run a configured bounded identity probe. |

For example, ask Claude:

```text
List the profiles available through `github`.
Switch `github` to the personal profile.
Confirm the current profile before reading my repositories.
```

The underlying calls are `miftah_list_profiles`, `miftah_use_profile`, and `miftah_current_profile`. The generated GitHub preset requires confirmation for every profile switch. With the default human approval mode, the client must support MCP form elicitation; a client without it cannot switch and Miftah fails closed. Use a form-capable client, or explicitly configure delegated-agent approval only after reviewing the [profile confirmation trade-off](docs/config.md#profile-confirmation-locks-and-leases).

## Add another MCP

Built-in presets are reviewed, exact-pinned configurations. Generic compatibility means Miftah can wrap another MCP server; it does not mean that every provider has a built-in preset or that Miftah reimplements its API.

### Built-in and generic presets

| Preset | Intended use |
| --- | --- |
| `github` | Docker-based GitHub MCP with `work` and `personal` profiles |
| `sentry` | Exact-pinned Sentry MCP with a token reference |
| `google-search-console` | Exact-pinned `uvx` adapter with upstream-owned OAuth |
| `generic` | MCP reference/test server, not a production provider recommendation |
| `generic-npx` | Another exact-version npm MCP package |
| `generic-docker` | Another container pinned by canonical `@sha256:` digest |
| `streamable-http` | An exact HTTPS Streamable HTTP upstream |

### Minimal exact-pinned npm MCP template

If the upstream's documented launch is `npx --yes <package>@<version>` and it accepts a credential through an environment variable:

```bash
miftah init analytics \
  --preset generic-npx \
  --npm-package '@vendor/mcp-server@1.2.3' \
  --credential-env SERVICE_API_KEY \
  --output ~/.config/miftah/analytics.json \
  --client claude-desktop
```

Replace the example package, version, and variable name with the upstream's documented values. An exact version is required. Run `validate`, `doctor`, `test-profile`, and `list-tools` before adding the printed client JSON.

If the upstream needs custom arguments, headers, working directories, several named upstreams, or profile-specific overrides, generate the nearest safe preset and then use the [Configuration reference](docs/config.md). Always keep subprocess arguments as arrays; Miftah does not need a shell command string.

### What a multi-profile configuration contains

The GitHub preset is a runnable two-profile example. Its central account mapping is:

```json
{
  "defaultProfile": "work",
  "profiles": {
    "work": {
      "description": "Work GitHub account",
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_WORK_TOKEN}"
      },
      "policy": "readonly"
    },
    "personal": {
      "description": "Personal GitHub account",
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_TOKEN}"
      },
      "policy": "readonly"
    }
  }
}
```

This excerpt is not a complete configuration by itself. Generate or copy the complete [GitHub example](examples/github.miftah.json), which also contains the upstream, policy, routing, security, process, audit, and tooling sections.

## OAuth and the local dashboard

OAuth has two ownership models. Choosing the wrong one creates false expectations about where credentials live and who can refresh or revoke them.

### Native remote OAuth

Miftah can own OAuth only for an exact HTTPS Streamable HTTP MCP whose discovery metadata satisfies Miftah's standards and security checks. In that path, Miftah performs discovery, PKCE browser authorization, bounded loopback callback handling, secure OS-vault storage, refresh, and bearer injection.

The easiest first run is:

```bash
miftah dashboard
```

`miftah dashboard` uses `~/.config/miftah/miftah.json` by default. That is separate from the `github.json` created earlier. Pass `--config` when you intend to open another Miftah configuration. First-run onboarding is available only when the selected target file does not exist; the dashboard never overwrites an existing file.

The optional dashboard:

1. starts a foreground-only service on literal `127.0.0.1`;
2. opens the system browser and asks for the one-time bootstrap code printed in the terminal;
3. creates a first validated Native remote OAuth profile and connection when the selected config path does not exist;
4. offers a separate **Connect** action that starts the reviewed system-browser authorization;
5. shows redacted connection and audit state; and
6. generates client JSON for you to review and copy.

Keep the terminal process running while using the dashboard. Closing it stops the local listener. There is no daemon, hosted account, LAN mode, or automatic client-file edit. After a durable configuration or connection change, copy any regenerated client JSON and restart or reconnect the MCP client.

Use another config path or suppress automatic browser launch with:

```bash
miftah dashboard --config ~/.config/miftah/remote-service.json
miftah dashboard --config ~/.config/miftah/remote-service.json --no-open
```

The equivalent CLI path is plan-first:

```bash
miftah init remote-service --preset streamable-http --url https://mcp.example.com --output ~/.config/miftah/remote-service.json
```

The `streamable-http` preset creates one profile named `default`, so use that exact profile when registering the connection:

```bash
miftah connection add --config ~/.config/miftah/remote-service.json \
  --profile default \
  --upstream default \
  --issuer https://auth.example.com \
  --client-registration dynamic \
  --scope mcp:read

# Review the generated oauthconn:<uuid>, then repeat with:
miftah connection add --config ~/.config/miftah/remote-service.json \
  --profile default \
  --upstream default \
  --issuer https://auth.example.com \
  --client-registration dynamic \
  --scope mcp:read \
  --connection oauthconn:<uuid> \
  --write

miftah auth connect --config ~/.config/miftah/remote-service.json --connection oauthconn:<uuid>
miftah connection test --config ~/.config/miftah/remote-service.json --connection oauthconn:<uuid>
miftah connection list --config ~/.config/miftah/remote-service.json --client claude-desktop
```

Read [OAuth support](docs/oauth-support.md) before using this path. Miftah does not support OAuth for every MCP, and OAuth success alone does not prove that the token belongs to the intended account or organization.

### Upstream-owned OAuth

Provider-specific or local STDIO OAuth remains owned by that upstream. The upstream opens its browser flow, stores its cache, refreshes its tokens, and defines reauthentication or revocation. Miftah may wrap the process and protect its profile/policy boundary, but it does not scrape or reinterpret the upstream cache as native Miftah OAuth.

The Google Search Console adapter is the concrete example:

```bash
miftah init gsc \
  --preset google-search-console \
  --oauth-client-secrets-file "$HOME/.config/gsc/client-secrets.json" \
  --output "$HOME/.config/miftah/gsc.json" \
  --client claude-desktop
```

It runs the exact-pinned upstream through `uvx`, applies Miftah's read-only policy, and passes the configured client-secrets path to that upstream. The upstream owns the first-use browser flow and token cache. Miftah never reads, copies, exports, or deletes that cache. See the [Google Search Console provider-adapter pilot](docs/provider-adapters.md#google-search-console-pilot).

## Everyday commands

These are shell commands. Profile switching and identity tools such as `miftah_use_profile` are MCP management tools used from the connected client.

| Task | Command |
| --- | --- |
| Validate JSON only | `miftah validate --config service.json` |
| Check secrets, executable, upstream startup, discovery, and shutdown | `miftah doctor --config service.json` |
| Start one profile and verify initialization | `miftah test-profile --config service.json --profile work` |
| Discover one profile's upstream tools | `miftah list-tools --config service.json --profile work` |
| Read redacted audit events | `miftah logs --config service.json` |
| Follow redacted audit events | `miftah logs --config service.json --follow` |
| Create a redacted support snapshot | `miftah audit-export --config service.json --output support-audit.jsonl` |
| Verify configured hash-chain integrity | `miftah audit-verify --config service.json` |
| Print the JSON Schema | `miftah schema` |
| Review a supported config migration | `miftah migrate-config --config service.json` |
| Apply the reviewed migration | `miftah migrate-config --config service.json --write` |

Use `miftah --help` or `miftah <command> --help` for the installed version's exact grammar. The complete compatibility contract is in the [CLI reference](docs/cli.md).

## Secrets, policy, routing, and identity

### Secrets

Supported profile values include:

```text
${ENV_NAME}
secretref:env://ENV_NAME
secretref:keychain://<service>/<account>
secretref:op://<vault>/<item>/<field>
```

Dotenv paths belong in `secrets.envFiles`. Plaintext values in configuration are disabled unless the operator explicitly opts into that weaker mode. Miftah registers resolved values with its redactor before diagnostics, health, audit, or upstream errors can expose them.

For credential files that must differ between profiles, use [profile credential isolation](docs/config.md#profile-credential-isolation). It can materialize profile-owned copies and mount only the selected profile into a supported container workflow; it is not a general same-user sandbox.

### Policy and approvals

Profiles can name a local policy. Policies classify operations as `read`, `write`, or `destructive`, then allow, deny, or require confirmation. A Miftah policy does not reduce provider-side token scopes: use least-privilege provider credentials as the first boundary.

Human confirmation is the default. Delegated-agent approval is an explicit automation mode with a short-lived exact-action bearer; it is not proof that a human approved the action. See [operation routing and policy](docs/config.md#operation-routing-and-policy).

### Routing and profile control

Explicit profile selection is the safest answer when account identity matters. For stable context, configured rules, [provider routing matchers](docs/config.md#provider-routing-matchers), and [routing context](docs/config.md#routing-context) can select a profile from bounded repository, organization, project, URL, or client-root evidence. Ambiguous evidence fails closed.

Use `miftah_route_preview` before a sensitive call to see the selected profile, routing reason, policy decision, risk classification, and safe evidence without forwarding the provider operation.

When enabled, `miftah_lock_profile` and `miftah_unlock_profile` add a connection-bound runtime lock. A configured operator lock remains stronger and cannot be removed through MCP.

### Identity

OAuth success and valid credentials do not prove that the intended account is active. An optional bounded identity probe can bind expected provider evidence to one profile. Use `miftah_verify_identity` for a live check and inspect cached or persisted state through `miftah_profile_info`, `miftah_current_profile`, `miftah_health`, or `miftah_route_preview`.

## Common first-run problems

### `DEFAULT_PROFILE_NOT_FOUND`

`defaultProfile` must exactly match a key under `profiles`. Run `miftah validate --config <file>` after every manual edit.

### `SECRET_ENV_MISSING` even though the variable is in `.zshrc`

Claude Desktop does not inherit your interactive shell startup files. Move the reference to a configured dotenv/keychain/1Password source or launch Claude from an environment that actually contains it. Confirm with `miftah doctor` before restarting Claude.

### The dashboard changed the config but Claude still uses the old profile

The dashboard changes durable configuration for future connections. It cannot take over an already-running Claude Desktop STDIO process or silently replace that process's in-memory selection. Restart or reconnect the MCP client.

### OAuth opened in the wrong place—or did not open

First identify the ownership model. Native remote OAuth is started by `miftah auth connect` or the dashboard. Upstream-owned OAuth is started by that MCP server or one of its tools. Do not create a native `oauth.connections` entry for an opaque local token cache.

## Is Miftah right for you?

Miftah is a good fit when account context matters: you work across clients, organizations, environments, or credentials; you want a deliberate boundary before write/destructive actions; or you want one local place to inspect safe, redacted connection activity.

If you use one account with one direct MCP server and do not need profile, routing, policy, or audit controls, a direct MCP entry is simpler. Miftah is not an MCP marketplace and does not add provider functionality that the upstream server does not have.

## Continue by task

- **Set up a client:** [Claude Desktop setup](docs/claude-desktop.md) and [Preset and client compatibility](docs/presets-and-clients.md)
- **Start from a reviewed provider:** [GitHub example](docs/examples/github.md), [Sentry example](docs/examples/sentry.md), or [Google Search Console adapter](docs/provider-adapters.md#google-search-console-pilot)
- **Configure profiles and controls:** [Configuration reference](docs/config.md)
- **Choose an authentication model:** [OAuth support](docs/oauth-support.md)
- **Use the local browser UI:** [Local Console dashboard and control API](docs/console-api.md)
- **Review trust boundaries:** [Security boundary](docs/security.md), [Threat model](docs/threat-model.md), and [OAuth and Console security design](docs/oauth-console-threat-model.md)
- **Use every command:** [CLI reference](docs/cli.md)
- **Embed Miftah as a library or plugin host:** [Public library API](docs/library-api.md) and [Plugin API](docs/plugins.md)
- **Understand internals:** [Architecture](docs/architecture.md)
- **Follow releases or contribute:** [Changelog and release policy](CHANGELOG.md) and [Contributing](CONTRIBUTING.md)

## License

MIT
