# Provider adapters

Provider adapters describe a narrow, reviewed integration with an MCP server whose authentication is local, proprietary, or owned by that upstream. An adapter is not a generic OAuth plugin and does not grant provider code access to Miftah internals. The built-in catalog records launch prerequisites, credential ownership, browser handoff, identity evidence, health, reauthentication, disconnect, diagnostics, and destructive-tool posture.

Every adapter declares one credential owner: Miftah, the upstream, or manual-only. The typed ownership union prevents an upstream-owned adapter from claiming Miftah's browser callback or OS vault. Adapter diagnostics are metadata-only. They never inspect arbitrary credential files or token caches, and an adapter cannot turn a provider-specific flow into a native `oauth.connections` binding.

## Google Search Console pilot

The initial pilot wraps the community [`mcp-search-console`](https://github.com/AminForou/mcp-gsc) STDIO server. It is deliberately upstream-owned:

| Boundary | Contract |
| --- | --- |
| Launch | `uvx mcp-search-console@0.3.2`; Python 3.11 or newer and `uvx` are prerequisites. |
| Credential ownership | Upstream |
| Browser handoff | The upstream opens the browser on first authenticated use. Miftah does not run this OAuth callback. |
| Token cache | The upstream chooses and maintains its platform user-config cache. Miftah never reads, copies, exports, or deletes that cache. |
| Safe health evidence | The upstream `get_capabilities` tool can report authentication readiness. It is health metadata, not verified Google-account identity. |
| Reauthentication | The upstream owns the `reauthenticate` MCP tool. The generated read-only Miftah policy does not silently grant it. |
| Disconnect and revoke | Manual-only. Remove/revoke access with the upstream and Google account controls; Miftah cannot promise provider-side revocation. |
| Identity evidence | Unavailable by default. OAuth success and `get_capabilities` do not prove the intended Google account or property. |
| Destructive tools | Disabled upstream by default. The preset never sets `GSC_ALLOW_DESTRUCTIVE`; enabling it is a separate manual review and still remains subject to Miftah policy. |

Create the pilot configuration with an absolute path to a Google OAuth desktop client-secrets JSON file:

```sh
miftah init gsc \
  --preset google-search-console \
  --oauth-client-secrets-file "$HOME/.config/gsc/client-secrets.json" \
  --output "$HOME/.config/miftah/gsc.json" \
  --client claude-desktop
```

The generated profile passes that path as `GSC_OAUTH_CLIENT_SECRETS_FILE`, pins `mcp-search-console@0.3.2`, applies Miftah's read-only policy, and does not create an `oauth.connections` entry. `init` prints the safe ownership summary but never echoes the configured client-secrets path. Complete the upstream browser flow on first use, then call `get_capabilities` when you need its coarse auth health. Use the upstream's `reauthenticate` tool only after explicitly reviewing and authorizing that lifecycle operation.

Manual configuration remains supported. If `uvx` is installed at an absolute path, or the upstream needs another documented environment value, edit the generated config and run `miftah validate` followed by `miftah doctor`. Do not add the upstream token-cache path as a Miftah secret provider and do not copy a cache between profiles.

### OAuth versus service accounts

OAuth is convenient for an interactive desktop user, but the upstream-owned cache can make two profiles look separate in Miftah while they still share one Google login under the same operating-system user. Do not claim deterministic multi-profile account isolation from different client-secrets files alone. Use separate OS-level homes/profile isolation only when you understand the upstream's cache layout and lifecycle.

For unattended or deterministic automation, the upstream also documents a service-account path through `GSC_CREDENTIALS_PATH` with `GSC_SKIP_OAUTH=true`. A service account avoids browser consent and a user refresh-token cache, but it must be granted access to each Search Console property and its private key needs stricter file handling. This remains a manual configuration path in the pilot; Miftah does not import, display, or rotate the key file.

## Adding another built-in adapter

A future adapter must be reviewed in-tree and must state all contract fields. It must pin its launch artifact, keep arguments as arrays with no command shell, expose only bounded metadata diagnostics, retain manual setup, and document any gap in identity or lifecycle ownership. Provider API reimplementations, arbitrary executable definitions, cache scraping, hidden token migration, and silent destructive enablement do not belong in this catalog.
