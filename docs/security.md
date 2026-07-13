# Security model

Miftah is a credential broker, so safe defaults are part of the product contract:

- credentials stay local and telemetry is disabled;
- plaintext secret references are disabled unless explicitly enabled;
- environment values are injected into child processes and never returned by management tools;
- upstream stderr, errors, diagnostics, audit entries, and tool results pass through redaction;
- profile switching can be disabled or locked to a single profile;
- destructive and ambiguous requests are not silently routed;
- audit records contain metadata, not sensitive payloads or arguments, by default;
- audit files and directories are owner-only where platform support permits it, and audit-write failures are explicit;
- durable active-profile state is opt-in, uses derived owner-restricted paths, and stores no credentials;
- MCP tool annotations are ignored for risk downgrades unless the operator explicitly trusts the configured upstream that supplied them;
- provider tokens should be separate, least-privilege tokens per account and risk level.

External secret providers execute only fixed programs with argument arrays and bounded stdout/stderr capture. Miftah does not expose provider output in an error, audit record, health entry, or doctor report. On Windows it resolves provider executables without current-directory lookup and uses a static System32 PowerShell launcher that joins a `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` Job Object before creating the provider. Timeout, cancellation, output-limit, or launcher termination closes that job and terminates ordinary provider descendants as well. This process-tree guarantee does not cover providers that intentionally escape through services, scheduled tasks, elevation brokers, or WMI process creation.

Profile credential isolation is a separate, opt-in boundary. On macOS and Linux it gives one profile/upstream target a marker-owned, owner-restricted runtime tree and copies only explicitly configured files from below the canonical configuration directory. Miftah never resolves, materializes, injects, or bind-mounts another profile's managed path. It does not make a hostile native STDIO process safe: a process running under the same OS user can still open another profile's absolute path. Stronger native containment needs a separate OS identity or a correctly configured OS sandbox.

Docker/Podman can provide a stronger file boundary only when the container receives the intended generated bind mounts and **no other host directories** that expose profile data. Read-only mounts are the default; an explicit writable mount weakens that boundary. Miftah rejects conflicting user mount/environment flags rather than attempting to merge them, and rejects explicit remote engine endpoints, contexts, and config-location overrides plus macOS Podman isolation. The default local daemon remains trusted operator infrastructure. Miftah rechecks managed paths before it returns argv, but a hostile same-user process can still race a path before Docker/Podman resolves it; argument arrays cannot provide an atomic path-to-daemon handoff. It treats stderr from an isolated child as sensitive and emits only a fixed redaction marker.

Windows profile credential isolation fails closed before it creates or copies a runtime file. Node's POSIX-style mode API does not establish or verify a restrictive Windows DACL, so pretending that `0600`/`0700` protects a Windows credential would be unsafe. This limitation does not affect Windows secret-provider process containment.

Audit writes default to fail-closed: Miftah verifies the configured sink before dispatch and refuses a request when the sink cannot be prepared. A terminal write can fail after an upstream side effect has completed, so a post-dispatch `AUDIT_WRITE_FAILED` has an indeterminate outcome and must not prompt a blind retry of a non-idempotent operation. An operator can set `audit.failureMode` to `"fail-open"` for availability-sensitive deployments; Miftah then preserves the request outcome but exposes a redacted `AUDIT_WRITE_FAILED` health entry. This mode trades complete auditability for availability.

An approval bearer is a short-lived capability for one pending, exact MCP operation, not a credential or proof of a human identity. Miftah binds it to the connection and target context, stores only keyed digests, and invalidates it on denial, consumption, expiry, or a new connection. Prefer MCP form elicitation when the client supports it. Do not copy a fallback bearer into logs, tickets, or another connection; approval audit events deliberately omit both the bearer and full operation arguments.

Active-profile state is configuration-owned: MCP callers can select a profile but never a scope or storage path. `workspace` and `global` storage require explicit opt-in, derive a config-identity-namespaced location, and reject arbitrary state paths. A record contains only a format version, scope, config identity, selected profile, and timestamp; it never contains a secret, raw config path, provider output, or other MCP request data. Miftah writes it through a synced temporary file and atomic rename, applies owner-only permissions where supported, and reports a safe write failure without changing the in-memory selection. A configured profile lock wins over stored state; corrupt, stale, or unreadable state falls back safely and exposes only a stable diagnostic code.

