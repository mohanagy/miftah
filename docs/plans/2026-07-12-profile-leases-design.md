# Profile Leases and Runtime Locks Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make profile selection an explicit, connection-safe security boundary with optional user-confirmed switches, runtime locks, and short-lived per-profile leases for risky operations.

**Architecture:** Extend `ProfileManager` with an immutable selection snapshot that includes its source, confirmation state, runtime lock, and optional lease. `MiftahServer` reuses the connection-bound approval protocol for profile confirmations, then commits an accepted action inside its profile-transition queue. `OperationPipeline` checks the snapshot it captured at request start, so a later switch, unlock, or lease renewal cannot change an in-flight operation's authorization.

**Tech Stack:** TypeScript strict ESM, Zod, MCP SDK elicitation, Vitest, existing `AuditTrail`, `ProfileManager`, and `OperationPipeline`.

---

## Design decisions

- Add a strict opt-in profile field `lease: { ttlMs, requiredForRisk }`. It accepts only `write` and/or `destructive` risks, has no implicit default, and uses a bounded short TTL. A profile with no lease field preserves today's behavior.
- Reuse the existing `security.requireProfileSwitchConfirmation` compatibility declaration as a supported boolean. When enabled, profile changes use the existing connection-bound approval protocol: form-capable clients receive native elicitation, while other clients receive the same one-time retry bearer flow already used for approvals. The binding includes source profile, requested profile, session, and selection generation.
- Add `security.allowProfileLockingFromMcp` as an explicit opt-in for the runtime lock tools. A runtime lock is connection-bound and in-memory; it is never written to workspace/global profile-state files. Static `security.lockToProfile` remains stronger and cannot be removed at runtime.
- Preserve `security.requireExplicitProfileForDestructive` exactly as the existing explicit-routing-rule guard. Add `security.requireExplicitSelectionForDestructive` for deployments that also require a current-session explicit selection or configured lock instead of a default, persisted, hint, or fallback selection.
- A successful explicit `miftah_use_profile` or `miftah_reset_profile` issues a lease for that selected profile when configured. The captured lease must match the selected/routed profile and be unexpired for a protected operation. A route to a different lease-protected profile cannot borrow the active profile's lease.
- Record lease denial/expiry through the request's existing terminal audit event using safe selection metadata. Do not persist lease bearers, raw request data, or a lock state across sessions.

### Task 1: Public configuration and error contract

**Files:**

- Modify: `src/config/types.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/utils/errors.ts`
- Modify: `src/cli/exit-codes.ts`
- Test: `tests/config.test.ts`
- Test: `tests/config-runtime-parity.test.ts`
- Test: `tests/config-public-contract.test.ts`
- Test: `tests/cli-exit-codes.test.ts`

**Step 1: Write failing config/public-contract tests.**

Cover valid `security.requireProfileSwitchConfirmation`, `security.allowProfileLockingFromMcp`, and `security.requireExplicitSelectionForDestructive` declarations plus a valid profile lease. Reject an empty or duplicated `requiredForRisk`, `read`, zero/negative/oversized TTLs, and unknown lease keys with exact diagnostic paths. Assert generated public JSON schema exposes only the implemented fields.

**Step 2: Run focused config tests and observe the expected unsupported/unknown option failures.**

Run: `npm exec vitest run tests/config.test.ts tests/config-runtime-parity.test.ts tests/config-public-contract.test.ts tests/cli-exit-codes.test.ts`

**Step 3: Implement the narrow types and schemas.**

```ts
export interface ProfileLeaseConfig {
  ttlMs: number;
  requiredForRisk: ["write"] | ["destructive"] | ["write", "destructive"] | ["destructive", "write"];
}

interface SecurityConfig {
  requireProfileSwitchConfirmation?: boolean;
  allowProfileLockingFromMcp?: boolean;
  requireExplicitSelectionForDestructive?: boolean;
}
```

Add policy-category error codes for locked profiles, confirmation-required switches, missing leases, and expired leases. Preserve existing `PROFILE_SWITCH_DISABLED` behavior and map new runtime authorization failures to CLI policy exit code `6`.

**Step 4: Re-run focused tests and commit.**

Commit: `feat(profiles): add lease and lock configuration`

### Task 2: Deterministic ProfileManager selection, lease, and lock state

**Files:**

- Modify: `src/profiles/profile-manager.ts`
- Test: `tests/profile-manager.test.ts`
- Test: `tests/profile-state.test.ts`

**Step 1: Write failing unit tests with an injected clock.**

Test that an explicit selection issues a lease only for its configured profile; a default/persisted selection does not silently acquire one; expiry is exact at the TTL boundary; a runtime lock blocks switch/reset; unlock restores switching; static locks cannot be unlocked; and `beginSession()` clears runtime lock/lease state even where durable selection remains configured.

**Step 2: Implement immutable selection snapshots.**

