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

## What Miftah controls—and what it does not

Miftah is deliberately explicit about the local boundary it owns. A successful setup, OAuth login, or profile label is not more proof than it actually is.

| Boundary | What Miftah does | What it does not prove or own |
| --- | --- | --- |
| Credential readiness | Resolves configured secret references for the requested profile and reports redacted readiness diagnostics. | A resolvable reference alone does not prove provider token validity, granted scopes, or account access. |
| Verified account identity | Can run an optional, configured bounded identity probe with `miftah_verify_identity`. | A profile name, successful OAuth flow, or valid credential is not proof of the intended provider account unless that probe is configured and succeeds. |
| Native remote OAuth | For one supported HTTPS Streamable HTTP endpoint, Miftah can discover standards-based OAuth, open consent, refresh its own OS-vault credential, reauthorize, and disconnect its local binding. | It does not support every remote MCP or promise provider-side token revocation. |
| Provider-owned OAuth | Keeps the chosen profile, policy, and local boundaries separate while passing only configured references to the upstream. | The provider owns its login, token cache, refresh, expiry, reauthentication, and revocation. Miftah never scrapes that cache. |
| Tool policy and approvals | Classifies operations as read, write, or destructive and can allow, deny, or require confirmation. | A local policy cannot reduce the permissions already granted by a provider token. |
| Redacted local audit | Records redacted local lifecycle and operation metadata; optional hash chaining provides local tamper evidence. | It is not a remotely anchored immutable audit trail or a replacement for compliance retention. |
| Client handoff and profiles | One generated Miftah client entry serves every named profile in that configuration. | Miftah does not edit client settings or silently switch an already-running client session. |

### Share a configuration safely

Miftah configuration is not a token bundle. You may version a reviewed template only when it contains no plaintext secret. This fragment is safe to review because it contains a variable reference, not a token value:

```json
{
  "profiles": {
    "production": {
      "env": {
        "SERVICE_TOKEN": "${SERVICE_PRODUCTION_TOKEN}"
      },
      "policy": "readonly"
    }
  }
}
```

| Safe to share after review | Keep local and never commit or copy as team configuration |
| --- | --- |
| Non-secret profile names and labels, policies, routing rules, reviewed upstream metadata, and secret **references** such as `${SERVICE_PRODUCTION_TOKEN}`. | Raw secret values and dotenv files; keychain or 1Password items; OAuth vault credentials; OAuth client-secret files; provider token-cache directories such as `GSC_CONFIG_DIR`; active-profile state; audit journals; and generated client JSON with machine-local paths. |

Each user or deployment supplies its own secret values and local provider state, then runs `miftah validate` and `miftah doctor` before reconnecting the MCP client.

## Choose your setup path

Start with the row that describes how your upstream MCP authenticates.

| Your upstream MCP | Use this Miftah path |
| --- | --- |
| GitHub or Sentry | Run guided setup with `miftah setup`, or generate a strict built-in preset with `miftah init`. |
| Another exact-pinned npm or container STDIO server | Use `generic-npx` or `generic-docker`, then add profiles around it. |
| A local executable and argument array you personally reviewed | Use `local-stdio`; it saves literal command and argument-array metadata without a shell. |
| Remote HTTPS Streamable HTTP with a token or API key | In guided setup, choose `remote`; Miftah creates the strict `streamable-http` configuration with an optional secret-backed header. |
| Remote HTTPS Streamable HTTP with standards-compatible OAuth | In bare guided setup, choose `browser sign-in`; for scripts, use `miftah setup --native-oauth`. Miftah discovers supported OAuth from the endpoint; use manual `connection add` only when a provider gives you registration details. |
| Local or provider-specific MCP that opens its own OAuth flow | Use Upstream-owned OAuth. Miftah wraps the process but does not take over its token cache. |
| Google Search Console | Use the reviewed `google-search-console` adapter preset. OAuth remains upstream-owned. |
| One account and no need for profile, policy, routing, or audit controls | Keep the direct MCP entry; Miftah may not add value for this case. |

