# What is in Miftah 0.5

Install `@lubab/miftah@0.5.7` when you want Miftah to guide setup instead of assembling a multi-account configuration by hand:

```bash
npm install -g @lubab/miftah@0.5.7
miftah version
```

The short version of 0.5.0 compared with 0.4.0 is: Miftah now has guided and resumable setup, safer setup previews, account-profile maintenance commands, client-entry import, and an implemented multi-account Google Search Console onboarding path, with external validation still in progress.

Native OAuth and the optional Console first shipped in 0.4.0. 0.5.0 makes them easier to discover, configure, and maintain; it does not introduce universal OAuth support or a hosted Miftah service.

## The 60-second feature map

| What you want to do | What 0.5 adds | Start here |
| --- | --- | --- |
| Create a configuration from what you already have | An outcome-first wizard for a known connector, remote HTTPS MCP, local executable, browser sign-in, or one existing client entry | `miftah setup` |
| Review setup before writing | A non-secret, no-write structural plan | `miftah setup --plan` with the complete inputs for your setup path |
| Continue an interrupted setup choice | A private, bounded checkpoint that stores no URL, path, command, credential, or browser state | `miftah setup --resume`, or `miftah setup --discard-draft` |
| Add another supported account | Guarded profile addition for the reviewed Google Search Console adapter or a narrow local environment-backed configuration | `miftah setup --add-profile` |
| See and maintain configured accounts | List, change the durable default, describe, rename, remove, or safely test one profile | `miftah profile list --config CONFIG_FILE` |
| Use the browser instead of the terminal wizard | The same reviewed first-run and account-management paths in the foreground local Console | `miftah dashboard` |

## 1. Start with the guided setup

Run:

```bash
miftah setup
```

The wizard shows these as numbered choices:

- **connector** — a reviewed built-in connector or exact-pinned package;
- **remote HTTPS** — a strict Streamable HTTP endpoint without contacting it during generic setup;
- **local executable** — one literal executable plus argument array, with no shell;
- **browser sign-in** — a remote HTTPS MCP that advertises Miftah's supported standards-based OAuth flow;
- **import** — one explicitly selected entry from one existing client JSON file.

Enter a number or name, then review the selected path. You can enter `back` before connection details are collected or `cancel` before a configuration is written. The wizard asks for environment-variable names and non-secret metadata, not token or password values. It validates the complete candidate before publication and prints client configuration for manual review. Miftah does not silently edit Claude Desktop, Claude Code, Cursor, or VS Code.

After merging the generated client entry, restart the MCP client. A running client process does not automatically adopt configuration or profile changes made later.

## 2. Preview a complete setup without writing

For example, this Google Search Console plan is safe to paste even before the referenced client-secrets file exists:

```bash
miftah setup gsc --preset google-search-console \
  --oauth-client-secrets-file "$HOME/.config/gsc/client-secrets.json" \
  --output "$HOME/.config/miftah/gsc.json" \
  --plan
```

The plan does not write a configuration or start an upstream. It can identify the requested publication target, but its configuration summary omits credential paths, endpoints, launch arguments, credential references, OAuth details, and secret values.

When the real inputs are ready, repeat the command without `--plan` to create the new file. Add `--verify` only when you want a reviewed adapter's declared read-only readiness check to run after publication.

If interactive setup stops after saving its bounded connector choice, continue with:

```bash
miftah setup --resume
```

Discard that saved choice without creating a configuration with:

```bash
miftah setup --discard-draft
```

All connection details must be entered again after resume; the checkpoint does not store them.

## 3. Import one existing client entry

Choose **import** in `miftah setup`, provide one absolute client JSON path, and select one listed entry. Miftah displays entry names only. It does not print the source command, arguments, environment values, headers, or credentials, and it never modifies the source client file.

The import path accepts only a supported local STDIO entry or a credential-free HTTPS remote entry. It does not guess authentication ownership. Use `--import-file` and `--import-entry` for the equivalent explicit noninteractive path. Import has its own bounded source inspection and candidate review; `--plan` cannot be combined with import.

## 4. Set up and maintain multiple Google accounts

Google Search Console is the reviewed provider-adapter example in 0.5:

```bash
miftah setup gsc --preset google-search-console
```

The guided flow collects each profile name and asks which profile should be the durable default. Every generated configuration/profile pair receives a distinct `GSC_CONFIG_DIR`. The `mcp-search-console` upstream owns browser login, refresh, reauthentication, and the token cache inside that directory. Miftah never reads or copies the upstream-owned token cache. Provider-side disconnect and revocation stay manual through the upstream and Google account controls; Miftah cannot promise provider-side revocation.

Add a returning account to an existing reviewed configuration with:

```bash
miftah setup --add-profile \
  --config "$HOME/.config/miftah/gsc.json" \
  --profile google-personal \
  --oauth-client-secrets-file "$HOME/.config/gsc/personal-client-secrets.json" \
  --verify
```