Extend `ProfileSelection` with safe `confirmation`, `lock`, and `lease` summaries. Add a clock option for deterministic testing. Keep `current()` as a clone/snapshot, make lease checks operate on that captured snapshot, and retain existing serialized durable-state writes. Do not store runtime locks or lease timestamps in `ProfileStateStore`.

**Step 3: Re-run profile tests and commit.**

Run: `npm exec vitest run tests/profile-manager.test.ts tests/profile-state.test.ts`

Commit: `feat(profiles): track runtime locks and leases`

### Task 3: MCP management tools and connection-bound confirmation flow

**Files:**

- Modify: `src/mcp/server/miftah-server.ts`
- Test: `tests/mcp-wrapper.test.ts`
- Test: `tests/approval-fallback.test.ts` only if shared form-test helpers are useful
- Test: `tests/audit-outcomes.test.ts`

**Step 1: Write failing integration tests.**

Use real in-memory MCP transports. Assert that confirmation-enabled switches use a native boolean elicitation when supported, retain a one-time fallback retry flow otherwise, and do not switch if rejected; `miftah_lock_profile` locks the current profile; `miftah_unlock_profile` restores it only when runtime locking is opt-in; and profile status appears in current-profile, health, and profile-management JSON output. Assert the server does not hold a profile transition while awaiting elicitation.

**Step 2: Implement management actions.**

Add `miftah_lock_profile` and `miftah_unlock_profile`. Bind confirmation to the exact profile action through the existing `ApprovalStore`; on retry, consume it before committing. Keep form elicitation outside the profile transition queue, then recheck lock/configuration and captured selection generation inside the serialized commit. Keep static locks immutable and prevent direct manager callers from bypassing configured confirmation.

**Step 3: Audit safe management outcomes.**

Add dedicated safe profile transition audit actions for confirmation request/accept/deny, switch, lock, unlock, lease issue, and lease expiry. Serialize each mutation with its state audit and roll back/fail closed on a failed state audit. Extend outer request metadata only with safe selection source/confirmation/expiry; never add raw workspace paths, tokens, or user input.

**Step 4: Re-run targeted server/audit tests and commit.**

Run: `npm exec vitest run tests/mcp-wrapper.test.ts tests/audit-outcomes.test.ts`

Commit: `feat(mcp): add confirmed profile lock controls`

### Task 4: Enforce leases and explicit destructive-selection semantics in the shared pipeline

**Files:**

- Modify: `src/mcp/server/operation-pipeline.ts`
- Modify: `src/mcp/server/miftah-server.ts`
- Modify: `src/audit/audit-trail.ts` and `src/audit/audit-types.ts` only if selection audit metadata needs an additive typed field
- Test: `tests/operation-pipeline.test.ts`
- Test: `tests/mcp-wrapper.test.ts`

**Step 1: Write failing operation tests.**

Prove a selected profile's unexpired lease permits only its configured risks; exact expiry blocks before `UpstreamSession.callTool`; a later switch or renewal cannot authorize a request that captured an older snapshot; a rule-routed target cannot reuse a different active profile's lease; and `requireExplicitSelectionForDestructive` differentiates an explicit selection/configured lock from automatic default or persisted fallback without changing the existing explicit-rule guard.

**Step 2: Implement snapshot-based enforcement.**

Expand `CapturedProfileState` to carry the safe `ProfileManager` snapshot. After routing and risk evaluation but before target resolution/execution, validate the captured selection/lease against the routed target and current clock. Keep approval and identity ordering intact. Map these failures to a denied terminal audit result.

**Step 3: Re-run focused pipeline tests and commit.**

Run: `npm exec vitest run tests/operation-pipeline.test.ts tests/mcp-wrapper.test.ts tests/audit-outcomes.test.ts`

Commit: `feat(policy): enforce profile leases for risky operations`

### Task 5: Documentation, contracts, validation, and review

**Files:**

- Modify: `README.md`, `docs/config.md`, `docs/architecture.md`, `docs/cli.md`, `docs/security.md`, `CHANGELOG.md`
- Create or modify: focused documentation contract tests under `tests/`

**Step 1: Write documentation contract tests.**

Require docs to state that dynamic locks/leases are connection-bound, fallback clients cannot bypass confirmation, leases do not authorize another routed profile, and static locks remain operator-controlled.

**Step 2: Update docs and public schema contracts.**

Describe the exact config, TTL bounds, management tools, audit behavior, and compatibility boundary. Do not claim locks authenticate a human or make upstream credentials safe.

**Step 3: Run the full release suite.**

Run, in order:

```bash
npm test
npm run test:core
npm run test:coverage
npm run lint
npm run typecheck
npm run build
npm run smoke:cli
npm run check:pack
npm run test:package
```

Record sandbox-only loopback/registry constraints without suppressing those tests. Push a PR to `development`, resolve every current-head review thread, wait for all Linux/macOS/Windows, quality, package, Verify, and CodeRabbit checks, merge, close #28, and update the execution log with the merge SHA and validation evidence.