Miftah requires Node.js 20 or newer. Each upstream keeps its own runtime and installation requirements; for example, the GitHub preset requires Docker and the Google Search Console adapter requires Python 3.11 or newer plus `uvx`.

On Windows, `generic`, `sentry`, and `generic-npx` are unavailable. npm's `npx` runner itself requires a command shell on Windows; Miftah refuses them instead of invoking `cmd.exe`. Use a direct `.exe` or `.com` local executable, a direct-executable adapter such as `uvx.exe` or `docker.exe`, or a remote MCP instead.

Shell examples below use POSIX syntax, including `~`, `$HOME`, and `\` line continuations. On Windows, run the same Miftah options from PowerShell with Windows paths and PowerShell line continuation, or put the command on one line.

### Prefer guided setup?

```bash
miftah setup
```

On a bare interactive `miftah setup`, Miftah starts with `What do you already have? (connector, remote HTTPS, local executable, browser sign-in, import) [connector]`; choose `connector`, `remote`, `local`, `browser sign-in`, or `import` based on what you already have. At that prompt, enter `remote` for a remote HTTPS endpoint, `local` for a reviewed executable and argument array, or `connector` for a known connector or pinned package. It then collects only the safe metadata that path needs and an output location, and can print an optional client JSON snippet for manual review. Choose `browser sign-in` when the remote MCP opens a browser to authenticate you. Miftah asks for the configuration name, account profile, and exact HTTPS endpoint, then discovers whether it can safely own a supported standards-based OAuth flow. It writes nothing if the endpoint does not prove one supported authorization server with dynamic registration. Keep `miftah setup --native-oauth` for scripted or repeatable setup. The generic `remote` path does not discover authentication or call the endpoint; use it for no-auth or documented API-key/header setup. Choose `import` when you already have one MCP entry in a client JSON file: Miftah asks for that explicit absolute file, lists only entry names, and asks you to select one. It never prints the source entry's command, arguments, headers, environment values, or credentials, and it does not scan or modify the source client file. It never asks for a token, password, or browser cookie. For `local`, it collects one literal argument at a time, shows a no-secret review summary, and requires an explicit acknowledgement. Miftah does not run the local executable during setup. Miftah validates the complete configuration before it writes an owner-restricted file, never overwrites an existing one, and never edits a Claude, Cursor, VS Code, or other MCP client file. Recognized adapters can then offer one explicit, provider-declared read-only readiness check; Miftah never guesses a tool or auto-approves a policy prompt. Use `miftah init` when you want the same catalog in a scripted command.

If a selected client entry cannot be safely imported, Miftah writes no configuration from it. Miftah does not retain rejected arguments, headers, environment values, or credentials. The guided CLI keeps the non-secret configuration name and output location, then takes you to manual transport setup: re-enter a reviewed local executable with literal arguments, or a canonical HTTPS endpoint. In the Console, choose **Set up local executable manually** or **Set up remote HTTPS MCP manually**; it clears the pasted client JSON before opening the existing form. Configure authentication separately through the upstream's documented flow and Miftah secret references.

When setup finishes, Miftah tells you whether it ran a reviewed check, skipped one, or had no declared safe check at all. Browser sign-in setup can finish with browser authorization still outstanding. It saves a discovered connection plan, not a credential; use the later connect action to start the provider's browser flow. A completed configuration is not the same as a working client. You still review and merge any client JSON yourself, then restart or reconnect the client.

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
| `local-stdio` | A reviewed local executable with one literal argument per array element |
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

Replace the example package, version, and variable name with the upstream's documented values. An exact version is required. This package-runner preset is available on macOS and Linux, not Windows: npm's `npx` runner uses a command shell there, and Miftah refuses it rather than invoking `cmd.exe`. On Windows, use a reviewed direct `.exe` or `.com` executable, a direct-executable adapter, or a remote MCP. Run `validate`, `doctor`, `test-profile`, and `list-tools` before adding the printed client JSON.

### Reviewed local executable template

Use this when the upstream documentation gives you a direct local STDIO executable rather than an exact npm package or digest-pinned container. Each argument is supplied separately—never as one shell command string:

```bash
miftah init local-tools \
  --preset local-stdio \
  --local-command node \
  --arg server.mjs \
  --arg=--stdio \
  --cwd "$HOME/development/local-tools" \
  --credential-env SERVICE_API_KEY \
  --accept-local-command \
  --output ~/.config/miftah/local-tools.json \
  --client claude-desktop
