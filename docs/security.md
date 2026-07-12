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
- provider tokens should be separate, least-privilege tokens per account and risk level.

Audit writes default to fail-closed: Miftah verifies the configured sink before dispatch and refuses a request when the sink cannot be prepared. A terminal write can fail after an upstream side effect has completed, so a post-dispatch `AUDIT_WRITE_FAILED` has an indeterminate outcome and must not prompt a blind retry of a non-idempotent operation. An operator can set `audit.failureMode` to `"fail-open"` for availability-sensitive deployments; Miftah then preserves the request outcome but exposes a redacted `AUDIT_WRITE_FAILED` health entry. This mode trades complete auditability for availability.

The explicit runtime configuration is trusted operator input; workspace routing metadata is not. Project markers cannot inject configuration because their only accepted shape maps the configured wrapper name to an already-known profile. They cannot add credentials, environment variables, headers, upstreams, policies, audit controls, or secret references. Miftah reads only named, bounded metadata files within the applicable working-directory/root boundary and does not scan arbitrary project content.

Routing evidence is deliberately narrower than routing context. It is passed through audit redaction before it reaches a client or JSONL record, strips URI userinfo/fragments and redacts URI query values, and never contains the raw `MIFTAH_PROJECT` value or arbitrary project file content. An unrecognized environment profile or ambiguous matching rules fails closed instead of selecting an account; standard project-marker discovery deterministically uses the nearest valid marker. Profile hints also cannot satisfy an explicit-rule requirement for destructive operations.

Miftah cannot reduce privileges granted by a provider token. A read-only Miftah policy is a local blocklist, not a replacement for provider-side scopes. Avoid putting real credentials in examples, commits, or support logs.

`init` never asks for or echoes a secret value: its wizard accepts variable names and validated endpoint/header metadata only. Generated provider examples contain `${ENV_NAME}` references, and client snippets are printed for explicit copy rather than written into host configuration files. For exact preset pins, GitHub tag-to-digest recording guidance, Sentry skill-filtering limits, and client locations, see [preset and client compatibility](presets-and-clients.md).

The STDIO transport is the default because it avoids a network listener. Remote upstream connections carry profile-bound credentials, so Miftah requires HTTPS outside loopback development URLs (`localhost`, `127.0.0.0/8`, or `::1`). It uses Node's normal certificate validation and does not disable TLS verification; self-signed endpoints fail closed unless an operator explicitly provides a trusted local CA through Node's normal trust configuration. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`, and do not send credentials to a cleartext non-loopback endpoint.

For remote HTTP diagnostics, Miftah retains only a stable HTTP status or MCP protocol code. It deliberately omits server response bodies and remote protocol messages, because they can contain credentials or sensitive provider context. Streamable HTTP is preferred and sends DELETE on intentional local session cleanup; legacy SSE is deprecated and has no equivalent remote-session deletion. Any future HTTP server exposed by Miftah itself must bind localhost by default and require explicit authentication before non-local binding.