Runtime profile locks and leases are connection-bound controls, not credentials or identity proof. A runtime lock or confirmation does not authenticate a human, and a lease never grants access to a differently routed profile. Miftah clears runtime locks and leases at a new connection boundary and never writes them to durable profile state. `security.lockToProfile` is operator-controlled and stronger than the optional MCP lock tools; clients cannot remove it. When fail-closed dedicated profile audit recording fails, Miftah rolls back the related profile mutation rather than retaining an unaudited switch, lock, or unlock.

The explicit runtime configuration is trusted operator input; workspace routing metadata is not. Project markers cannot inject configuration because their only accepted shape maps the configured wrapper name to an already-known profile. They cannot add credentials, environment variables, headers, upstreams, policies, audit controls, or secret references. Miftah reads only named, bounded metadata files within the applicable working-directory/root boundary and does not scan arbitrary project content.

MCP `tools/list` annotations are behavioral hints supplied by the upstream, not proof of safety. Miftah ignores them by default. An operator may set `trustToolAnnotations: true` only on the exact base upstream declaration they trust; a profile override cannot change that decision. Even for a trusted upstream, missing or contradictory hints never reduce risk, and `idempotentHint`/`openWorldHint` never lower it. Miftah records only the resulting classification source and confidence in route preview and audit data, never raw annotation objects.

Routing evidence is deliberately narrower than routing context. It is passed through audit redaction before it reaches a client or JSONL record, strips URI userinfo/fragments and redacts URI query values, and never contains the raw `MIFTAH_PROJECT` value or arbitrary project file content. An unrecognized environment profile or ambiguous matching rules fails closed instead of selecting an account; standard project-marker discovery deterministically uses the nearest valid marker. Profile hints also cannot satisfy an explicit-rule requirement for destructive operations.

Miftah cannot reduce privileges granted by a provider token. A read-only Miftah policy is a local blocklist, not a replacement for provider-side scopes. Avoid putting real credentials in examples, commits, or support logs.

`init` never asks for or echoes a secret value: its wizard accepts variable names and validated endpoint/header metadata only. Generated provider examples contain `${ENV_NAME}` references, and client snippets are printed for explicit copy rather than written into host configuration files. For exact preset pins, GitHub tag-to-digest recording guidance, Sentry skill-filtering limits, and client locations, see [preset and client compatibility](presets-and-clients.md).

The STDIO transport is the default because it avoids a network listener. Remote upstream connections carry profile-bound credentials, so Miftah requires HTTPS outside loopback development URLs (`localhost`, `127.0.0.0/8`, or `::1`). It uses Node's normal certificate validation and does not disable TLS verification; self-signed endpoints fail closed unless an operator explicitly provides a trusted local CA through Node's normal trust configuration. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`, and do not send credentials to a cleartext non-loopback endpoint.

For remote HTTP diagnostics, Miftah retains only a stable HTTP status or MCP protocol code. It deliberately omits server response bodies and remote protocol messages, because they can contain credentials or sensitive provider context. Streamable HTTP is preferred and sends DELETE on intentional local session cleanup; legacy SSE is deprecated and has no equivalent remote-session deletion. Any future HTTP server exposed by Miftah itself must bind localhost by default and require explicit authentication before non-local binding.

## Identity verification boundary

Identity verification is an optional, local account-fingerprint comparison. It is not credential validity, provider authentication, account authorization, or scope validation. Miftah does not ship provider SDKs or plugins for it.

The only safe statuses are `unconfigured`, `not-verified`, `verified`, `expired`, `mismatch`, `unsupported`, and `failed`. Status and audit output retain only safe profile/upstream names, configured expected and allowed actual fingerprint fields (`provider`, `login`, `organization`, `host`), a verification timestamp, and a stable error code. These values traverse normal redaction before they reach an MCP response or audit entry.

Identity state is process-only and bounded by `maxAgeMs`, the upstream session generation, and the exact profile/upstream target. A restart, crash, or idle session replacement therefore invalidates it. Miftah does not persist identity state or retain a raw response, raw account payload, tool arguments, error body, arbitrary JSON, or credentials. Doctor never reports raw identity output or fingerprint values.

Before parsing or normalization, identity verification accepts exactly one MCP text content item with at most 4,096 JavaScript characters. Any other response shape or longer text fails safely; JSON probes accept only an object and retain only validated allowlisted fingerprint strings.

Required checks fail closed for their configured write or destructive risks: a mismatch, unsupported probe, or failed verification blocks that protected operation. Optional identity configuration is observational and does not gate operations. See [identity verification configuration](config.md#identity-verification) for the probe and response contract.
