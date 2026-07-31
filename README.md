# Miftah

## Use the right account with the MCP servers you already trust

You already have an MCP server for GitHub, Sentry, Google Search Console, or another service. Miftah helps when that same server needs to work across more than one account, client, project, or environment.

Miftah runs locally in front of the upstream MCP server. You configure one Miftah connector for a service, give its accounts names such as `work`, `personal`, or `production`, and select the profile you intend to use.

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

Miftah itself has no cloud service or telemetry. It adds local profile selection, credential references, policy, approvals, redaction, diagnostics, and optional audit metadata around an upstream; it does not replace that upstream or widen what the upstream supports.

> **Status:** Miftah is experimental and pre-1.0. Interfaces and security behavior may change between minor versions. External multi-account and returning-user validation in [#25](https://github.com/mohanagy/miftah/issues/25) and [#88](https://github.com/mohanagy/miftah/issues/88) remains open.

Already using Miftah? See [What is in 0.5 and how to use it](docs/whats-new-in-0.5.md) for the release's guided setup, profile-management, Console, OAuth, and upgrade paths.

## Is Miftah for you?

Use Miftah when:

- the same MCP service needs separate work, personal, client, or environment accounts;
- you want the account choice to be visible and deliberate;
- credentials should stay out of MCP client configuration;
- local policy, approvals, redacted diagnostics, or audit metadata would help.

Keep your direct MCP entry when you use one account and do not need those controls. Miftah is a wrapper, not a universal compatibility layer: the upstream server still owns its provider tools, runtime requirements, and provider-specific behavior.

## One connector, named profiles

Without Miftah, two GitHub accounts often become two almost-identical client entries such as `github-work` and `github-personal`. With Miftah, the client has one `github` connector and the accounts live behind it as named profiles.

| Duplicate client entries | One Miftah connector |
| --- | --- |
| Copy launch settings for every account | Keep launch settings in one reviewed configuration |
| Put account wiring in the client file | Keep profile-scoped credential references outside the client |
| Choose an account by choosing a server entry | List, inspect, and deliberately switch named profiles |

Miftah exposes management tools such as `miftah_list_profiles`, `miftah_current_profile`, and `miftah_use_profile`. Advanced connection-scoped profile locking uses `miftah_lock_profile` and `miftah_unlock_profile` only when explicitly enabled. The upstream's tools keep their original names.

## Quick start

Install Miftah, then choose the terminal wizard or the browser Console. Both use the same validated setup services. The terminal wizard can start from a known connector, remote HTTPS MCP, reviewed local executable, supported browser sign-in, or one existing client entry. The browser Console provides first-run setup for a known connector or a standards-compatible remote MCP with native OAuth.

### 1. Install the current release

```bash
npm install -g @lubab/miftah@0.5.5
miftah version
```

### 2. Choose a human-first setup

**Terminal wizard**

```bash
miftah setup
```

The wizard shows numbered choices, lets you go back before entering connection details, validates before writing, and can print client JSON for manual review.

**Browser Console**

```bash
miftah dashboard
```

Keep the foreground terminal open, enter its one-time code in the local browser page, then choose **Set up an MCP**. `miftah dashboard` is the browser UI; the similarly named `miftah console` command starts the lower-level local control API.

Neither path asks for a token, password, or browser cookie. Miftah does not silently edit Claude Desktop, Claude Code, Cursor, or VS Code settings.

Follow the generated handoff to review one client connector, merge it into your client settings, and restart or reconnect that client.

### Optional: scripted GitHub example

Use `miftah init` when you want a repeatable preset command instead of either human-first flow. This example creates one Claude Desktop connector with `work` and `personal` GitHub profiles. It requires Docker.

```bash
miftah init github --preset github --output ~/.config/miftah/github.json --client claude-desktop
```

Miftah creates `~/.config/miftah/github.json` and prints a Claude Desktop `mcpServers` snippet. It does not edit Claude Desktop and does not ask for or write a token.

The generated profiles refer to `GITHUB_WORK_TOKEN` and `GITHUB_PERSONAL_TOKEN`. Provide least-privilege tokens through a supported [secret provider](docs/config.md#secret-providers), not as raw values in the Miftah or Claude JSON. OS keychain references use `secretref:keychain://`; 1Password references use `secretref:op://`. Claude Desktop is a GUI app and does not normally inherit variables from terminal startup files such as `~/.zshrc`.

#### Validate before connecting the client

After those credential references are available to the process that will launch Miftah, run:

```bash
miftah validate --config ~/.config/miftah/github.json
miftah doctor --config ~/.config/miftah/github.json
miftah test-profile --config ~/.config/miftah/github.json --profile work
```

`validate` checks configuration shape. `doctor` checks redacted credential and upstream readiness. `test-profile` starts and initializes only the selected profile. None proves provider scopes or account identity beyond the evidence it actually reports.

#### Connect and select the account

Merge the printed `mcpServers` entry into Claude Desktop through **Developer → Edit Config**, save, and restart Claude Desktop. Then ask:

```text
List the profiles available through `github`.
Switch `github` to the personal profile.
Confirm the current profile before reading my repositories.
```

The generated GitHub policy requires confirmation for a profile switch. See the complete [GitHub walkthrough](docs/examples/github.md) and [Claude Desktop setup](docs/claude-desktop.md) for credential and client details.

If readiness fails, rerun the exact diagnostic command for this file:

```bash
miftah doctor --config ~/.config/miftah/github.json
```

Then use [Troubleshooting](docs/cli.md#troubleshooting).

## Choose your setup and authentication path

Start from what the upstream MCP server already uses:

| What you have | Start here | Who owns authentication |
| --- | --- | --- |
| API key, token, or another secret | Run `miftah setup`, or use a reviewed preset from [Preset and client compatibility](docs/presets-and-clients.md). Store only a [secret reference](docs/config.md#secret-providers). | The upstream/provider owns the credential; Miftah resolves the configured reference for one profile. |
| Standards-compatible remote HTTPS MCP with OAuth | Use `miftah setup --native-oauth` and [OAuth support](docs/oauth-support.md). | Miftah owns only its supported discovered browser flow, OS-vault credential, refresh, reauth, and local disconnect. |
| Local or provider-specific MCP that opens its own login | Use the upstream or a reviewed adapter such as [Google Search Console](docs/provider-adapters.md#google-search-console-pilot). | The upstream owns browser login, token cache, refresh, reauth, and revocation. Miftah does not scrape that cache. |
| One existing MCP client entry | Run the guided `miftah setup` import path. | Miftah imports only a supported non-secret launch shape; it does not infer OAuth ownership or modify the source client file. |
| Reviewed local executable or exact-pinned package/container | Use `local-stdio`, `generic-npx`, or `generic-docker` from [Setup paths](docs/presets-and-clients.md). | The upstream owns authentication; Miftah launches with literal argument arrays and no shell. |

Native OAuth is intentionally narrow and is not promised for every remote MCP or provider. A successful login, resolvable secret, or profile label is not proof that the credential has the intended scopes or belongs to the intended account. Use a configured identity probe when the upstream offers stable bounded identity evidence.

On Windows, `generic`, `sentry`, and `generic-npx` are unavailable. Miftah refuses them instead of invoking `cmd.exe`. Use a reviewed direct `.exe` or `.com` executable, a direct-executable adapter such as Docker or `uvx.exe`, or a remote MCP. The compatibility matrix records the exact platform limits.

## Wizard, CLI, clients, and optional Console

- `miftah setup` is the guided terminal wizard. It asks what you already have, collects only the metadata needed for that path, validates before writing, and never asks for a token, password, or browser cookie.
- `miftah init` is the optional scripted preset path shown in the quick start.
- `miftah dashboard` opens the optional foreground-only local Console for reviewed setup, profiles, health, and OAuth lifecycle work. It is not required to run Miftah.
- Client generation can print reviewable snippets for Claude Desktop, Claude Code, Cursor, and VS Code. Miftah never silently edits their settings.

See [Setup paths](docs/presets-and-clients.md) for exact presets, client destinations, generated JSON shapes, upstream requirements, and platform support. See the [Console guide](docs/console-api.md) for its local authenticated control boundary.

## Safety boundaries

- Keep raw secrets, OAuth credentials, provider caches, dotenv files, active-profile state, audit journals, and generated machine-local client JSON out of shared configuration. Reviewed profile names, policy, routing, upstream metadata, and secret references may be shared only when no plaintext secret is present.
- Local policy can allow, deny, or require confirmation, but it cannot reduce permissions already granted to a provider credential.
- Identity verification is optional and upstream-specific. Credential readiness, token health, and verified account identity are different claims.
- Audit records are redacted local metadata. Optional hash chaining provides local tamper evidence, not a remotely anchored immutable trail.
- Remote OAuth, local/provider-owned OAuth, and static secret references have different owners and lifecycle behavior; choose the matching setup path above.

Read the [Security boundary](docs/security.md) and [threat model](docs/threat-model.md) before deploying Miftah in a sensitive environment.

## Go deeper

- [Setup paths](docs/presets-and-clients.md) — presets, supported clients, pins, platform limits, and generated snippets
- [Configuration reference](docs/config.md) — profiles, secrets, routing, policy, identity, and audit configuration
- [OAuth guide](docs/oauth-support.md) — native remote OAuth and upstream-owned OAuth
- [CLI reference](docs/cli.md) — commands, diagnostics, exit codes, logs, and [Troubleshooting](docs/cli.md#troubleshooting)
- [Console guide](docs/console-api.md) — optional local dashboard and API
- [Security boundary](docs/security.md), [Threat model](docs/threat-model.md), [OAuth and Console security design](docs/oauth-console-threat-model.md), and [Architecture](docs/architecture.md)
- [profile credential isolation](docs/config.md#profile-credential-isolation), [routing context](docs/config.md#routing-context), and [provider routing matchers](docs/config.md#provider-routing-matchers)
- [Provider adapters](docs/provider-adapters.md), [plugins](docs/plugins.md), and [library API](docs/library-api.md)

For bugs and feature requests, open an [issue](https://github.com/mohanagy/miftah/issues). Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
