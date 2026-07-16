# OAuth broker and local Console design delta

> **Status:** Design-only security decision for [#80](https://github.com/mohanagy/miftah/issues/80). It is a forward-looking delta to the maintainer-authored [threat model](threat-model.md) published for [#37](https://github.com/mohanagy/miftah/issues/37), not evidence that the independent review is complete.

No production OAuth broker, Console, callback listener, or token store exists in this release. The current wrapper still supports only explicit static headers or provider-owned/upstream-owned authentication as described in [OAuth support](oauth-support.md). This document sets the conditions that must be met before an OAuth or Console implementation can be proposed.

The design follows the [MCP Authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization), [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252) for native-app browser flows, [RFC 9207 `iss`](https://www.rfc-editor.org/rfc/rfc9207) authorization-response issuer identification, and [RFC 9700](https://www.rfc-editor.org/rfc/rfc9700) for OAuth security practice. If a provider or SDK cannot meet the required properties below, Miftah must not approximate them with a provider-specific shortcut.

## Scope and hard boundaries

- Native OAuth is a future profile-bound connection capability for standards-compatible remote HTTPS Streamable HTTP MCP resources only.
- An optional local Console is a future operator experience over the same connection and configuration services. It is not a hosted service, cloud token sync system, embedded login browser, or background daemon.
- The future Console control API is distinct from the MCP /mcp endpoint. It cannot share a listener, session model, bearer, or authorization decision with a client-facing MCP transport without a separately reviewed design.
- A Console cannot mutate an already-running Claude Desktop or other STDIO client session. Changes apply to new or explicitly restarted sessions until a separately designed broker or IPC capability exists.
- This design does not make upstream-owned local OAuth, such as Google Search Console-style local MCP processes, Miftah-managed. Their documented login, callback, and cache remain upstream private state.

## Protocol go/no-go decision

- **GO: standards-compatible HTTPS Streamable HTTP MCP** only when the resource exposes protected-resource metadata and an authorization server that supports the required discovery and authorization-code flow. The client must parse a `WWW-Authenticate` `resource_metadata` challenge and use it before any well-known fallback; only an absent metadata URL permits the MCP-specified well-known lookup. It must support both OAuth Authorization Server Metadata and OpenID Connect Discovery, bind the selected issuer and canonical resource, use the OAuth resource indicator at authorization and token exchange, and request only the documented least-privilege scopes.
- The authorization request must use a system browser, authorization code flow, PKCE S256, transaction state, issuer and resource binding, and exact redirect validation. The selected server metadata must prove that `code_challenge_methods_supported` includes `S256` and that RFC 9207 issuer responses are supported. Miftah must not use an embedded webview, implicit grant, password grant, wildcard redirect, prefix redirect, or a redirect handler shared with the MCP endpoint.
- The callback must contain exactly one `iss` and compare it by exact string match with the issuer selected from metadata. A callback without that `iss` is a no-go, as is a duplicate or mismatched value; state alone is not issuer provenance. The token exchange must use only the endpoint from that exact issuer's discovered metadata.
- Client registration must prefer a pre-registered client. A verified Client ID Metadata Document is allowed only when `client_id_metadata_document_supported` is `true`. Dynamic client registration is allowed only when `registration_endpoint` is advertised by the selected authorization server and explicitly permitted by the approved security design; absence or inconsistency is a refusal, not a fallback to guessed endpoints.
- A profile cannot enable native OAuth while the same upstream has a static `Authorization` header. Configuration validation must require the operator to explicitly remove or migrate that header before native OAuth can be enabled; runtime code must never infer precedence between two bearer sources.
- **NO-GO: provider-specific, undocumented, or opaque OAuth conventions** including passwords, browser cookies, arbitrary token-cache formats, private callback contracts, HTTP remote OAuth, missing or inconsistent metadata, unsupported PKCE, or a flow that cannot bind issuer, resource, redirect, and profile. Miftah continues to offer only the provider-owned/manual credential fallback in those cases.
- A failed discovery, registration, callback, token exchange, refresh, revocation, or identity check must fail only the targeted connection and keep the existing profile policy, audit, routing, and static-header behavior unchanged. It must not silently substitute another profile, issuer, resource, or credential.

## Credential and data-handling invariants

OAuth access tokens and refresh tokens must not appear in configuration, audit events, diagnostics, logs, query strings, browser storage, or Console UI responses.

An authorization code can arrive only at the bounded callback and must be exchanged without being persisted, logged, audited, or rendered. The callback must return a fixed success/failure page with no code, token, scope, issuer, account, or provider response content.

- A future connection record may retain only non-secret identifiers needed for routing and diagnosis: profile, exact upstream, canonical issuer, canonical resource, requested/granted scope metadata when safe, lifecycle state, and a bounded identity-verification status. It must not retain raw authorization responses, raw account payloads, browser URLs, authorization codes, token values, client secrets, or unbounded provider errors.
- Credential material must be held only in a verified operating-system credential vault under a profile-and-resource-specific key. There is no fallback to JSON configuration, dotenv, audit records, browser local/session storage, a Console response, or a generic third-party cache. Missing secure storage is a no-go for native Miftah OAuth rather than a reason to weaken storage.
- One connection is bound to exactly one profile, upstream, issuer, and resource. Reauthentication, refresh, revoke, disconnect, and health operations must use that exact binding; no lookup may select an arbitrary credential based on a provider display name or active profile alone.
- Redaction must register future secret values before any lifecycle event, error mapping, audit scope, or support export can observe them. Stable error codes and high-level state are the only operator-facing failure evidence.

## Threats, required controls, and residual risks

| Threat and attacker goal | Required future controls | Residual risk and test evidence |
| --- | --- | --- |
| **Redirect mix-up or issuer substitution** — cause a valid browser result to be accepted for another authorization server or resource. | Discover protected-resource and authorization-server metadata from the selected HTTPS resource; bind transaction state to the canonical issuer, resource, redirect URI, profile, and upstream; require exactly one RFC 9207 `iss` that exactly matches the selected issuer before code exchange; reject changed metadata, issuer, audience, or redirect. | A malicious same-user process or trusted provider can still interfere outside Miftah authority. Tests must exercise alternate issuer/resource metadata, a callback where valid `state` accompanies a code from another issuer, a missing or duplicate `iss`, and distinct redirect registrations. |
| **Authorization-code or token replay** — reuse an intercepted code, callback, access token, or refresh token. | Use PKCE S256; keep a one-time, bounded transaction with single-use state and callback; exchange a code once; keep future credentials in secure storage; rotate/clear a failed or disconnected connection. | PKCE does not protect a compromised host or provider. Tests must prove a mismatched PKCE verifier, duplicate callback, reused code, expired state, and stale token are refused without output leakage. |
| **Cross-profile or cross-resource credential leakage** — use one account or token for another profile, upstream, issuer, or MCP resource. | Use an exact profile/upstream/issuer/resource connection key; reject ambiguous provider display names; keep refresh/revoke/health operations scoped to that key; require the later identity verifier to make account claims explicit. | A valid token is not account authorization. Tests must cover cross-profile refresh, resource substitution, profile switching during a flow, and an identity mismatch after connection. |
| **Browser CSRF or hostile local origin** — drive a local browser callback or Console mutation from an untrusted page. | Use high-entropy state, exact callback validation, a system browser, strict Host and Origin checks, explicit CSRF protection for every Console mutation, and bounded browser session lifetime. The Console must not use a query-string bearer or browser storage. | A same OS user is not a strong isolation boundary. Tests must reject missing/duplicate/mismatched state, hostile Origin/Host, cross-origin mutation, and stale browser sessions. |
| **Local network exposure and same-user control** — expose a loopback control service to LAN callers or let a local process reuse its control credential. | No Console listener may start until a separately approved bootstrap protocol can establish an invocation-bound, CSPRNG-backed, one-time browser session without query strings or browser storage. That future protocol must bind literal loopback, a short lifetime, exact Host/Origin validation, CSRF protection, bounded bodies/sessions/callback listeners/concurrency, and a control credential separate from the MCP bearer. | Loopback plus a future random credential does not defend against a hostile process running as the same OS user or a host administrator. Tests must demonstrate refusal of non-loopback binds, absent/forged Host/Origin, bootstrap replay, exhausted capacity, and use after expiry. |
| **Broker or IPC confusion** — claim that a Console can reconfigure or authorize an already-running client process. | Keep connection/configuration services explicit and transactional; require a separately designed, authenticated broker or IPC protocol before controlling another process; expose only safe restart-required guidance until then. | An operator still has to restart or reconnect a client for a changed connection to take effect. Tests must prove a Console change cannot alter an existing independent STDIO session. |

## Local control-plane separation

The current Streamable HTTP host accepts protocol clients at its fixed MCP endpoint and deliberately permits a missing Origin for non-browser MCP clients. A future Console is a browser-facing operator interface and therefore cannot reuse that permissive rule. Its design must require literal-loopback binding, exact Host and Origin validation for browser traffic, CSRF protection for every state-changing request, a short idle and absolute browser-session lifetime, and request and session limits before work is allocated.

A future control credential is not an OAuth token and must still never be placed in a query string, browser storage, log, audit event, diagnostic, or rendered response. Console implementation is NO-GO until its initial browser bootstrap has a separately approved security design. That design must specify how an invocation-bound, CSPRNG-backed, one-time browser session is established and expired without a cookie, URL token, localStorage value, or an unreviewed same-user IPC shortcut; it must then satisfy the focused tests below. This delta deliberately does not approve a bootstrap mechanism.

The Console may create or inspect a future connection record only through a typed local control service. It must not parse upstream-owned token caches, browser cookies, or provider-specific files, and it must not assume that the MCP serving endpoint can act as a control API. The UI can display only redacted connection state, selected profile/upstream, safe scope summaries, and restart-required guidance.

## Focused security test plan before implementation

| Test area | Required evidence before a production surface is added |
| --- | --- |
| metadata discovery | In-process HTTPS/loopback fixtures prove protected-resource and authorization-server metadata are canonical, issuer/resource-bound, and fail closed on missing, altered, or conflicting metadata. |
| PKCE verifier and state | A deterministic fixture proves `WWW-Authenticate` `resource_metadata` takes precedence over well-known fallback; OAuth Authorization Server Metadata and OpenID Connect Discovery are both attempted; missing `code_challenge_methods_supported` `S256`, issuer-response support, Client ID Metadata support, or an advertised DCR endpoint fails closed. It also proves PKCE S256, one-time state, state expiry, and a mismatched PKCE verifier are rejected without revealing codes or tokens. |
| redirect and callback | Exact redirect validation rejects a wrong host, path, port, duplicate parameter, duplicate callback, replayed code, alternate issuer, a callback without exactly one `iss`, or callback after listener expiry. A fixture where valid `state` accompanies a code from another issuer must refuse the exchange. |
| replay and lifecycle | Tests cover repeated exchange, token replay, refresh rotation, failed refresh, explicit reauth, disconnect, revoke capability absence, and secure-store unavailability with no fallback persistence. |
| cross-profile and resource isolation | Concurrent profiles, profile switching, same-provider different resources, and account identity mismatch must never select or reveal another connection. |
| CSRF, Host and Origin | Browser mutation tests reject missing/forged state, hostile Origin, malformed/duplicate Host, absent CSRF proof, and requests that attempt to reuse the MCP bearer. |
| request and session limits | Callback and Console tests prove bounded bodies, transaction count, session count, idle/absolute expiry, shutdown cleanup, and no listener remains after completion. |
| Console bootstrap | No Console listener may start before an approved bootstrap design exists. Once approved, fixtures must prove one-time invocation binding, CSPRNG generation, expiry, bootstrap replay refusal, no URL/cookie/localStorage/control-token delivery, and no use of the MCP bearer. |
| redaction | Assertions cover configuration, audit, diagnostics, logs, callback pages, browser-visible responses, support export, and exception paths for tokens, refresh tokens, codes, and control credentials. |
| static bearer collision | Configuration and runtime negative tests prove native OAuth is rejected while the same upstream retains a static `Authorization` header, and succeeds only after an explicit migration/removal with no ambiguous bearer precedence. |
| unsupported provider fallback | A Google Search Console-style local/upstream-owned flow and malformed remote metadata prove that Miftah leaves provider private state untouched and returns the documented no-go/manual fallback. |
| broker boundary | A real independent STDIO client proves that Console/configuration changes cannot mutate its already-running connection without a future authenticated IPC design. |

All tests must use fixture-only values and local fakes. They must not invoke a live provider, write a real token, relax redaction, skip a platform suite, or use a test-only production bypass.

## Implementation gates

Issue #80 does not authorize OAuth, credential-store, callback, Console, adapter, or broker implementation. Before any of those production changes begin, maintainers must have:

1. the external design-partner evidence required by [#25](https://github.com/mohanagy/miftah/issues/25) and the deliberate Console/TUI/no-UI decision in [#35](https://github.com/mohanagy/miftah/issues/35);
2. an independent-review process and public status under [#37](https://github.com/mohanagy/miftah/issues/37), with this delta reviewed and linked;
3. a versioned, profile-bound connection-record and secure-store contract; and
4. the focused test plan above implemented before each relevant runtime surface is enabled.

The no-go decision is a secure product outcome: users can continue to configure documented static credentials or let an upstream own its local OAuth lifecycle. No dashboard convenience claim overrides those boundaries.