```

On macOS and Linux, `--local-command` accepts a bare executable such as `node` or a native absolute executable path. On Windows, provide an absolute `.exe` or `.com` binary—not a bare command or a `.cmd`/`.bat` shim—so direct argument-array execution never falls back to `cmd.exe`. Every `--arg` becomes one literal argv element; use `--arg=--flag` when an argument itself begins with `--`. Miftah never invokes a shell or expands `$`, `${...}`, or `~` in these values. Keep credentials out of the command and arguments: use `--credential-env` to write only a `${ENV_NAME}` reference into the profile.

`--accept-local-command` is your acknowledgement that you reviewed the executable and every argument. The generated profile starts with a read-only policy and treats unknown upstream tools as destructive until you add an intentional policy. `init` and `setup` save the configuration only; they do not launch or probe a generic local executable. After you review the generated config, run the diagnostics you choose before adding its printed client JSON.

For one reviewed local executable, use `local-stdio` for arguments and a working directory. For several named upstreams, profile-specific overrides, or other advanced topology, use the [Configuration reference](docs/config.md). Always keep subprocess arguments as arrays; Miftah does not need a shell command string.

## Reuse one existing MCP client entry

If you already have a local or remote Claude Desktop, Claude Code, Cursor, or VS Code MCP entry, start with:

```bash
miftah setup
```

At `What do you already have? (connector, remote HTTPS, local executable, browser sign-in, import) [connector]`, choose `import`. Give the exact absolute client configuration file, then choose one listed entry by number or exact name. This is the simplest first-use path: Miftah lists only entry names and never prints the source entry's command, arguments, headers, environment values, or credentials. It does not scan or modify the source client file.

For scripts or a repeatable handoff, use the explicit equivalent:

```bash
miftah setup posthog-work \
  --import-file "$HOME/Library/Application Support/Claude/claude_desktop_config.json" \
  --import-entry posthog \
  --output ~/.config/miftah/posthog-work.json \
  --client claude-desktop
