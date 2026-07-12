# CLI reference

`miftah` is a local STDIO MCP wrapper. Run `miftah --help` for the generated command list, or `miftah <command> --help` for the options accepted by one command. The help text is the authoritative grammar for the installed version.

## Help

```text
Usage: miftah [command] [options]
```

The root command list is `serve`, `validate`, `doctor`, `schema`, `init`, `list-tools`, `test-profile`, `logs`, and `version`. With no command, Miftah runs `serve`.

`--help` and `-h` print help and exit successfully. They can appear before or after a command. Help never reads configuration, resolves secrets, or starts an upstream.

## Commands

| Command | Required input | Options | Output and behavior |
| --- | --- | --- | --- |
| `miftah serve --config <file>` | `--config` | `--config <file>` | Runs the STDIO MCP wrapper until it is stopped. `miftah --config <file>` is the equivalent default-command form. |
| `miftah validate --config <file>` | `--config` | `--config <file>` | Validates the JSON configuration without starting an upstream. Writes a JSON object with `ok`, `name`, and `profiles`. |
| `miftah doctor --config <file>` | `--config` | `--config <file>`, `--json` | Validates configuration and checks upstream readiness. Default output is a human-readable report; `--json` writes only the JSON report. A healthy or degraded report exits `0`; a failed report exits `1`. |
| `miftah schema` | none | none | Writes the Miftah JSON Schema as pretty-printed JSON. |
| `miftah init [name]` | none | `--name <name>`, `--preset <name>`, `--output <file>`, `--interactive`, `--client <claude-desktop\|claude-code\|cursor\|vscode\|all>`, `--credential-env <name>`, `--npm-package <package>`, `--docker-image <image>`, `--url <url>`, `--header-name <name>`, `--header-prefix <prefix>` | Writes a strict catalog configuration with exclusive creation and can print client JSON snippets. The positional `name` and `--name` are alternatives; the default name is `miftah-wrapper`. |
| `miftah list-tools --config <file>` | `--config` | `--config <file>`, `--profile <name>` | Starts the selected profile, discovers its upstream tools, writes a JSON array, then closes the manager. `--profile` defaults to the configured default profile. |
| `miftah test-profile --config <file>` | `--config` | `--config <file>`, `--profile <name>` | Starts and initializes one profile, writes `{"ok":true,"profile":"…"}`, then closes the manager. `--profile` defaults to the configured default profile. |
| `miftah logs --config <file>` | `--config` | `--config <file>`, `--follow` | Reads the configured audit JSONL as normalized, redacted JSONL. `--follow` continues watching it. This command does not construct an upstream manager. |
| `miftah version` | none | `--json` | Writes the package version as a bare SemVer line. `--json` is retained for automation compatibility and intentionally writes the same bare SemVer line. |

Every command also accepts `--help` and `-h`; those generated per-command help screens show only the options valid for that command.

### `init` presets and paths

`--preset` defaults to `generic`. The strict catalog accepts `generic`, `github`, `sentry`, `generic-npx`, `generic-docker`, and `streamable-http`; an unrecognized preset is a usage error. `--output` defaults to `<name>.miftah.json`. Miftah resolves the output path from the current working directory, creates missing parent directories, and refuses to overwrite an existing file. Quote shell paths and names containing spaces:

```sh
miftah init "work wrapper" --preset github --output "$HOME/Miftah configs/work wrapper.json"
miftah validate --config "$HOME/Miftah configs/work wrapper.json"
```

`generic-npx` requires `--npm-package` with exact package SemVer; `generic-docker` requires a canonical digest in `--docker-image`; and `streamable-http` requires `--url` plus optional credential environment/header metadata. `--credential-env` is optional where supported. See [preset and client compatibility](presets-and-clients.md) for exact inputs, pins, provenance, and client snippets.

`--interactive` uses a wizard only when both input and output are TTYs. EOF or Ctrl-C cancels without writing a config. It asks for variable names and safe metadata, never secret values. In noninteractive use, `init` creates only the config unless `--client` is supplied. `--client` prints JSON with absolute Node and compiled Miftah paths; it does not write a host config. Regenerate the snippet after moving or upgrading Miftah or changing the config path.

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

`miftah_current_profile`, `miftah_health`, and `miftah_route_preview` expose configured or cached identity status but do not start an upstream or run a probe.

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

The reader uses fixed-size chunks and bounds an unterminated record at 64 KiB. This prevents an unbounded partial line from consuming memory, but means a record that exceeds that boundary is represented by the malformed-record marker rather than recovered. Audit output is an integrity and observability interface, not a replacement for retaining the original audit file under an external rotation and retention policy.
