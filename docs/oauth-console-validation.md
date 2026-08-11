# OAuth and Console validation

This page records what Miftah's release gate proves for native remote OAuth and the optional local Console, what it deliberately does not prove, and how the external-evidence status was accepted. It is an evidence record, not a claim that every OAuth provider is supported.

## Automated compatibility gate

Every pull request and push to `development` or `main` runs `npm run test:oauth-console` on Ubuntu, macOS, and Windows with Node.js 20, 22, and 24. The same matrix also runs Miftah's core and packaged-CLI contracts. A release candidate cannot rely only on the Linux full-test job.

The dedicated suite uses deterministic local fixtures and does not contact live OAuth providers. It exercises:

- protected-resource and authorization-server discovery, exact resource and issuer validation, PKCE, callback handoff, exchange, refresh, and bearer injection;
- connection/profile/upstream isolation, credential envelopes, expiry, identity mismatch, redaction, and audit integrity;
- configuration migration, connection planning and writes, CLI-only operation, Console lifecycle commands, and provider-adapter contracts;
- literal-loopback binding, single-use state, bounded cancellation and timeout cleanup, exact Console listener and Origin checks, CSRF, and browser launch boundaries.

The secure-store tests validate the vault adapter boundary, credential-envelope isolation, module construction, and unavailable-vault diagnostics. The suite does not write test credentials into the operator's real OS vault. It also does not prove that a live provider granted the requested scopes or that the selected account is the intended account; those require provider and user evidence.

## Recovery scenarios

### Refresh and reauthorization

An expiring credential is refreshed only after discovery is revalidated. Refresh failure never falls through to another profile or connection. `miftah auth reauth` keeps the existing credential until its replacement succeeds, and failed interactive authorization returns a typed diagnostic without printing provider output.

### Disconnect and cleanup

`miftah auth disconnect` deletes only the exact local vault binding and marks the connection disconnected. It does not claim provider-side revocation. Callback listeners and Console-owned resources close during success, failure, or shutdown.

### Cancellation and callback timeout

The loopback callback accepts one exact state, issuer, host, and path. Cancellation and timeout close the listener and discard transient authorization material without changing another connection or exposing callback parameters.

### Configuration backup and recovery

Connection writes are plan-first, reject symlink or concurrent-replacement races, and create a unique recovery backup before atomic installation. Stop active clients before restoring a backup, validate the restored file, and then restart clients.

For provider-adapter-backed or upstream-owned OAuth, follow the provider's own reauthentication and cache-recovery instructions. Miftah does not import, repair, or replay opaque provider token caches.

## Release status and limitations

OAuth and Console are included in the stable v1 release. The automated gate remains required evidence, but it does not prove live-provider behavior, external adoption, or account intent by itself. The current support classes and manual fallbacks remain defined in the [OAuth support matrix](oauth-support.md#support-matrix).

## External design-partner evidence

Snapshot date: 2026-08-11. Evaluator baseline: `@lubab/miftah@0.5.8`. Stable release candidate: `@lubab/miftah@1.0.0`.

- Interested external users: 5
- Recorded completed external workflows: 5
- Recorded returning external users: 3
- Recorded unaided README evaluators: 3

These counts are a maintainer attestation recorded on [#39](https://github.com/mohanagy/miftah/issues/39), not independently inspected participant evidence. The private participant records and public deidentified row-level rollup were not supplied during release preparation, so this page does not infer provider coverage, dates, clients, operating systems, or participant-specific outcomes beyond the three counters above. The [v1 external evaluation](v1-evaluation.md) protocol remains the definition of a completed real workflow, later-session return, unaided participation, version pinning, and safe deidentified record. Never record credentials, OAuth codes, tokens, provider payloads, or personal account identifiers.
