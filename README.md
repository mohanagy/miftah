# Miftah

## One MCP connector. Deliberate account selection.

You already have an MCP for GitHub, Sentry, PostHog, or another service. The hard part starts when you use that same MCP service across more than one account, client, project, or environment.

Miftah is a local MCP profile manager and safety layer. It wraps the upstream server you already use, gives it named profiles such as `personal`, `work`, `client-a`, or `production`, and keeps account selection intentional.

Miftah runs locally by default. Miftah itself has no cloud service or telemetry; it connects only to the upstreams you configure.

> **Status:** Miftah is experimental and pre-1.0. Interfaces and security behavior may change between minor versions. See the [release policy](CHANGELOG.md#release-policy) and use the [private disclosure process](SECURITY.md) for vulnerabilities.

## Why Miftah exists

Without Miftah, a multi-account setup usually becomes a growing list of client entries: `github-personal`, `github-work`, `sentry-client-a`, `sentry-client-b`, and so on. That works at first, but it makes the connection configuration—not the account context—the thing you have to manage.

| Instead of this | Miftah gives you this |
| --- | --- |
| One client entry for every account | One Miftah connector per service, with named profiles for each account or environment |
| Repeated launch settings and credential wiring | Profile-scoped credential references that stay outside client configuration |
| Manual connector selection with little context | Explicit profile switching and optional routing rules for stable, known context |
| No consistent local record of what happened | Optional, redacted local audit metadata and health/diagnostic tools |

Do not create one client entry for every account. Add one Miftah connector per service, then manage the accounts behind it as profiles.

## What Miftah does today

### Keeps account context explicit

Profiles represent real working contexts—not just different tokens. You can switch deliberately, keep a safe configured default, or add routing rules for stable signals such as a repository, organization, or project. If routing is ambiguous, Miftah does not guess.

### Adds a control layer around existing MCPs

Miftah wraps an existing upstream MCP server. It does not replace it. Your GitHub, Sentry, PostHog, or other provider MCP continues to provide its tools and provider behavior; Miftah handles the local profile, credential, routing, policy, approval, lifecycle, and redaction boundaries around it.

### Keeps secrets out of client configuration

Profiles refer to credentials from environment variables, dotenv files, OS keychains, 1Password, or an explicitly trusted local provider. Secret values do not belong in your MCP client JSON, and Miftah redacts them from its diagnostics and audit output.

### Makes sensitive work more deliberate

Optional policies, explicit destructive-profile selection, confirmation flows, identity checks, and local audit records help keep a helpful agent from using a plausible-but-wrong account or silently proceeding with sensitive work.

## Get running with Claude Desktop

Install Miftah:

```bash
npm install -g @lubab/miftah
```

Generate a GitHub configuration and a Claude Desktop snippet:

```bash
miftah init github --preset github --output ~/.config/miftah/github.json --client claude-desktop
```

The GitHub preset requires Docker and generates `GITHUB_WORK_TOKEN` and `GITHUB_PERSONAL_TOKEN` credential references. Set those references in the environment that launches Claude Desktop, then validate the configuration:

```bash
miftah validate --config ~/.config/miftah/github.json
```

`miftah validate` checks the configuration; it does not start the upstream server or prove that a credential works. For a redacted readiness check after you have set the references, run:

```bash
miftah doctor --config ~/.config/miftah/github.json
```

Claude Desktop is a GUI app and does not inherit terminal startup files such as `~/.zshrc`; use a supported secret provider or a GUI-visible launcher environment instead of relying on shell exports alone.

`init --client` prints JSON with absolute launcher paths for you to copy into your client configuration. It deliberately does not modify the client file.

Continue with the step-by-step [Claude Desktop setup](docs/claude-desktop.md), or start from the [GitHub example](docs/examples/github.md) or [Sentry example](docs/examples/sentry.md).

Prefer a browser for OAuth setup? Run:

```bash
miftah dashboard
```

The optional local Console opens on `127.0.0.1`, creates a validated first native-OAuth profile without hand-written JSON, shows redacted connection/audit state, and generates client JSON for you to review and copy. It stays in the foreground, never edits Claude or another client configuration, and does not accept provider passwords, browser cookies, or raw tokens. Use `--config <file>` to manage another Miftah configuration or `--no-open` when you only want the local URL.

## A real multi-account setup

Imagine you use Sentry for two products. Instead of adding two separate Sentry servers to Claude Desktop, configure one `miftah-sentry` connector with two profiles:

```text
miftah-sentry
├── product-a
└── product-b
```

When you need the other product, select its profile deliberately. When a tool call needs it, Miftah starts or reuses the corresponding upstream context with that profile's credentials, while the client keeps one Sentry connector. The same pattern works for personal/work GitHub accounts, client environments, and staging/production services.

## What it works with

- **GitHub and Sentry:** strict built-in presets and generated client snippets.
- **Other compatible MCP servers:** configure a generic STDIO, Streamable HTTP, or legacy SSE upstream, then add profiles around it.
- **Multiple upstreams in one wrapper:** use an account bundle when related upstreams belong behind one controlled connection.

Miftah can authorize a standards-compatible remote HTTPS Streamable HTTP MCP server through discovery, PKCE, a bounded loopback browser callback, OS-vault storage, and refresh. `miftah connection …` and `miftah auth …` provide reviewed setup, status, noninteractive testing, connect, safe reauth, and local disconnect. Provider-specific or local STDIO OAuth remains owned by that upstream, and local disconnect does not claim provider-side token revocation. A bounded [Google Search Console provider-adapter pilot](docs/provider-adapters.md#google-search-console-pilot) now generates an exact-pinned upstream-owned setup without reading its token cache or pretending it is native Miftah OAuth. Read [OAuth support](docs/oauth-support.md) for the exact compatibility and configuration boundary.

## Trust and control boundaries

Miftah supports environment and dotenv references, plus OS keychain references such as `secretref:keychain://<service>/<account>` and 1Password references such as `secretref:op://<vault>/<item>/<field>`. The reference is configuration; the secret value stays outside the MCP client configuration.

For credential-file workflows, see [profile credential isolation](docs/config.md#profile-credential-isolation). Where provider/account signals are stable, opt-in [provider routing matchers](docs/config.md#provider-routing-matchers) and [routing context](docs/config.md#routing-context) can inform profile selection; ambiguous context never selects an account by guesswork.

When an operator enables profile locking, `miftah_lock_profile` and `miftah_unlock_profile` expose that control to the MCP client. For the complete security scope and future work, read the linked designs below.

The optional local Console is started explicitly with `miftah dashboard`; `miftah console --config <file>` remains the API-only form. It binds only to loopback, uses a one-time terminal bootstrap plus browser session/CSRF protection, and exposes redacted metadata and audited connection operations under `/api/v1`. It is not a daemon and cannot change an already-running MCP client's in-memory session. See the [Console contract](docs/console-api.md).

## Is Miftah right for you?

Miftah is a good fit when account context matters: you work across clients, organizations, environments, or credentials; you want a deliberate boundary before write/destructive actions; or you want one local place to inspect safe, redacted connection activity.

If you use one account with one direct MCP server and do not need profile, routing, policy, or audit controls, a direct MCP entry is simpler. Miftah is not an MCP marketplace and does not add provider functionality that the upstream server does not have.

## Learn more

- [Claude Desktop setup](docs/claude-desktop.md)
- [Preset and client compatibility](docs/presets-and-clients.md)
- [GitHub example](docs/examples/github.md) and [Sentry example](docs/examples/sentry.md)
- [Configuration reference](docs/config.md)
- [Security boundary](docs/security.md), [Threat model](docs/threat-model.md), and [OAuth and Console security design](docs/oauth-console-threat-model.md)
- [OAuth support](docs/oauth-support.md)
- [Provider adapters and Google Search Console pilot](docs/provider-adapters.md)
- [Local Console dashboard and control API](docs/console-api.md)
- [CLI reference](docs/cli.md)
- [Architecture](docs/architecture.md)
- [Changelog and release policy](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)

## License

MIT