```

`--import-file` must be an absolute regular JSON file, and `--import-entry` is the exact entry name under `mcpServers` (Claude Desktop, Claude Code, or Cursor) or `servers` (VS Code). Miftah reads that one file through a bounded verified handle and leaves it byte-for-byte untouched. It accepts one of two strict shapes:

- a finite **static launch grammar** for local stdio: a literal local executable, an optional absolute working directory, and either an exact-version package-runner launch with a runner-specific safe prefix and no arguments after the package, a script path plus non-sensitive flags, or a direct executable plus non-sensitive flags; or
- a credential-free HTTPS remote entry: a `url` under `mcpServers` or VS Code `servers`, explicitly marked `type: "http"` or `"streamable-http"`. The URL cannot contain userinfo, a query, a fragment, or an opaque credential-shaped path segment.

On Windows, the import path accepts only a direct absolute `.exe` or `.com` executable. Bare runners such as `npx` or `node`, and `.cmd`/`.bat` shims, are rejected rather than being dispatched through a command processor.

The importer rejects `env`, headers, shell settings, unsupported fields, environment wrappers, inline code, opaque values or assignments, unsupported remote transports, URL userinfo, opaque credential-shaped URL path segments, unpinned package references, and credential-shaped arguments. It creates one `default` profile with a read-only policy and treats unknown tools as destructive until you deliberately configure a policy. It does not launch the imported executable or copy credentials. For a credential-free HTTPS remote entry, it does not discover OAuth or call the remote endpoint. `--verify` is rejected because an imported entry has no reviewed provider adapter. It does not infer OAuth ownership from a command or URL. If the entry needs custom values, OAuth, an API key, headers, or an opaque endpoint token, use advanced manual setup, then configure the upstream's documented flow and Miftah secret references separately.

For a browser-first first run, `miftah dashboard` offers the same paste-only local and credential-free remote import path. The Console parses the pasted JSON only for that local request, does not persist or return it, and clears it from the page afterwards.

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

Without `--config`, `miftah dashboard` finds safe direct Miftah JSON configurations in `~/.config/miftah` and asks you to choose one. It does not scan Claude Desktop settings, running processes, or arbitrary folders. For true first-run onboarding, it uses `~/.config/miftah/miftah.json` by default and can create a known-preset configuration, a Native remote OAuth profile, or one explicitly pasted local stdio or credential-free HTTPS remote entry there; it never overwrites an existing file. Native OAuth first-run asks only for a configuration name, account profile, and exact remote HTTPS endpoint; it discovers the OAuth details before creating anything. Pass `--config ~/.config/miftah/github.json` when you want to open exactly one configuration and skip the selector.

The optional dashboard:

1. starts a foreground-only service on literal `127.0.0.1`;
2. opens the system browser and asks for the one-time bootstrap code printed in the terminal;
3. creates a first validated known-preset configuration, Native remote OAuth profile and connection, or explicitly pasted local stdio or credential-free HTTPS remote entry when the selected config path does not exist; choose **Remote MCP with browser sign-in** for the native flow, whose discovery completes before the configuration is written;
4. offers a separate **Connect** action that starts the reviewed system-browser authorization;
5. shows redacted connection and audit state; and
6. generates client JSON for you to review and copy.

Keep the terminal process running while using the dashboard. Closing it stops the local listener. There is no daemon, hosted account, LAN mode, or automatic client-file edit. After a durable configuration or connection change, copy any regenerated client JSON and restart or reconnect the MCP client.

Use another config path or suppress automatic browser launch with:

```bash
miftah dashboard --config ~/.config/miftah/remote-service.json
miftah dashboard --config ~/.config/miftah/remote-service.json --no-open
```

### Endpoint-first OAuth setup

For a standards-based remote MCP, start with its exact HTTPS MCP endpoint. You do not need to know its OAuth issuer, registration mode, scopes, or token storage details:

```bash
miftah setup --native-oauth \
  --name remote-service \
  --profile work \
  --url https://mcp.example.com/mcp \
  --output ~/.config/miftah/remote-service.json \
  --client claude-desktop
```

Miftah discovers the issuer, supported OAuth metadata, and dynamic client-registration capability from the endpoint itself. It requires exactly one safe authorization server and dynamic registration support. If either condition is missing, it stops before writing the configuration and tells you to use the provider's upstream-owned or advanced manual path instead.

The command prints the scopes advertised by the server so you can review them before Miftah saves the configuration. No browser authorization, client registration, or credential is created during setup. Authorization begins only when you explicitly connect the named account:

```bash
miftah auth connect --config ~/.config/miftah/remote-service.json \
  --profile work \
  --upstream default

miftah connection test --config ~/.config/miftah/remote-service.json \
  --profile work \
  --upstream default

miftah connection list --config ~/.config/miftah/remote-service.json --client claude-desktop
```

### Add another native OAuth account

After the first account is configured, add each additional account as its own named profile. You give Miftah the existing configuration, the new profile name, and the upstream already in that trusted configuration; it never asks you to re-enter an endpoint, issuer, client secret, token, or browser cookie.

```bash
miftah setup --native-oauth \
  --config ~/.config/miftah/remote-service.json \
  --profile personal \
  --description "Personal analytics account" \
  --upstream default \
  --make-default
```

Miftah preserves each existing account and its OAuth binding. It discovers OAuth from the selected configured upstream, then atomically adds the new profile and its separate binding. `--make-default` changes the durable default for future MCP connections; omit it to keep the current default. As with first setup, no browser authorization, client registration, or credential is created until you choose to connect the new profile:

```bash
miftah auth connect --config ~/.config/miftah/remote-service.json \
  --profile personal \
  --upstream default
