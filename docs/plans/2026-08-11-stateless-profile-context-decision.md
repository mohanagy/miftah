# Stateless Profile Context Decision

Status: Accepted. Issues #376 and #377 implement the trusted authentication and production profile-context primitives; transport negotiation and the remaining protocol-era integrations stay in the follow-ups below. The executable model in `tests/prototypes` remains non-shipping research.

Issues: [#362](https://github.com/mohanagy/miftah/issues/362), [#364](https://github.com/mohanagy/miftah/issues/364), [#376](https://github.com/mohanagy/miftah/issues/376), [#377](https://github.com/mohanagy/miftah/issues/377)

Specification sources: [MCP 2026-07-28 announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [SEP-2575](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575), and [SEP-2567](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2567)

## Decision

Modern stateless Miftah requests will not read or mutate an implicit active profile. An account-sensitive request will carry an explicit, opaque profile-context handle that was minted by Miftah and is visible to the model as request data. Miftah will validate that handle together with verified authentication context on every use before routing, policy, approval, OAuth, audit, or upstream work begins.

The authenticated binding must include an unforgeable per-chat context claim in addition to issuer, subject, and audience. MCP `clientInfo` identifies client software and is not an authenticated or unique chat identity. An arbitrary HTTP header, request `_meta`, tool argument, or model-generated conversation identifier is also insufficient.

The selected handle format is a short-lived, authenticated-encrypted token containing:

- a version, deployment identifier, and authenticated key epoch;
- a random context identifier;
- the selected named profile;
- a keyed digest of issuer, subject, audience, and trusted chat context;
- issuance and expiry times.

Every production instance for one deployment must share the active sealing-key epoch and a bounded revocation backend. Resolution fails closed if required key or revocation state is unavailable. Audit records use a separate keyed correlation derived from the internal identifier; the bearer itself is never logged, exported, diagnosed, or forwarded upstream.

The non-secret envelope carries the version and key-epoch identifier so an instance can select the candidate key before opening the authenticated ciphertext. Both values, plus the deployment identifier, are authenticated as additional data. A deployment keyring has exactly one active epoch for minting and may retain explicitly configured previous epochs for resolution only. The overlap lasts no longer than the maximum handle lifetime plus bounded clock skew; after that window the previous key is removed and its remaining handles fail closed. Unknown, disabled, future, or malformed epochs are invalid. Rotation changes the active epoch atomically across instances: new handles use only the new epoch, while unexpired old handles resolve only during the declared overlap. `ProfileContextHandleService` remembers the highest active epoch and its key only within one process, so restarts reset that defense. The deployment key manager must reject epoch rollback and same-epoch key replacement at the source, and operators must alert on any observed epoch regression.

This keeps the one-connector, named-account experience for hosts that can provide the trusted chat binding. Until a host can do so, modern stateless mode must use an operator-locked/profile-scoped endpoint or require an explicit profile for each call. It must not claim chat-scoped switching. Legacy stdio and session-aware HTTP retain their current connection-bound behavior during the documented compatibility window.

## Why this is necessary

MCP 2026-07-28 removes `initialize`, `initialized`, and `Mcp-Session-Id`. Each request carries protocol and client metadata, and any request may land on any instance. The specification recommends explicit application handles rather than transport-hidden state.

Miftah currently creates one complete runtime per Streamable HTTP session. That runtime owns more than transport state:

| Current owner | State coupled to the session/runtime | Modern treatment |
| --- | --- | --- |
| `HttpServerHost` | `Mcp-Session-Id`, transport, idle timer, runtime admission and cleanup | Modern requests have no session record or sticky routing. Legacy records remain separate. |
| `ProfileManager` | active profile, selection revision/source, confirmation, runtime lock, and lease | Capture immutable selection from the verified handle for each request. No modern mutable active profile. |
| `MiftahServer` | approval session, profile confirmation proofs, active routing profile, Roots snapshot, subscriptions, catalog invalidation, and restart coordination | Make request-bound state explicit; move streaming/subscription behavior to modern protocol contracts; never infer a profile from prior calls. |
| `ApprovalStore` | pending/approved records and bearer bindings tied to a generated session ID | Bind approval/MRTR state to authenticated request/context IDs and the exact profile handle, operation, and principal. |
| OAuth and identity runtime | provider flows, identity cache, and persisted bindings constructed with the runtime | Keep issuer/principal/profile boundaries explicit; do not put OAuth codes, tokens, or secrets in the handle. |
| Upstream managers | process/session ownership, profile concurrency slots, health, and lifecycle listeners | Resolve the profile first, then acquire a profile-scoped upstream through deployment-safe lifecycle ownership. |
| Routing, policy, and audit | decisions derived from the captured profile and request evidence | Verify the handle before routing and record only safe profile/correlation metadata. |

Protocol statelessness therefore does not mean Miftah can delete application state. It means that state cannot remain hidden behind a transport session.

## Rejected alternatives

### Mutable process or durable default

Rejected. A switch in one chat would change later calls from another chat or instance. A default is safe only when configured as an operator lock, never as recovery for missing request context.

### Keying by `clientInfo`

Rejected. `clientInfo` names client software, can be shared by many chats and users, and is carried by the client. It cannot authenticate or isolate a conversation.

### Sticky load balancing or an in-memory instance map

Rejected for modern mode. It recreates protocol sessions operationally, loses state after instance failure, and violates the round-robin deployment goal.

### Plain profile names or unvalidated routing headers

Rejected as a substitute for context. Names and headers may inform an explicit request but do not prove the caller, chat, deployment, expiry, or revocation state. `Mcp-Method` and `Mcp-Name` must be checked against the JSON-RPC body and are not account credentials.

### Principal-only handle binding

Rejected. Two chats for the same authenticated subject would still be able to consume each other's handles. The binding must include a trusted per-chat claim. If the host cannot supply one, Miftah must expose the compatibility exception rather than weaken isolation.

### Opaque random identifier with only instance-local storage

Rejected. It cannot survive round-robin routing or an instance restart. A deployment-wide store is viable, but the selected sealed handle keeps ordinary resolution self-contained while the shared backend is limited to revocation/key-epoch safety.

## Request and lifecycle contract

1. The modern profile-selection operation authenticates the request and requires the trusted chat binding.
2. Miftah mints a short-lived handle for one named profile. The handle is a profile selector, not proof that an operation is authorized.
3. Every account-sensitive call carries the exact handle as a model-visible reserved argument or equivalent method parameter. Miftah strips it before forwarding upstream.
4. The receiving instance authenticates first, reads the bounded non-secret version/epoch envelope, selects an enabled resolution-only or active key from the deployment keyring, authenticates and opens the ciphertext, checks deployment/key epoch, compares the full authenticated binding in constant time, checks profile existence, expiry, and revocation, and only then enters routing and policy evaluation.
5. A switch mints a replacement handle. The prior handle is revoked only after the profile-transition audit commits; an audit failure leaves the old context usable and does not disclose the replacement.
6. Expiry is exact. Renewal requires the current valid handle and the same authenticated binding. Revocation is deployment-wide and bounded by the handle expiry.
7. Missing, malformed, tampered, mismatched, expired, revoked, or unavailable context returns a fixed safe error. No error includes the handle, decrypted payload, identity claims, or private account data.

Replay of a valid handle within its bound chat is possible by design: it selects a profile but does not authorize or make an operation idempotent. Approvals, MRTR responses, destructive actions, and retried calls must retain their own exact request/operation bindings.

## Executable prototype evidence

`tests/stateless-profile-context-prototype.test.ts` exercises a deliberately non-exported model under `tests/prototypes`. The npm `files` allowlist excludes tests, so this code cannot enter the published package.

The model proves:

- work and personal chats for the same subject retain independent profile choices while requests alternate between two instances;
- either chat's handle fails under the other chat's authenticated context;
- cross-principal and cross-deployment use fails closed;
- expiry and deployment-wide revocation apply on every instance;
- the encrypted handle contains neither the profile nor subject in plaintext;
- returned results and fixed errors contain only a keyed audit correlation, never the capability bearer.

The prototype alone does not prove production key custody, distributed-store availability, or real host chat claims. The production implementation and its real SDK integration tests now cover schema threading, two-instance handle use, chat isolation, transition revocation, deterministic tool discovery, and bearer stripping; a production host still owns trusted claim verification, key custody, and deployment-wide revocation availability.

## Implementation follow-ups

- [#376](https://github.com/mohanagy/miftah/issues/376): completed the verified issuer/subject/audience/chat binding and safe host fallback.
- [#377](https://github.com/mohanagy/miftah/issues/377): implements production sealing, key epochs, revocation, schema threading, request-scoped resolution, and legacy separation.
- [#363](https://github.com/mohanagy/miftah/issues/363): negotiate modern stateless and legacy session-aware protocol eras before selecting either runtime path.
- [#365](https://github.com/mohanagy/miftah/issues/365): validate standard MCP routing headers independently of profile-context resolution and make catalogs deterministic/cacheable.
- [#366](https://github.com/mohanagy/miftah/issues/366): bind MRTR confirmations and cancellation to the exact authenticated context, profile handle, and request.
- [#367](https://github.com/mohanagy/miftah/issues/367): preserve issuer-bound OAuth credentials and keep OAuth secrets outside handles.
- [#368](https://github.com/mohanagy/miftah/issues/368): publish exact host/version/transport evidence and the fallback boundary.

## Required compatibility and security tests

- Modern requests alternate instances with the same handle and never depend on `Mcp-Session-Id`.
- Two chat claims for one subject cannot resolve, revoke, renew, approve, or cancel each other's state.
- Issuer, subject, audience, chat, deployment, key epoch, profile, expiry, and revocation mismatches fail before upstream acquisition.
- Missing trusted chat identity does not fall back to `clientInfo`, defaults, prior selections, persisted state, or routing hints.
- Concurrent switch/call and revoke/call races are linearized around the audited transition.
- Tool, resource, and prompt catalogs do not vary with prior request state and remain scoped by current authentication/policy.
- Errors, logs, diagnostics, audit exports, crash output, and upstream arguments contain no handle.
- Existing stdio and supported legacy Streamable HTTP sessions retain their current selection, approval, lock, lease, OAuth, cancellation, subscription, and shutdown behavior.
- Packaged builds pass real modern and legacy client interoperability on Linux, macOS, and Windows before release claims change.

## Stop rule

Do not enable modern chat-scoped profile switching if a supported host lacks a trusted per-chat authentication claim, if any instance cannot validate the same key epoch/revocation state, or if cross-chat/adversarial packaged tests are incomplete. Ship the documented profile-scoped/locked fallback and keep the legacy path instead.
