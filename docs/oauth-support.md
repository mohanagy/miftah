# OAuth support and compatibility

Miftah is an MCP wrapper and credential-profile boundary. It can carry explicitly configured credentials to an upstream, but it is not an end-to-end OAuth broker today.

Version 3 introduces a deliberately narrow OAuth connection core: strict non-secret `oauth.connections` bindings, canonical HTTPS resource checks, exact issuer/profile/upstream isolation, an OS-vault credential contract, and redacted lifecycle primitives guarded by a crash-released local transaction lock for each exact connection binding. It does **not** make native OAuth usable yet. A configured v3 OAuth connection stops at startup with `OAUTH_AUTHORIZATION_NOT_ENABLED` until the authorization engine is delivered.

**Miftah does not currently perform OAuth discovery, browser authorization, callbacks, token exchange, refresh, remote Authorization-header injection, or revocation.** `streamable-http` is a remote transport choice, not evidence that an upstream's OAuth flow is supported. **Miftah does not support OAuth for every MCP server or provider.**

This page is the public compatibility contract for OAuth-shaped upstream authentication. It distinguishes what operators can use now from the deliberately unimplemented work proposed in the OAuth roadmap. It does not authorize the runtime to begin managing provider credentials.

The [OAuth and local Console design delta](oauth-console-threat-model.md) defines the threat, protocol, token-handling, callback, and local-control-plane gates for that future work. It does not enable a browser flow or a Console.

## Support matrix

| Support class | Transport and current ownership | Operator fallback |
| --- | --- | --- |
| Standards-compatible remote HTTP MCP OAuth | v3 validates a non-secret profile/upstream/resource/issuer binding and has an internal secure-store lifecycle contract. Miftah has no enabled discovery, client-registration, browser, callback, exchange, header-injection, or revoke implementation yet. | Use the upstream's documented manual/pre-registered credential path and configured static headers, or wait for the enabled authorization engine. |
| Provider-adapter-backed local or non-standard OAuth | No provider-adapter API exists today. Miftah does not automate a provider browser flow, private callback convention, or token-store format. | Use the upstream's documented login and configuration; Miftah can launch, redact, and diagnose the configured upstream only. |
| Upstream-owned or manual credentials | `stdio`, legacy `sse`, and remote Streamable HTTP headers can be wrapped now. The upstream/provider owns login, callback, token cache, refresh, reauth, and revoke; Miftah only resolves explicit environment/header secret references and starts the upstream. | Complete the provider-owned login, supply its documented credential path, environment value, or static secret reference, then run `miftah validate` and `miftah doctor`. |
| Unsupported authentication patterns | Provider passwords, browser cookies, and arbitrary third-party token caches are not a supported Miftah-managed OAuth mechanism. Miftah does not own, parse, scrape, import, replay, or lifecycle-manage provider passwords, browser cookies, or arbitrary third-party token caches as OAuth artifacts. An operator can still pass an explicit value or path through ordinary `env`/`headers`/process configuration; that does not make it a supported OAuth flow. | Use a provider-supported mechanism, or leave that upstream unconfigured when its only path depends on opaque private state. |

`miftah doctor` can validate reachable configured upstreams and safe secret-provider availability. It does not prove that an OAuth browser flow, provider consent, refresh token, scope, or account binding is valid.

## Future standards-compatible remote HTTP contract

The intended native support class is deliberately narrow: a remote **HTTPS Streamable HTTP** MCP upstream that advertises the relevant standards. Local loopback HTTP remains a development exception for transport validation; it is not a claim that cleartext remote OAuth is safe. Native support is not enabled until the profile-bound connection model and authorization engine are delivered.

When it is implemented, the contract must be explicit and profile-bound:

- **Discovery:** obtain protected-resource metadata and authorization-server metadata from the upstream's advertised endpoints; do not guess provider-specific endpoints.
- **Client registration:** prefer an operator pre-registered client, then a safely hosted Client ID metadata document when available; use dynamic client registration only when the authorization server advertises it and the security review permits it.
- **Authorization and callback:** send the OAuth `resource` indicator, use PKCE `S256` and a state value, and receive a loopback callback only in a bounded local flow. Authorization URLs, callback parameters, codes, and tokens must not enter audit records, diagnostics, or configuration files.
- **Refresh, reauth, and revoke:** store profile-bound credentials only in an approved secure store; refresh before use when permitted, require explicit reauth when refresh fails, and call revoke only when the authorization server advertises a safe revoke endpoint.
- **Identity evidence:** treat an OAuth token as permission to call a service, not proof of the selected account. A configured identity probe remains the evidence for an account fingerprint.

