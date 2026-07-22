# CLI reference

`miftah` is an MCP wrapper with STDIO as its default transport and an opt-in local Streamable HTTP server. Run `miftah --help` for the generated command list, or `miftah <command> --help` for the options accepted by one command. The help text is the authoritative grammar for the installed version.

## Help

```text
Usage: miftah [command] [options]
```

The root command list includes `serve`, `validate`, `doctor`, `schema`, `init`, `migrate-config`, `connection add|list|status|test`, `auth connect|reauth|disconnect`, `list-tools`, `test-profile`, `logs`, `audit-export`, `audit-verify`, and `version`. With no command, Miftah runs `serve`.

Documented command names, options, JSON success forms, and exit categories are compatibility contracts. An incompatible CLI removal, rename, required-option change, or semantic output change requires the pre-1.0 deprecation/removal process in the [public compatibility policy](library-api.md#compatibility-policy).

`--help` and `-h` print help and exit successfully. They can appear before or after a command. Help never reads configuration, resolves secrets, or starts an upstream.

## Commands

| Command | Required input | Options | Output and behavior |
| --- | --- | --- | --- |
| `miftah serve --config <file>` | `--config` | `--config <file>`, `--transport <stdio\|http>` | Runs the STDIO MCP wrapper by default, or the configured local Streamable HTTP endpoint with `--transport http`. `miftah --config <file>` is the equivalent default-command STDIO form. |
| `miftah validate --config <file>` | `--config` | `--config <file>` | Validates the JSON configuration without starting an upstream. Writes a JSON object with `ok`, `name`, and `profiles`. |
| `miftah doctor --config <file>` | `--config` | `--config <file>`, `--json` | Validates configuration and checks upstream readiness. Default output is a human-readable report; `--json` writes only the JSON report. A healthy or degraded report exits `0`; a failed report exits `1`. |
| `miftah schema` | none | none | Writes the Miftah JSON Schema as pretty-printed JSON. |
| `miftah init [name]` | none | `--name <name>`, `--preset <name>`, `--output <file>`, `--interactive`, `--client <claude-desktop\|claude-code\|cursor\|vscode\|all>`, `--credential-env <name>`, `--npm-package <package>`, `--docker-image <image>`, `--url <url>`, `--header-name <name>`, `--header-prefix <prefix>` | Writes a strict catalog configuration with exclusive creation and can print client JSON snippets. The positional `name` and `--name` are alternatives; the default name is `miftah-wrapper`. |
| `miftah migrate-config --config <file>` | `--config` | `--config <file>`, `--write` | Plans a supported configuration-format migration and writes a safe JSON report. It is dry-run by default. `--write` validates the candidate, makes an exact exclusive `<file>.bak`, then uses a same-directory non-overwriting publication for a changed regular non-symlink source; it never resolves secrets or starts an upstream. |
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

### `init` presets and paths

`--preset` defaults to `generic`. The strict catalog accepts `generic`, `github`, `sentry`, `generic-npx`, `generic-docker`, and `streamable-http`; an unrecognized preset is a usage error. `--output` defaults to `<name>.miftah.json`. Miftah resolves the output path from the current working directory, creates missing parent directories, and refuses to overwrite an existing file. Quote shell paths and names containing spaces:

```sh
miftah init "work wrapper" --preset github --output "$HOME/Miftah configs/work wrapper.json"
miftah validate --config "$HOME/Miftah configs/work wrapper.json"
```

`generic-npx` requires `--npm-package` with exact package SemVer; `generic-docker` requires a canonical digest in `--docker-image`; and `streamable-http` requires `--url` plus optional credential environment/header metadata. `--credential-env` is optional where supported. See [preset and client compatibility](presets-and-clients.md) for exact inputs, pins, provenance, and client snippets.

`--interactive` uses a wizard only when both input and output are TTYs. EOF or Ctrl-C cancels without writing a config. It asks for variable names and safe metadata, never secret values. In noninteractive use, `init` creates only the config unless `--client` is supplied. `--client` prints JSON with absolute Node and compiled Miftah paths; it does not write a host config. For `claude-code` or `all`, it also prints a separate, exact management-tool `permissions.ask` fragment for manual merge into Claude Code settings; it never writes or overwrites those settings. Regenerate the snippets after moving or upgrading Miftah or changing the config path.

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

`miftah_list_profiles` and `miftah_profile_info` show each profile's configured and persisted binding evidence; `miftah_current_profile`, `miftah_health`, and `miftah_route_preview` expose the same configured, persisted, or cached identity status. None starts an upstream or runs a probe. A newly started client reloads persisted evidence and durable profile selection, but another process or future Console action cannot silently replace an already active client's in-memory selection; restart that client when applying an external configuration or durable-selection change.

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
