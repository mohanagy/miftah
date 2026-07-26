# CLI reference

`miftah` is an MCP wrapper with STDIO as its default transport, an opt-in local Streamable HTTP server, and a separately launched local Console dashboard/control API. Run `miftah --help` for the generated command list, or `miftah <command> --help` for the options accepted by one command. The help text is the authoritative grammar for the installed version.

## Help

```text
Usage: miftah [command] [options]
```

The root command list includes `serve`, `dashboard`, `console`, `validate`, `doctor`, `schema`, `setup`, `init`, `migrate-config`, `profile list|set-default|test`, `connection add|list|status|test`, `auth connect|reauth|disconnect`, `list-tools`, `test-profile`, `logs`, `audit-export`, `audit-verify`, and `version`. With no command, Miftah runs `serve`.

Documented command names, options, JSON success forms, and exit categories are compatibility contracts. An incompatible CLI removal, rename, required-option change, or semantic output change requires the pre-1.0 deprecation/removal process in the [public compatibility policy](library-api.md#compatibility-policy).

`--help` and `-h` print help and exit successfully. They can appear before or after a command. Help never reads configuration, resolves secrets, or starts an upstream.

## Commands

| Command | Required input | Options | Output and behavior |
| --- | --- | --- | --- |
| `miftah serve --config <file>` | `--config` | `--config <file>`, `--transport <stdio\|http>` | Runs the STDIO MCP wrapper by default, or the configured local Streamable HTTP endpoint with `--transport http`. `miftah --config <file>` is the equivalent default-command STDIO form. |
| `miftah console --config <file>` | `--config` | `--config <file>`, `--port <number>` | Explicitly starts the separate literal-loopback Console control API. It prints the URL and a one-use terminal bootstrap code; no daemon or MCP session is started. |
| `miftah dashboard` | none | `--config <file>`, `--port <number>`, `--no-open` | Starts the optional foreground browser Console on literal loopback. Without `--config`, it offers a safe selector for direct validated configs in `~/.config/miftah`; if none exists, it permits first-run setup at `~/.config/miftah/miftah.json`. With `--config`, it opens only that exact configuration. It opens the system browser unless `--no-open` is set and never starts a daemon. |
| `miftah validate --config <file>` | `--config` | `--config <file>` | Validates the JSON configuration without starting an upstream. Writes a JSON object with `ok`, `name`, and `profiles`. |
| `miftah doctor --config <file>` | `--config` | `--config <file>`, `--json` | Validates configuration and checks upstream readiness. Default output is a human-readable report; `--json` writes only the JSON report. A healthy or degraded report exits `0`; a failed report exits `1`. |
| `miftah schema` | none | none | Writes the Miftah JSON Schema as pretty-printed JSON. |
| `miftah setup [name]` | none, or `--add-profile --config <file>` | The safe preset options accepted by `init`, except `--interactive`, plus `--verify`; `--import-file <file>` with `--import-entry <name>`; `--add-profile --config <file> --profile <name> --oauth-client-secrets-file <file>` for a reviewed provider-owned account; or `--add-profile --config <file> --profile <name> --credential-env <name>` for a simple local environment-backed account | Opens the guided first-configuration flow. It asks for no secret value, validates the complete candidate, creates the output exclusively with owner-restricted permissions, and can print client JSON for manual review. For `local-stdio`, it collects literal argv elements, shows a no-secret review summary, and requires acknowledgement before saving; it never starts that generic local executable. For Google Search Console it can collect one or more named accounts and an explicit default. `--add-profile` either adds one later reviewed provider account or, only for a single simple local credential binding, a new environment-backed account. `--verify` opts into one provider-declared read-only check for every created reviewed adapter profile, or just the newly added account; it is unavailable for generic environment-backed addition and client-entry import because Miftah does not infer a safe probe. The explicit import path accepts one selected local stdio or credential-free HTTPS remote entry and never edits a client configuration file. |
| `miftah init [name]` | none | `--name <name>`, `--preset <name>`, `--output <file>`, `--interactive`, `--client <claude-desktop\|claude-code\|cursor\|vscode\|all>`, `--credential-env <name>`, `--npm-package <package>`, `--docker-image <image>`, `--url <url>`, `--header-name <name>`, `--header-prefix <prefix>`, `--oauth-client-secrets-file <file>`, `--local-command <executable>`, repeated `--arg <value>`, `--cwd <directory>`, `--accept-local-command` | Writes a strict catalog configuration with exclusive creation and can print client JSON snippets. The positional `name` and `--name` are alternatives; the default name is `miftah-wrapper`. |
| `miftah migrate-config --config <file>` | `--config` | `--config <file>`, `--write` | Plans a supported configuration-format migration and writes a safe JSON report. It is dry-run by default. `--write` validates the candidate, makes an exact exclusive `<file>.bak`, then uses a same-directory non-overwriting publication for a changed regular non-symlink source; it never resolves secrets or starts an upstream. |
| `miftah profile list --config <file>` | `--config` | `--config <file>` | Lists the durable default and fixed non-secret metadata for every configured account: name, optional description/tags/policy, and profile-level upstream override names. It only loads and validates configuration; it never resolves secret references, reads credentials, headers, OAuth vault entries, or provider token caches, starts an upstream, or changes configuration. |
| `miftah profile set-default --config <file> --profile <name>` | `--config`, `--profile` | `--config <file>`, `--profile <name>` | Makes one existing profile the durable default for future Miftah sessions. It performs a guarded replacement with a recovery backup and finalizes a configured fail-closed audit record. Its result omits configuration bytes, profile data, provider paths, and secret references; it never starts an upstream, opens OAuth, or changes profile data, provider caches, or an active client session. |
| `miftah profile test --config <file> --profile <name>` | `--config`, `--profile` | `--config <file>`, `--profile <name>`, `--upstream <name>` | Runs only the selected provider adapter's declared read-only readiness check and writes its redacted report. It never accepts an arbitrary tool name, exposes provider output, changes configuration, reads provider token caches, or opens a browser. `--upstream` is required only when the configuration has multiple upstreams. It exits `0` only for `ready`; other bounded readiness results exit `1`. |
| `miftah connection add --config <file>` | `--config`, `--profile`, `--issuer`, `--client-registration` | `--connection <ref>`, `--upstream <name>`, repeated `--scope <scope>`, `--write` | Plans a v3 OAuth binding by default. `--write` applies the reviewed candidate with a unique recovery backup and configured audit event. It never resolves credentials or starts an upstream. |
| `miftah connection list --config <file>` | `--config` | `--client <claude-desktop\|claude-code\|cursor\|vscode\|all>` | Lists redacted connection state. Optional snippets are copyable JSON only; Miftah never edits client settings. |
| `miftah connection status --config <file>` | `--config` plus an unambiguous selector | `--connection <ref>` or `--profile <name>` with optional `--upstream <name>` | Shows exact non-secret binding, credential expiry/state, and coarse identity state. |
| `miftah connection test --config <file>` | `--config` plus an unambiguous selector | `--connection <ref>` or profile/upstream | Tests the existing authenticated upstream and identity probe without allowing browser handoff. |
| `miftah auth connect --config <file>` | `--config` plus an unambiguous selector | `--connection <ref>` or profile/upstream, `--non-interactive` | Uses an existing credential or starts the bounded system-browser authorization flow. Headless mode returns a typed diagnostic instead of opening a browser. |
| `miftah auth reauth --config <file>` | `--config` plus an unambiguous selector | connect options | Forces a fresh flow while retaining the old vault credential until replacement succeeds. |
| `miftah auth disconnect --config <file>` | `--config` plus an unambiguous selector | `--connection <ref>` or profile/upstream | Deletes only the exact local vault credential and marks it disconnected; provider-side revocation remains provider-owned. |
| `miftah list-tools --config <file>` | `--config` | `--config <file>`, `--profile <name>` | Starts the selected profile, discovers its upstream tools, writes a JSON array, then closes the manager. `--profile` defaults to the configured default profile. |
| `miftah test-profile --config <file>` | `--config` | `--config <file>`, `--profile <name>` | Starts and initializes one profile, writes `{"ok":true,"profile":"…"}`, then closes the manager. `--profile` defaults to the configured default profile. |
| `miftah logs --config <file>` | `--config` | `--config <file>`, `--follow` | Reads the configured audit JSONL as normalized, redacted JSONL. `--follow` continues watching it. This command does not construct an upstream manager. |
| `miftah audit-export --config <file> --output <file>` | `--config`, `--output` | `--config <file>`, `--output <file>`, `--include-arguments` | Takes an explicit journal snapshot and writes a new redacted JSONL support export. Success writes `{"ok":true}`. It never starts an upstream or uploads data. |
| `miftah audit-verify --config <file>` | `--config` | `--config <file>`, `--json` | Verifies configured `sha256-chain` journal integrity without resolving secrets or starting an upstream. It writes a safe human report by default or a JSON report with `--json`; a failed or unconfigured integrity check exits `1`. |
| `miftah version` | none | `--json` | Writes the package version as a bare SemVer line. `--json` is retained for automation compatibility and intentionally writes the same bare SemVer line. |

Every command also accepts `--help` and `-h`; those generated per-command help screens show only the options valid for that command.

### `serve` transports

`miftah serve --config <file>` and `miftah serve --transport stdio --config <file>` accept one STDIO client transport. `miftah serve --transport http --config <file>` starts the `/mcp` Streamable HTTP endpoint from `server.http`; it defaults to `http://127.0.0.1:3000/mcp` when that configuration is absent. The listener URL is written to stdout; HTTP mode does not use the STDIO MCP protocol stream. Signals stop new HTTP admissions and close the per-session runtimes and upstream transports.

HTTP bearer authentication is configured only through `server.http.authToken` as a secret reference. The CLI never accepts a bearer token option and never writes one to its listener or error output. See [HTTP server transport](config.md#http-server-transport) for loopback, non-loopback, Host, Origin, session, and request-limit requirements.

### Local Console dashboard and control API

`miftah dashboard` opens the optional browser-local Console and prints its exact URL, resolved first-run location, and one-use bootstrap code. Without `--config`, it inspects only direct, safe JSON configs in `~/.config/miftah` and requires the operator to choose one; it never scans client settings, process arguments, or arbitrary directories. A missing catalog permits strict first-run known-preset or native-OAuth setup at `~/.config/miftah/miftah.json`; an existing file is never silently replaced. `miftah dashboard --config <file>` stays authoritative for one exact configuration and skips catalog discovery. `--no-open` leaves browser launch to the operator while keeping the same foreground server.

`miftah console --config <file>` binds only literal `127.0.0.1`, uses an ephemeral port unless `--port` is supplied, and prints an invocation-bound one-use bootstrap code to the launching terminal. The code is not an OAuth token or MCP bearer. Enter it only in the local Console bootstrap screen; never paste it into a URL, client configuration, log, or support ticket. Stopping the process closes the listener and invalidates every browser session. Restarting produces a fresh bootstrap credential.

The Console API is versioned under `/api/v1` and uses exact Host checks, exact loopback Origin plus CSRF for every mutation, a short-lived HttpOnly same-site session, bounded JSON, fail-closed mutation audit, and metadata-only responses. Authenticated reads may omit Origin because normal same-origin browser GETs do not consistently send it. It modifies durable configuration and exact local OAuth credentials for future client connections; it cannot take over or silently change another process's active Claude Desktop session. See the [local Console dashboard and control API](console-api.md) for the full endpoint and bootstrap contract.

### `init` presets and paths

On macOS and Linux, `--preset` defaults to `generic`. On Windows, `--preset` is required for noninteractive `init`; there is no implicit generic preset. The strict catalog accepts `generic`, `github`, `sentry`, `google-search-console`, `generic-npx`, `generic-docker`, `local-stdio`, and `streamable-http`; an unrecognized preset is a usage error. `--output` defaults to `<name>.miftah.json`. Miftah resolves the output path from the current working directory, creates missing parent directories, and refuses to overwrite an existing file. Quote shell paths and names containing spaces:

```sh
miftah init "work wrapper" --preset github --output "$HOME/Miftah configs/work wrapper.json"
miftah validate --config "$HOME/Miftah configs/work wrapper.json"
```

`generic-npx` requires `--npm-package` with exact package SemVer; `generic-docker` requires a canonical digest in `--docker-image`; `streamable-http` requires `--url` plus optional credential environment/header metadata; and one-account noninteractive `google-search-console` requires `--oauth-client-secrets-file` with an absolute path. `local-stdio` requires `--local-command` and `--accept-local-command`; it accepts repeated literal `--arg` values, optional native absolute `--cwd`, and optional `--credential-env`. Use `--arg=--flag` for a value that begins with a dash. On Windows, the local executable must be an absolute `.exe` or `.com` binary; bare commands and `.cmd`/`.bat` shims are rejected so the direct argv path never uses a command processor. On Windows, `generic`, `sentry`, and `generic-npx` are unavailable because npm's `npx` runner requires a command shell. It rejects shell executables and wrappers, URL-like commands, environment references, controls, and credential-shaped command or argument values. It writes a read-only profile, treats unknown tools as destructive, and does not launch a generic local executable during `init` or `setup`. Guided GSC setup can collect one or more named accounts, their client-secrets paths, and an explicit default profile. `--credential-env` is optional where supported. The GSC adapter prints credential/browser/identity ownership without printing a configured path. See [preset and client compatibility](presets-and-clients.md) for exact inputs, pins, provenance, and client snippets, and [provider adapters](provider-adapters.md) for the upstream-owned OAuth boundary.

`--interactive` uses a wizard only when both input and output are TTYs. EOF or Ctrl-C while it is collecting initial configuration data cancels without writing a config. In `miftah setup`, the first answer can be `remote` for the strict `streamable-http` path, `local` for `local-stdio`, or any catalog connector name. It asks for variable names and safe metadata, never secret values. The `remote` answer does not discover OAuth or call the upstream; use `miftah setup --native-oauth` only when the remote server advertises standards-based OAuth. For `local-stdio`, it asks for one argv element at a time and prints only a bounded count-based review summary before the acknowledgement; it does not echo arguments or credential values. For Google Search Console it asks for each account's profile name, optional description, and client-secrets path, then an explicit default profile. `miftah setup --verify` is an explicit opt-in to run each selected adapter's declared safe read-only check after the configuration write. It never accepts a tool name or arguments from the operator, never guesses a health command, does not auto-approve a policy confirmation, and returns only bounded status rather than provider output. The check runs only while the selected profile still matches the adapter's reviewed launch envelope; otherwise it reports a bounded unsupported status without launching the provider. If the post-write readiness prompt is cancelled, Miftah keeps the configuration, reports incomplete verification, and exits 1. A non-ready `setup --verify` result also keeps the configuration and exits 1. `init` is network-free and does not accept `--verify` or client-entry import flags. In noninteractive use, `init` creates only the config unless `--client` is supplied. `--client` prints JSON with absolute Node and compiled Miftah paths; it does not write a host config. For `claude-code` or `all`, it also prints a separate, exact management-tool `permissions.ask` fragment for manual merge into Claude Code settings; it never writes or overwrites those settings. Regenerate the snippets after moving or upgrading Miftah or changing the config path.

`miftah setup --add-profile --config <file>` has two typed returning-user paths. For a reviewed provider-owned adapter, noninteractive use requires `--profile` and `--oauth-client-secrets-file`; `--description`, `--make-default`, and `--verify` are optional. Miftah proves that the entire selected configuration matches one adapter and that every existing account has a literal absolute credential-file reference plus a distinct canonical provider-state directory. It then atomically adds one new profile and isolated state directory through that adapter contract. Miftah never reads the credential file or the upstream token cache. Unsupported, modified, mixed, or shared-state configurations fail closed with `PROVIDER_ACCOUNT_ADDITION_UNSUPPORTED`; an invalid credential-file path fails with `PROVIDER_ACCOUNT_INPUT_INVALID`. `--verify` checks the new account only.

For a static local account, noninteractive use requires `--profile` and `--credential-env`; the latter is an environment-variable name, never a secret value. This path accepts only a configuration with exactly one unnamed `stdio` upstream, one direct `${ENV_NAME}` credential binding in every profile, one shared destination/policy, no provider adapter, no native OAuth, and no named upstreams or other profile overrides. It atomically adds one profile that points at a different environment variable, enforces profile-switch confirmation and explicit destructive selection, and never starts the upstream or reads the credential. Remote HTTP credentials use headers rather than profile environments, so remote configurations fail closed with `ENVIRONMENT_PROFILE_ADDITION_UNSUPPORTED`. Generic `--verify` is deliberately rejected because Miftah has no declared safe probe. The durable default changes only when `--make-default` is present, so existing MCP clients still need a restart or new connection.

`miftah setup <name> --import-file <absolute-json-file> --import-entry <name>` is a separate no-secret flow, not a generic client migration. The source file must be an absolute regular non-symlink file. Miftah reads it through one bounded verified handle, requires an explicitly selected entry, and never changes the source. It accepts either a local `stdio` entry under `mcpServers` (Claude Desktop, Claude Code, or Cursor) or `servers` (VS Code) that fits its finite static launch grammar—literal executable, optional absolute working directory, and either an exact-version package-runner launch with only that runner's fixed safe prefix flags and no arguments after the package, a script path plus non-sensitive flags, or a direct executable plus non-sensitive flags—or one credential-free HTTPS remote entry. A remote import uses `url` under `mcpServers` or `servers` and must explicitly declare `type: "http"` or `"streamable-http"`. It requires HTTPS without userinfo, query, fragment, or opaque credential-shaped path segments, and does not discover OAuth or call the remote endpoint. On Windows, a local import accepts only a direct absolute `.exe` or `.com` executable; bare runners such as `npx` or `node`, and `.cmd`/`.bat` shims, are rejected rather than being dispatched through a command processor. It rejects `env`, headers, shell settings, unknown fields, environment wrappers, inline code, opaque values or assignments, unsupported remote transports, URL userinfo, opaque credential-shaped URL path segments, unpinned package references, and credential-shaped arguments. It creates a read-only default profile with unknown tool risk set to destructive and does not launch the imported program. `--verify` is rejected before publication because no reviewed provider adapter is inferred. Use advanced manual setup when the existing entry does not fit this grammar; configure upstream credentials or OAuth separately through the upstream's documented path and Miftah secret references.

### `migrate-config`

`miftah migrate-config --config <file>` accepts only the documented supported formats and writes a JSON report containing source/target versions, safe structural actions, and whether a write occurred. It reads and validates the candidate before it changes anything. It does not emit a raw config, a diff, resolved secret values, or provider output.

`--write` is intentionally required for mutation. For a changed valid-UTF-8 configuration, Miftah refuses symlinks and non-regular sources, captures a source snapshot, moves it into a dedicated same-directory transaction directory, and privately prepares the exact backup and synced candidate. It publishes each only to an absent destination path, so it never overwrites a concurrent file. On Windows, the transaction directory is created with a current-user-only DACL and the source owner/group/DACL is copied and verified before either private file receives source-derived bytes. If publication cannot complete, Miftah restores the verified original when it can do so without overwriting anything; otherwise it exits nonzero and reports the retained recovery transaction directory. A current configuration reports `changed: false`; with `--write` it remains untouched and creates no backup. See [configuration version compatibility](config.md#configuration-version-compatibility-and-migration) for version windows and exactly which aliases can be migrated.

### OAuth connection lifecycle

Connection selectors never guess between accounts. Use `--connection oauthconn:<uuid>`, or provide a profile/upstream tuple that resolves to exactly one configured binding. Omitting a selector is accepted only when the configuration contains one connection. An ambiguous or missing target returns a typed configuration diagnostic.

`connection add` is dry-run by default. Copy the generated reference from the report into `--connection`, review the planned version and structural actions, and add `--write` to commit that exact reference. Every write re-reads and validates an exact source snapshot, creates a unique same-directory recovery backup, and uses the guarded non-overwriting transaction documented for migration. Existing connection references are never replaced.

`connection list`, `connection status`, and client snippets do not resolve unrelated profile secrets or start an upstream. `connection test` may access the OS vault and upstream but disables browser handoff. `auth connect` and `auth reauth` are the only commands that permit the browser flow; `--non-interactive` disables it for CI and headless hosts. Reauth does not delete the usable old credential before a replacement succeeds. Disconnect removes only Miftah's exact local credential and cannot promise provider-side revocation.

### `doctor`

`doctor` checks configuration, secret references, external provider availability, redaction, permissions, configured audit storage, executable availability, upstream startup, discovery, and clean shutdown where applicable. Its checks have stable `code`, `status`, `target`, `explanation`, and `remediation` fields.

```sh
miftah doctor --config github.json
miftah doctor --json --config github.json
```

The JSON report intentionally omits resolved secret values, raw configuration paths, configured upstream command arguments, and its synthetic redaction canary.

`DOCTOR_SECRET_PROVIDERS` is an availability-only check: it verifies configured keychain/1Password platform or executable prerequisites without looking up a secret. Doctor then uses target-scoped secret resolution for each profile/upstream readiness probe. A locked, unavailable, or malformed secret reference therefore produces a redacted target-local `DOCTOR_SECRET_REFERENCES` error without preventing unrelated healthy targets from starting and being checked.

When identity verification is unconfigured, doctor records `DOCTOR_IDENTITY` as `skipped`. A configured verified identity is `pass`; mismatch, unsupported, or failed required identity verification is `error`; and nonverified optional identity verification is `warning`. Identity doctor output never includes raw probe output or fingerprint values.

### MCP identity management

`miftah_verify_identity` is an MCP management tool, not a shell subcommand. It accepts optional `profile` and `upstream` strings. `profile` defaults to the active profile. Supplying a named `upstream` verifies only that target; `upstream: "default"` is an alias only for a single unnamed upstream. With `upstream` omitted, Miftah verifies every configured target in deterministic upstream order. The response always contains safe structured identity results, including nonverified states, and its audit event contains only safe evidence and a failure outcome when verification did not succeed.

`miftah_list_profiles` and `miftah_profile_info` show each profile's configured and persisted binding evidence; `miftah_current_profile`, `miftah_health`, and `miftah_route_preview` expose the same configured, persisted, or cached identity status. None starts an upstream or runs a probe. A newly started client reloads persisted evidence and durable profile selection, but another process or Console action cannot silently replace an already active client's in-memory selection; restart that client when applying an external configuration or durable-selection change.

### MCP profile management

`miftah_current_profile` returns the active/default profile plus safe selection metadata: `selectionSource`, `selectedAt`, and `scope`, plus `confirmation`, `lease`, and `lock`. When stored active-profile state is corrupt, stale, or unavailable, it additionally returns a stable `stateDiagnostic`; it never returns the state-file path or raw state contents. `miftah_use_profile` changes the active profile according to the configured scope. `miftah_reset_profile` returns to the configured default and writes that default when the scope is durable. When `security.requireProfileSwitchConfirmation` is enabled, the default human mode requires a generic form from a form-capable client and otherwise fails closed. Only the explicit `security.approvalMode: "delegated-agent"` mode offers a connection-bound bearer through `miftah_approve` for the exact retry; it is automation authorization, not a human confirmation.

`miftah_lock_profile` and `miftah_unlock_profile` are advertised for a stable MCP surface. Calls reject with `PROFILE_LOCKING_DISABLED` unless `security.allowProfileLockingFromMcp` is enabled. When enabled, they return JSON containing `profileState`, operate only for the current MCP connection, and never modify durable selection state. A configured `security.lockToProfile` cannot be changed with either tool.

## Global version options

These forms all print the package SemVer to stdout and nothing to stderr:

```sh
miftah --version
miftah -v
miftah version
miftah version --json
```

`--version` and `-v` are root options, so they cannot be combined with another command. `--version --json` is accepted and also preserves the bare SemVer output.

## Exit status and streams

Successful machine-readable commands write only their documented JSON or JSONL to stdout and keep stderr empty. Failures write diagnostics to stderr; their messages redact resolved secret values and upstream output containing them. Usage errors happen before configuration loading, secret resolution, or process startup.

| Exit | Category | Examples |
| --- | --- | --- |
| `0` | Success | Help, schema, validation, successful commands, and healthy or degraded doctor reports. |
| `1` | Operation | A failed doctor report or another uncategorized operational failure. |
| `2` | Usage | Unknown flags or commands, missing option values, duplicate options, misplaced options, or a command without its required `--config`. |
| `3` | Configuration | Missing or unreadable config, invalid JSON or schema, and invalid configuration references. |
| `4` | Secret resolution | A required environment or secret provider value could not be resolved. |
| `5` | Upstream | Upstream process startup, initialization, discovery, transport, or shutdown failures. |
| `6` | Policy | Runtime policy, routing-blocked, routing-ambiguous, or confirmation-required failures. |

Configuration errors can name an unresolved environment variable so it can be repaired, but never print a resolved secret value. Code `6` is reserved for policy failures surfaced by runtime operations; no standalone diagnostic command currently performs a policy-governed MCP operation.

## Audit logs

`logs` resolves the same configured secret-bearing maps as runtime startup, including named upstream and non-default profile maps, before it renders an audit record. Each complete JSONL record is parsed, normalized, and redacted before output. Configured secret values, URI userinfo, fragments, and URI query values are removed or redacted; malformed or invalid UTF-8 records become a fixed valid JSON marker instead of being copied through.

```sh
miftah logs --config "$HOME/Miftah configs/work wrapper.json"
miftah logs --config "$HOME/Miftah configs/work wrapper.json" --follow
```

Without `--follow`, Miftah creates a stable finite snapshot before emitting it. If the file changes continually, it retries a bounded number of times and fails without emitting a mixed snapshot. Snapshot staging is private and removed after output or failure.

With `--follow`, Miftah polls at a bounded interval (250 ms by default), detects appends, truncation, copy-truncate rewrites, and replacement/rename rotation, and never keeps an audit file handle between polls. An absent file is treated as temporarily unavailable while following. `SIGINT` and `SIGTERM` stop the follower promptly, abandon pending output safely, remove signal listeners and temporary staging files, and do not start or signal an upstream process.

The reader uses fixed-size chunks and bounds an unterminated record at 64 KiB. This prevents an unbounded partial line from consuming memory, but means a record that exceeds that boundary is represented by the malformed-record marker rather than recovered.

### Rotation, export, and verification

When `audit.rotation` or `audit.integrity` is configured, a finite `logs` read snapshots the retained managed segments plus the active file before it emits output. Retention keeps only Miftah-managed regular archives and refuses unsafe paths; it does not traverse symlinks or clean outside the configured audit directory. The managed follower carries a stable file identity across a rename rotation so it does not lose or duplicate completed records at that boundary. If the platform cannot provide that identity and a rotation boundary is ambiguous, it stops with a safe error rather than risk silently omitting completed records.

```sh
miftah audit-export --config "$HOME/Miftah configs/work wrapper.json" --output ./support-audit.jsonl
miftah audit-export --config "$HOME/Miftah configs/work wrapper.json" --output ./support-audit.jsonl --include-arguments
miftah audit-verify --config "$HOME/Miftah configs/work wrapper.json"
miftah audit-verify --config "$HOME/Miftah configs/work wrapper.json" --json
```

`audit-export` is deliberately explicit: it creates a new output and refuses an existing destination. It runs redaction again and strips stored `arguments` by default, even if the journal was configured to record them. `--include-arguments` opts in to the stored values after redaction; it cannot reconstruct arguments that were never recorded. The command is local-only and does not upload telemetry or start an upstream.

`audit-verify` reports a safe first broken segment/record/reason and never writes a raw record, hash, or absolute path. Hash chaining provides local tamper evidence, not a signature or a remote immutable audit trail; keep required evidence in an independently protected destination.
