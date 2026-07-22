# OAuth support and compatibility

Miftah is an MCP wrapper and credential-profile boundary. Version 3 enables a deliberately narrow standards-compatible remote OAuth flow while keeping every credential bound to one exact configuration, profile, upstream, resource, and issuer.

Miftah performs protected-resource and authorization-server discovery, browser authorization, a literal-loopback callback, authorization-code exchange, refresh, and bearer injection only for an exact configured HTTPS Streamable HTTP connection. It requires PKCE `S256`, the OAuth `resource` parameter, and authorization-server support for the RFC 9207 `iss` response parameter. Discovery or callback data that does not match the configured resource and issuer fails closed.

Miftah does not support OAuth for every MCP server or provider. It does not guess private endpoints, scrape provider caches, automate local STDIO providers' custom login flows, accept passwords or browser cookies as OAuth state, or treat a valid token as proof that the correct account was selected. Operator lifecycle commands manage only Miftah's exact local binding and vault credential; `auth disconnect` does not claim provider-side token revocation.

The [OAuth and local Console design delta](oauth-console-threat-model.md) records the enforced OAuth security controls, residual risks, and the separately launched local Console control-plane boundary. Run `miftah dashboard` for the optional browser-local UI, or `miftah console --config <file>` for the API-only compatibility surface.

## Support matrix

