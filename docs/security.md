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

Miftah cannot reduce privileges granted by a provider token. A read-only Miftah policy is a local blocklist, not a replacement for provider-side scopes. Avoid putting real credentials in examples, commits, or support logs.

The STDIO transport is the default because it avoids a network listener. Any future HTTP server must bind localhost by default and require explicit authentication before non-local binding.