```

The dashboard offers the same path through **Add another native OAuth account**. Existing MCP clients keep their active profile until they restart or reconnect.

The dashboard also offers the existing-profile flow: create a configuration from the endpoint on first run, or choose an existing profile and HTTPS upstream, then select **Discover OAuth from configured upstream**. It never accepts a token, OAuth code, client secret, or browser cookie in the form. The provider consent screen opens only after you select **Connect**.

### Advanced manual OAuth registration

Use this only if the provider has pre-registered a client for you, requires client metadata, or does not advertise dynamic registration. The endpoint-first path intentionally does not guess those provider-specific values. The equivalent manual CLI path is plan-first:

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

# Review the generated oauthconn: UUID, then replace UUID_FROM_PLAN below:
miftah connection add --config ~/.config/miftah/remote-service.json \
  --profile default \
  --upstream default \
  --issuer https://auth.example.com \
  --client-registration dynamic \
  --scope mcp:read \
  --connection oauthconn:UUID_FROM_PLAN \
  --write

miftah auth connect --config ~/.config/miftah/remote-service.json --connection oauthconn:UUID_FROM_PLAN
miftah connection test --config ~/.config/miftah/remote-service.json --connection oauthconn:UUID_FROM_PLAN
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

It runs the exact-pinned upstream through `uvx`, applies Miftah's read-only policy, and passes the configured client-secrets path to that upstream. The upstream owns the first-use browser flow and token cache. Miftah never reads, copies, exports, or deletes that cache.

To configure one or more named Google accounts behind one connector, use the guided path instead:

```bash
miftah setup gsc --preset google-search-console
```

If you want the reviewed first-success check immediately after the configuration is written, use:

```bash
miftah setup gsc --preset google-search-console --verify
```

The wizard asks for one or more named Google accounts, an optional description and client-secrets path for each, then the default profile. Each generated profile gets a different `GSC_CONFIG_DIR`, and Miftah namespaces that directory by the generated configuration file as well as the profile. The exact-pinned upstream therefore keeps its token cache separate even when two configuration files use the same Miftah name. `--verify` replaces the final yes/no prompt and runs the adapter's declared `get_capabilities` check once for every named profile. Miftah does not invent a probe or show the provider output; it reports only the bounded readiness status. A non-ready readiness result leaves the configuration in place and exits 1. If the final readiness prompt is cancelled after the write, the configuration remains available and setup exits 1. The automatic check intentionally applies only while the reviewed GSC launch shape is unchanged; custom commands, process `PATH`, working directories, isolation, or unknown provider environment settings remain supported for manual use but are not auto-probed. Because Google login is upstream-owned, the provider may still open its own browser flow when it has no session. Complete the upstream browser flow separately for every account, then run `miftah validate` and `miftah doctor` against the generated configuration. Separate caches do not verify Google-account identity or property access; confirm those in the upstream before relying on a profile. See the [Google Search Console provider-adapter pilot](docs/provider-adapters.md#google-search-console-pilot).

### Add another Google Search Console account

You do not need to rerun the initial wizard or hand-edit JSON when a second, third, or later Google account is needed. Give the trusted existing configuration, a new profile name, and the absolute path to that account's Google OAuth desktop client-secrets file:

```bash
miftah setup --add-profile \
  --config ~/.config/miftah/gsc.json \
  --profile google-personal \
  --description "Personal Google account" \
  --oauth-client-secrets-file "$HOME/.config/gsc/personal-client-secrets.json" \
  --make-default \
  --verify
```

This works only for an unchanged reviewed provider-adapter configuration whose existing accounts already have literal, distinct provider state directories. The new account receives its own `GSC_CONFIG_DIR`, while Miftah stores only the client-secrets file reference and never reads, copies, exports, or removes the upstream token cache. `--make-default` changes the durable default for future MCP connections; it does not switch an already-running client. `--verify` runs the one declared read-only check for the new account only. If it is not ready, the account remains configured and the command exits `1` with a bounded status.

The local dashboard offers the same returning-user flow: run `miftah dashboard --config ~/.config/miftah/gsc.json`, then choose **Add another provider account**. The form appears only when the selected configuration meets the reviewed provider-adapter boundary. It asks for a new profile, optional description, and credential-file path; it never shows an existing path or provider cache, and it does not replace native OAuth controls for other kinds of MCP.

### Add another local environment-backed account

Some local STDIO MCPs use one environment variable for their credential rather than provider-owned OAuth. When the existing configuration has exactly that simple shape, add a second, third, or later account without hand-editing JSON:

```bash
miftah setup --add-profile \
  --config ~/.config/miftah/sentry.json \
  --profile personal \
  --description "Personal Sentry account" \
  --credential-env SENTRY_PERSONAL_ACCESS_TOKEN \
  --make-default