| Support class | Transport and current ownership | Operator fallback |
| --- | --- | --- |
| Standards-compatible remote HTTP MCP OAuth | Enabled for an exact HTTPS `streamable-http` connection whose protected-resource and authorization-server metadata satisfy Miftah's discovery checks. Miftah owns browser authorization, the bounded loopback callback, exchange, vault storage, refresh, and bearer injection. | If the server does not advertise the required standards, use its documented API-key, static-header, or provider-owned flow. |
| Provider-adapter-backed local or non-standard OAuth | The built-in [Google Search Console pilot](provider-adapters.md#google-search-console-pilot) launches an exact-pinned local upstream and publishes its ownership contract. OAuth, browser handoff, token cache, reauthentication, and revocation remain upstream/manual-owned; this is not native Miftah OAuth. | Complete the upstream's documented login and configuration. The typed adapter supplies bounded launch and safe health metadata without cache access. |
| Upstream-owned or manual credentials | `stdio`, legacy `sse`, and remote Streamable HTTP headers remain supported. The upstream/provider owns login, callback, token cache, refresh, reauth, and revoke. | Complete the provider-owned login, supply its documented credential path, environment value, or static secret reference, then run `miftah validate` and `miftah doctor`. |
| Unsupported authentication patterns | Provider passwords, browser cookies, and arbitrary third-party token caches are not a supported Miftah-managed OAuth mechanism. Miftah does not own, parse, scrape, import, replay, or lifecycle-manage provider passwords, browser cookies, or arbitrary third-party token caches as OAuth artifacts. | Use a provider-supported mechanism, or leave that upstream unconfigured when its only path depends on opaque private state. |

`miftah doctor` validates configuration and reachable upstreams. It does not prove that provider consent, scopes, or account identity are correct. Use the explicit connection and auth commands below for native-OAuth lifecycle state.

## Configuration

An OAuth connection is version-3 non-secret configuration. Its key is an opaque `oauthconn:<uuid>` reference, and its value binds exactly one profile/upstream pair:

```json
{
  "version": "3",
  "name": "remote-service",
  "defaultProfile": "work",
  "upstream": {
    "transport": "streamable-http",
    "url": "https://mcp.example.com/mcp"
  },
  "profiles": {
    "work": {}
  },
  "oauth": {
    "connections": {
      "oauthconn:8c08de29-46cc-4a70-8528-11b9da0382c5": {
        "profile": "work",
        "upstream": "default",
        "resource": "https://mcp.example.com/mcp",
        "issuer": "https://auth.example.com",
        "clientRegistration": "dynamic",
        "scopes": ["mcp:read"]
      }
    }
  }
}
```

`clientRegistration` must use exactly one reviewed mode:

- `pre-registered:<client-id>` uses an operator-created public client identifier.
- `client-id-metadata:<https-url>` uses that complete HTTPS metadata-document URL as the client identifier, and requires advertised Client ID Metadata Document support.
- `dynamic` uses Dynamic Client Registration only when discovery advertises a secure registration endpoint.

Configuration cannot contain an access token, refresh token, client secret, callback setting, or `Authorization` header for the same profile/upstream. Static `Authorization` headers on that exact profile/upstream are rejected rather than being merged with native OAuth.

## CLI setup and recovery

Connection setup is plan-first. This command reads and validates the configuration, migrates a supported v1/v2 shape in memory, derives the exact resource from the selected upstream, and prints a safe plan without writing:

```sh
miftah connection add --config remote.json \
  --profile work --upstream default \
  --issuer https://auth.example.com \
  --client-registration dynamic \
  --scope mcp:read
```

The report contains a generated opaque connection reference. Review it, then repeat the command with that exact `--connection oauthconn:<uuid>` plus `--write`. The write revalidates the exact captured source, refuses symlinks and concurrent replacement, publishes a unique `remote.json.miftah-backup-<uuid>` recovery copy, atomically installs the candidate without overwriting another file, and writes the configured audit journal. It never resolves a credential or starts an upstream. Stop active clients before restoring a backup manually, then run `miftah validate --config remote.json` before restarting them.

Use the lifecycle commands after the binding exists:

```sh
miftah connection list --config remote.json
miftah connection status --config remote.json --connection oauthconn:<uuid>
miftah connection test --config remote.json --connection oauthconn:<uuid>
miftah auth connect --config remote.json --connection oauthconn:<uuid>
miftah auth reauth --config remote.json --connection oauthconn:<uuid>
miftah auth disconnect --config remote.json --connection oauthconn:<uuid>
```

`connection list` and `connection status` expose only non-secret binding, credential-state, expiry, and coarse identity-state fields. `connection list --client <claude-desktop|claude-code|cursor|vscode|all>` additionally prints copyable client snippets and never edits a client configuration. `connection test` uses an existing credential and returns `OAUTH_INTERACTIVE_REQUIRED` instead of opening a browser. `auth connect` opens the system browser only if authorization is required. `auth reauth` deliberately ignores the old token for the new flow but retains it in the vault until replacement succeeds. Add `--non-interactive` to connect or reauth in headless automation; a required browser flow then fails with the same typed diagnostic.

`auth disconnect` deletes only the exact local vault credential and marks its local state disconnected. It does not call an undocumented provider revocation endpoint. Revoke provider access separately when the provider offers that control. An unavailable native vault returns `OAUTH_SECURE_STORE_UNAVAILABLE`; expired state is reported as `expired`; unsupported discovery/registration and identity mismatch retain their stable typed diagnostics. No command prints tokens, callback values, raw provider responses, or secret-bearing errors.

## Authorization and credential lifecycle

On the first protected request, Miftah starts a single-use callback listener on literal `127.0.0.1` with a dynamic port and exact `/oauth/callback` path, then opens the system browser without a command shell. The callback accepts one exact state and issuer, returns fixed non-reflective pages, and closes after success, failure, cancellation, or its bounded timeout. Authorization URLs, callback parameters, codes, tokens, client secrets, and raw provider errors do not enter configuration, audit records, or diagnostics.

Credentials are stored only through the platform OS vault adapter. The local metadata file contains non-secret connection state and is written under the platform user-state directory:

- macOS: `~/Library/Application Support/Miftah/oauth-connections.json`
- Windows: `%LOCALAPPDATA%\Miftah\oauth-connections.json`
- Linux: `$XDG_STATE_HOME/miftah/oauth-connections.json`, or `~/.local/state/miftah/oauth-connections.json`

Before reuse, Miftah refreshes an expiring credential against freshly validated discovery metadata. Refresh-token rotation and dynamic client registration remain in the same exact vault binding. A failed refresh or authorization does not fall through to another profile, reuse another connection's token, or expose provider output; it returns a stable OAuth error and requires a new authorization attempt.

The exact OAuth-bound Streamable HTTP transport receives the profile-bound OAuth client provider. Other remote transports continue to use only explicitly configured static headers. Existing environment, dotenv, keychain, 1Password, and explicit local secret-provider plugins do not become generic OAuth caches.

## Local and provider-owned OAuth

For Google Search Console-style local OAuth, the [Google Search Console pilot](provider-adapters.md#google-search-console-pilot) generates an exact-pinned local `uvx mcp-search-console@0.3.2` process configured with a provider client-secrets file. Complete the upstream's browser login on first use and let that upstream create and maintain its own local credential cache. **Miftah must not scrape, copy, or manage that upstream token cache.**

The same rule applies when Sentry or another upstream MCP server owns consent, redirects, or cached tokens. Miftah may pass an explicit configured path or secret reference to the child and redact resolved values. It does not reinterpret an opaque provider cache as a native Miftah OAuth connection.

## Identity boundary

Miftah's optional identity verifier is independent of OAuth. Its durable binding states are `verified`, `unverified`, `changed`, `expired`, and `unavailable`; live probe statuses include `not-verified`, `verified`, `expired`, and `unsupported`. This safe identity evidence comes from an explicitly configured bounded upstream-tool probe, not an OAuth callback. Miftah mirrors only a coarse state onto the exact OAuth connection record and never stores the fingerprint in OAuth credential metadata. **OAuth success, token validity, and granted scopes are not account authorization.** A valid provider token can still belong to the wrong human, organization, or profile, so protected write/destructive operations still need the configured routing, policy, approval, selection, and identity controls.

## Configuration and public API boundary

Version 3 adds `oauth.connections` as non-secret public configuration. `OAuthConfig` and `OAuthConnectionConfig` remain declarative types; browser, callback, credential-store, and token values are internal runtime boundaries and are not public library APIs.

See [configuration](config.md#remote-upstream-transports), [security](security.md), and [architecture](architecture.md) for the corresponding transport, redaction, and public-API boundaries.
