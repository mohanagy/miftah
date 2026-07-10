# Security model

Miftah is a credential broker, so safe defaults are part of the product contract:

- credentials stay local and telemetry is disabled;
- plaintext secret references are disabled unless explicitly enabled;
- environment values are injected into child processes and never returned by management tools;
- upstream stderr, errors, diagnostics, audit entries, and tool results pass through redaction;
- profile switching can be disabled or locked to a single profile;
- destructive and ambiguous requests are not silently routed;
- audit records contain metadata, not sensitive payloads, by default;
- provider tokens should be separate, least-privilege tokens per account and risk level.

Miftah cannot reduce privileges granted by a provider token. A read-only Miftah policy is a local blocklist, not a replacement for provider-side scopes. Avoid putting real credentials in examples, commits, or support logs.

The STDIO transport is the default because it avoids a network listener. Any future HTTP server must bind localhost by default and require explicit authentication before non-local binding.