```

`--credential-env` is the **name** of an environment variable, never its value. Miftah stores a reference such as `${SENTRY_PERSONAL_ACCESS_TOKEN}`, never reads the credential, and does not start the upstream. This deliberately applies only to one local `stdio` upstream with one direct credential binding per profile, the same destination and policy for every existing account, no provider adapter, and no native OAuth or named upstreams. Each account must use a different source environment variable. Remote HTTP MCPs are refused because profile environments do not authenticate HTTP requests.

There is no generic `--verify` here: Miftah does not guess a safe command for an arbitrary upstream. Set the new environment variable in the application environment that launches Miftah, restart or reconnect the MCP client, then use the service's normal safe validation path. The local dashboard offers the same flow under **Add another environment-backed account** when the selected configuration meets this exact boundary.

### Retest a reviewed provider account

For an existing reviewed provider-adapter account, run its declared safe check again without recreating the account or opening OAuth:

```bash
miftah profile test --config ~/.config/miftah/gsc.json --profile google-personal
```

When a configuration has more than one upstream, add `--upstream <name>`. Miftah runs only the adapter's declared read-only probe for that exact profile and returns a redacted status report. It does not run an arbitrary tool or expose provider output. It does not change configuration, read a provider token cache, or open a browser; a non-ready report exits `1` so automation can detect it.

### Review configured accounts

Before choosing a default or asking a connected client to switch accounts, list the account profiles Miftah has for this configuration:

```bash
miftah profile list --config ~/.config/miftah/gsc.json
```

The output includes the durable default and each profile's name, optional description, tags, policy name, and overridden upstream names. It never resolves a secret reference, reads a credential file, header, OAuth vault entry, or provider token cache, and it never starts an upstream. In the browser, the same safe information appears under **Configured accounts** after `miftah dashboard --config ~/.config/miftah/gsc.json`.

### Change the durable default later

Once two or more profiles already exist, you can choose which one new Miftah sessions start with without adding an account or editing JSON:

```bash
miftah profile set-default --config ~/.config/miftah/gsc.json --profile google-personal
```

The profile must already exist. Miftah changes only `defaultProfile`, validates the resulting configuration, and uses a guarded replacement with a recovery backup; when auditing is configured, it also finalizes that fail-closed audit record. It does not start an upstream, open OAuth, read a credential file, or alter a provider token cache. It does not switch an already-running MCP client; restart or reconnect that client for the new durable default to take effect.

In the browser, run `miftah dashboard --config ~/.config/miftah/gsc.json` and choose **Choose the default account**. When using the dashboard's configuration catalog, select the configuration again after the write before making another Console change; that protects against using stale configuration bytes.

### Edit an account label later

Profile descriptions are non-secret labels for recognizing an account. Set one without hand-editing JSON:

```bash
miftah profile set-description --config ~/.config/miftah/gsc.json --profile google-personal --description "Personal Google account"
```

To remove a label, make that intent explicit:

```bash
miftah profile set-description --config ~/.config/miftah/gsc.json --profile google-personal --clear-description
```

Use exactly one of `--description` or `--clear-description`. Miftah changes only that profile's non-secret `description`, validates the complete candidate, and uses the same guarded replacement, recovery backup, and fail-closed audit lifecycle as the durable-default change. Its result does not echo the submitted label or configuration data. It does not change credentials, OAuth bindings, routing, provider token caches, or the durable default, and it never starts an upstream or opens a browser.

In the browser, run `miftah dashboard --config ~/.config/miftah/gsc.json` and choose **Edit a non-secret account label**. In catalog mode, select the configuration again after a successful write before making another Console change.

### Rename an account later

Rename a profile without hand-editing every configuration reference:

```bash
miftah profile rename --config ~/.config/miftah/gsc.json --profile google-personal --new-profile google-studio
```

The selected profile must already exist and the new name must be distinct and safe. Miftah atomically renames the profile and every configuration-owned reference to it: the durable default, routing rules, routing-plugin bindings, configured profile lock, and any native OAuth connection binding. It validates the complete candidate, keeps a recovery backup, and finalizes the configured fail-closed audit lifecycle.

For a native OAuth connection, Miftah moves the credential only between its two exact OS-vault keys and migrates its non-secret connection metadata in the same recoverable local transaction. It never exposes the credential or copies it to configuration, logs, provider caches, profile state, or identity records. Existing MCP clients keep their current session; restart the client to use the new profile name.

If a local interruption leaves that native OAuth rename unfinished, retry the same rename from the CLI or Console surface that started it. Miftah completes the recovery journal only after its required audit finalization succeeds, then asks you to reload the configuration. Do not edit the configuration, vault, metadata, or provider cache to recover it.

In the browser, run `miftah dashboard --config ~/.config/miftah/gsc.json` and choose **Rename an account profile**. In catalog mode, select the configuration again after the write before making another Console change.

### Remove an account later

When an account should no longer be part of this Miftah configuration, remove it through the same guarded lifecycle instead of hand-editing JSON:

```bash
miftah profile remove --config ~/.config/miftah/gsc.json --profile google-personal --replacement-profile google-work
```

The selected profile must already exist and at least one other profile must remain. `--replacement-profile` is required whenever the removed account is the durable default or is named by a routing rule, routing-plugin binding, or configured profile lock. Miftah moves only those durable configuration references to the chosen existing account, validates the complete candidate, keeps a recovery backup, and finalizes the configured fail-closed audit record.

It changes Miftah configuration only: it does not resolve or delete an underlying secret, read or delete a provider token cache, or change an active MCP client session. Restart or reconnect the client after a successful removal.

Miftah refuses to remove a profile with a configured native OAuth binding. There is intentionally no hand-edit workaround: removing the configuration binding and OS-vault credential needs one atomic lifecycle, which this generic account-removal flow does not yet own.

In the browser, run `miftah dashboard --config ~/.config/miftah/gsc.json` and choose **Remove an account safely**. Select the account, a replacement, and the explicit confirmation. In catalog mode, select the configuration again after the write before making another Console change.

## Everyday commands

These are shell commands. Profile switching and identity tools such as `miftah_use_profile` are MCP management tools used from the connected client.

| Task | Command |
| --- | --- |
| Validate JSON only | `miftah validate --config service.json` |
| Check secrets, executable, upstream startup, discovery, and shutdown | `miftah doctor --config service.json` |
| Start one profile and verify initialization | `miftah test-profile --config service.json --profile work` |
| Review configured account profiles without starting an upstream | `miftah profile list --config service.json` |
| Set or clear a non-secret account label | `miftah profile set-description --config service.json --profile personal --description "Personal account"` |
| Rename an account and its durable configuration references | `miftah profile rename --config service.json --profile personal --new-profile studio` |
| Remove one account with explicit durable-reference replacement | `miftah profile remove --config service.json --profile personal --replacement-profile work` |
| Run the reviewed safe check for one provider-backed account | `miftah profile test --config service.json --profile work` |
| Discover one profile's upstream tools | `miftah list-tools --config service.json --profile work` |
| Read redacted audit events | `miftah logs --config service.json` |
| Follow redacted audit events | `miftah logs --config service.json --follow` |
| Create a redacted support snapshot | `miftah audit-export --config service.json --output support-audit.jsonl` |
| Verify configured hash-chain integrity | `miftah audit-verify --config service.json` |
| Print the JSON Schema | `miftah schema` |
| Review a supported config migration | `miftah migrate-config --config service.json` |
| Apply the reviewed migration | `miftah migrate-config --config service.json --write` |
| Set the durable default for future sessions | `miftah profile set-default --config service.json --profile personal` |

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

Claude Desktop does not inherit your interactive shell startup files. Move the reference to a configured dotenv/keychain/1Password source or launch Claude from an environment that actually contains it. Confirm with `miftah doctor --config ~/.config/miftah/github.json` before restarting Claude.

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