The repository includes a deterministic, loopback-only compatibility probe in `tests/remote-oauth-compatibility.test.ts`. It exercises protected-resource discovery, authorization-server discovery, advertised dynamic registration, PKCE, authorization-code exchange, and a bearer-authenticated MCP retry using fixture-only opaque values. It proves that the installed MCP SDK can perform that standards-shaped sequence; it does **not** mean that Miftah currently owns or exposes the flow in production.

## Local and provider-owned OAuth

For a **Google Search Console-style local OAuth** upstream, such as a local `uvx mcp-search-console` process configured with a provider client-secrets file, complete the provider's login first. Configure only the documented client-secret file path, environment value, or other upstream input; then let that upstream create and maintain its own local credential cache. **Miftah must not scrape, copy, or manage that upstream token cache.**

The same rule applies to providers such as Sentry when their upstream MCP server owns consent, redirects, or cached tokens. Miftah may pass an explicit configured path or secret reference to the child, isolate explicitly configured files for a local process when the existing isolation contract allows it, and redact resolved values. It must not infer an account, open a browser on behalf of the upstream, or reinterpret an opaque provider cache.

## Identity boundary

Miftah's optional identity verifier is independent of OAuth. Its meaningful lifecycle states include `not-verified`, `verified`, `expired`, and `unsupported`; the state is based on an explicitly configured bounded upstream-tool probe, not an OAuth callback. **OAuth success, token validity, and granted scopes are not account authorization.** A provider can issue a valid token for the wrong human, organization, or profile, so write/destructive account checks still need configured identity evidence and policy controls.

## Configuration and public API boundary

Current `UpstreamConfig` supports `stdio`, `streamable-http`, and legacy `sse` transports plus explicit `headers`; version 1 also retains the documented `http` alias. Version 3 adds `oauth.connections`: an opaque generated connection reference maps only to a profile, upstream, canonical resource, exact issuer, non-secret client-registration handle, and bounded scopes. It cannot contain an access token, refresh token, client secret, callback setting, or Authorization header. Static `Authorization` headers on that exact profile/upstream are rejected rather than being merged with native OAuth.

**Remote transports use configured static `headers` only; they do not pass an OAuth client provider to the MCP SDK.** `OAuthConfig` and `OAuthConnectionConfig` are public non-secret configuration types, not a browser/client-provider/token-lifecycle API. Existing environment, dotenv, keychain, 1Password, and explicit local secret-provider plugins resolve configured values; they do not become a generic OAuth cache.

**The remaining OAuth runtime surface must be additive, versioned, and paired with an explicit migration and release note.** It must add discovery, browser/callback handling, token exchange, safe header injection, CLI/doctor diagnostics, lifecycle recovery, and backward compatibility without weakening the v3 binding or secure-store invariants.

## Operator decision guide

1. If the upstream accepts a stable API key or bearer value, configure an explicit secret reference in `headers` or `env`, then validate and doctor the exact configuration.
2. If the upstream owns a local OAuth login, complete that login under the upstream's instructions and configure only its documented input. Treat the upstream's token cache as its private state.
3. If the upstream advertises standards-compatible remote OAuth, do not assume Miftah can currently drive it. v3 can validate a connection declaration but intentionally fails closed before authorization; use the upstream's supported manual/pre-registered alternative until Miftah ships the enabled authorization engine.
4. If the provider requires passwords, browser cookies, or an undocumented token cache, do not treat it as a Miftah-managed OAuth flow. Use a provider-supported mechanism or leave the upstream unconfigured; an explicit operator-provided value does not make Miftah responsible for that credential lifecycle.

See [configuration](config.md#remote-upstream-transports), [security](security.md), and [architecture](architecture.md) for the corresponding current transport, redaction, and public-API boundaries.
