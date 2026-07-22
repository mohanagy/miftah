# OAuth and Console validation

This page records what Miftah's release gate proves for native remote OAuth and the optional local Console, what it deliberately does not prove, and which external evidence is still missing. It is an evidence record, not a claim that every OAuth provider is supported.

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

OAuth and Console are being validated for a pre-v1 feature release. Passing this automated gate is required release evidence, but it is not v1.0 readiness and does not close the demand or external-validation gates by itself. The current support classes and manual fallbacks remain defined in the [OAuth support matrix](oauth-support.md#support-matrix).

## External design-partner evidence

Snapshot date: 2026-07-22.

- Interested external users: 5
- Recorded completed external workflows: 0
- Recorded returning external users: 0

The external design-partner gate remains open. Closing it requires five external users to complete real multi-account workflows and at least three to return after setup. Record only deidentified workflow, setup friction, return behavior, and rejected assumptions; never record credentials, OAuth codes, tokens, provider payloads, or personal account identifiers.
