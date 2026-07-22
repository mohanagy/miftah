# OAuth support and compatibility

Miftah is an MCP wrapper and credential-profile boundary. Version 3 enables a deliberately narrow standards-compatible remote OAuth flow while keeping every credential bound to one exact configuration, profile, upstream, resource, and issuer.

Miftah performs protected-resource and authorization-server discovery, browser authorization, a literal-loopback callback, authorization-code exchange, refresh, and bearer injection only for an exact configured HTTPS Streamable HTTP connection. It requires PKCE `S256`, the OAuth `resource` parameter, and authorization-server support for the RFC 9207 `iss` response parameter. Discovery or callback data that does not match the configured resource and issuer fails closed.

Miftah does not support OAuth for every MCP server or provider. It does not guess private endpoints, scrape provider caches, automate local STDIO providers' custom login flows, accept passwords or browser cookies as OAuth state, or treat a valid token as proof that the correct account was selected. Revocation and operator lifecycle commands are not implemented in this release.

The [OAuth and local Console design delta](oauth-console-threat-model.md) records the enforced OAuth security controls, residual risks, and the separate no-go gates for the future local Console.

## Support matrix

| Support class | Transport and current ownership | Operator fallback |
| --- | --- | --- |
| Standards-compatible remote HTTP MCP OAuth | Enabled for an exact HTTPS `streamable-http` connection whose protected-resource and authorization-server metadata satisfy Miftah's discovery checks. Miftah owns browser authorization, the bounded loopback callback, exchange, vault storage, refresh, and bearer injection. | If the server does not advertise the required standards, use its documented API-key, static-header, or provider-owned flow. |
| Provider-adapter-backed local or non-standard OAuth | No provider-adapter API exists today. Miftah does not automate a provider-specific browser flow, private callback convention, or token-store format. | Complete the upstream's documented login and configuration; Miftah can launch, redact, and diagnose that configured upstream. |
| Upstream-owned or manual credentials | `stdio`, legacy `sse`, and remote Streamable HTTP headers remain supported. The upstream/provider owns login, callback, token cache, refresh, reauth, and revoke. | Complete the provider-owned login, supply its documented credential path, environment value, or static secret reference, then run `miftah validate` and `miftah doctor`. |
| Unsupported authentication patterns | Provider passwords, browser cookies, and arbitrary third-party token caches are not a supported Miftah-managed OAuth mechanism. Miftah does not own, parse, scrape, import, replay, or lifecycle-manage provider passwords, browser cookies, or arbitrary third-party token caches as OAuth artifacts. | Use a provider-supported mechanism, or leave that upstream unconfigured when its only path depends on opaque private state. |

`miftah doctor` validates configuration and reachable upstreams. It does not prove that provider consent, scopes, or account identity are correct. OAuth-specific doctor and lifecycle commands belong to the separate lifecycle-management milestone.

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

## Authorization and credential lifecycle

On the first protected request, Miftah starts a single-use callback listener on literal `127.0.0.1` with a dynamic port and exact `/oauth/callback` path, then opens the system browser without a command shell. The callback accepts one exact state and issuer, returns fixed non-reflective pages, and closes after success, failure, cancellation, or its bounded timeout. Authorization URLs, callback parameters, codes, tokens, client secrets, and raw provider errors do not enter configuration, audit records, or diagnostics.

Credentials are stored only through the platform OS vault adapter. The local metadata file contains non-secret connection state and is written under the platform user-state directory:

- macOS: `~/Library/Application Support/Miftah/oauth-connections.json`
- Windows: `%LOCALAPPDATA%\Miftah\oauth-connections.json`
- Linux: `$XDG_STATE_HOME/miftah/oauth-connections.json`, or `~/.local/state/miftah/oauth-connections.json`

Before reuse, Miftah refreshes an expiring credential against freshly validated discovery metadata. Refresh-token rotation and dynamic client registration remain in the same exact vault binding. A failed refresh or authorization does not fall through to another profile, reuse another connection's token, or expose provider output; it returns a stable OAuth error and requires a new authorization attempt.

The exact OAuth-bound Streamable HTTP transport receives the profile-bound OAuth client provider. Other remote transports continue to use only explicitly configured static headers. Existing environment, dotenv, keychain, 1Password, and explicit local secret-provider plugins do not become generic OAuth caches.

## Local and provider-owned OAuth

For a **Google Search Console-style local OAuth** upstream, such as a local `uvx mcp-search-console` process configured with a provider client-secrets file, complete the provider's login first. Configure only the documented client-secret file path, environment value, or other upstream input; then let that upstream create and maintain its own local credential cache. **Miftah must not scrape, copy, or manage that upstream token cache.**

The same rule applies when Sentry or another upstream MCP server owns consent, redirects, or cached tokens. Miftah may pass an explicit configured path or secret reference to the child and redact resolved values. It does not reinterpret an opaque provider cache as a native Miftah OAuth connection.

## Identity boundary

Miftah's optional identity verifier is independent of OAuth. Its meaningful lifecycle states include `not-verified`, `verified`, `expired`, and `unsupported`; the identity evidence comes from an explicitly configured bounded upstream-tool probe, not an OAuth callback. **OAuth success, token validity, and granted scopes are not account authorization.** A valid provider token can still belong to the wrong human, organization, or profile, so protected write/destructive operations still need the configured routing, policy, approval, and identity controls.

## Configuration and public API boundary

Version 3 adds `oauth.connections` as non-secret public configuration. `OAuthConfig` and `OAuthConnectionConfig` remain declarative types; browser, callback, credential-store, and token values are internal runtime boundaries and are not public library APIs.

See [configuration](config.md#remote-upstream-transports), [security](security.md), and [architecture](architecture.md) for the corresponding transport, redaction, and public-API boundaries.