This is a configuration mutation, not a preview. It adds one isolated profile through the reviewed adapter contract, records a redacted lifecycle event when configured audit is enabled, and runs only the declared `get_capabilities` readiness probe when `--verify` is present. That probe is health evidence; it does not prove the authorized Google account or property.

Read the [provider-adapter guide](provider-adapters.md) for prerequisites, service-account alternatives, cache ownership, and recovery.

## 5. Inspect and maintain account profiles

Use `CONFIG_FILE`, `PROFILE_NAME`, and the other uppercase values below as literal safe placeholders until you substitute your reviewed values:

| Task | Command |
| --- | --- |
| List non-secret profile metadata | `miftah profile list --config CONFIG_FILE` |
| Change the durable default for future sessions | `miftah profile set-default --config CONFIG_FILE --profile PROFILE_NAME` |
| Add a non-secret description | `miftah profile set-description --config CONFIG_FILE --profile PROFILE_NAME --description DESCRIPTION_TEXT` |
| Rename a profile and its configuration-owned references | `miftah profile rename --config CONFIG_FILE --profile PROFILE_NAME --new-profile NEW_PROFILE_NAME` |
| Remove a profile and reassign durable references | `miftah profile remove --config CONFIG_FILE --profile PROFILE_NAME --replacement-profile REPLACEMENT_PROFILE` |
| Run one adapter-declared read-only readiness check | `miftah profile test --config CONFIG_FILE --profile PROFILE_NAME` |

`list` does not resolve credentials or start an upstream. The configuration-changing commands validate first, use guarded replacement and recovery backup behavior, and preserve the documented credential and provider-cache boundaries. Profile changes affect future MCP sessions; restart the MCP client when you need a new session to observe them.

## 6. Pick the correct authentication owner

| Authentication path | What Miftah owns | Where to begin |
| --- | --- | --- |
| API key or secret reference | Resolving a configured profile-scoped reference and redacting the value | Run `miftah setup` and provide an environment-variable name or another supported secret reference. |
| Native OAuth | Supported remote discovery, browser authorization, OS-vault storage, refresh, reauth, and exact local disconnect | Use `miftah setup --native-oauth` only with a real HTTPS MCP endpoint that satisfies the documented standards. |
| upstream-owned OAuth | Passing reviewed configuration to the upstream while leaving its browser and cache lifecycle alone | Use a reviewed adapter such as Google Search Console and follow its upstream login. |

Miftah does not support OAuth for every MCP server or provider. A successful login, resolvable credential, or profile label is not proof of scopes or account identity. See the [OAuth guide](oauth-support.md#support-matrix) for native connection lifecycle commands and the exact support matrix.

## 7. Use the optional local Console

Run:

```bash
miftah dashboard
```

The Console is a foreground, literal-loopback browser UI for reviewed setup, profile maintenance, connection health, and supported OAuth lifecycle work. It is optional, does not run as a daemon, never exposes raw credentials, and cannot take over an already-running MCP client session.

Use `miftah dashboard --no-open` when you want the local URL printed without opening a browser. See the [Console guide](console-api.md) for its one-use bootstrap and authenticated local-control boundary.

## Reliability and security changes in 0.5

The release also:

- refuses Windows STDIO command shims and shell executables instead of silently falling back to `cmd.exe`;
- patches the MCP SDK/Hono runtime dependency chain and scoped development-toolchain advisories;
- hardens Windows configuration identity and Console ACL checks;
- improves macOS OAuth locking, audit locking, and bounded upstream process-tree cleanup.

These changes do not weaken redaction, audit finalization, Windows ACL verification, process containment, or existing timeouts. See the [full changelog](../CHANGELOG.md) for the issue-by-issue details.

## Upgrade and validation

Version 0.4 already wrote configuration format v3, so a normal 0.4 configuration does not need a format change merely because the package becomes 0.5. Validate the exact file and its runtime readiness after upgrading:

```bash
miftah validate --config "$HOME/.config/miftah/miftah.json"
miftah doctor --config "$HOME/.config/miftah/miftah.json"
```

If your configuration is still v1 or v2, use the dry-run-first migration path in the [CLI reference](cli.md) rather than editing version fields by hand.

## What remains intentionally incomplete

- External multi-account and returning-user validation is still open in [#25](https://github.com/mohanagy/miftah/issues/25) and [#88](https://github.com/mohanagy/miftah/issues/88).
- Miftah is experimental and pre-1.0; minor releases can contain documented incompatible changes.
- Native OAuth is deliberately narrow. Provider-specific and local OAuth often remains upstream-owned.
- Miftah cannot prove an account identity unless the selected upstream exposes stable, bounded identity evidence.
- Generated client snippets are manual handoff artifacts. Miftah does not silently edit client settings or replace a running MCP session.

For every command and option, use the [CLI reference](cli.md). For the product model and first working connector, return to the [README](../README.md).
