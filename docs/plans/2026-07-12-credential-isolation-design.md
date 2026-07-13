# Credential Isolation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Give each configured profile/upstream target an opt-in, Miftah-managed HOME/XDG runtime tree, safely materialize approved credential files into it, and generate Docker/Podman bind mounts without exposing credential contents.

**Architecture:** A private `ProfileRuntimeIsolation` service derives an owner-restricted directory from the canonical config identity, profile name, and exact upstream name. `UpstreamProcessManager` asks it to prepare a target immediately before spawning a STDIO upstream; it receives generated environment variables, safe copied files, container arguments, and shared redactor values. No operator-selected runtime root or cleanup path is accepted.

**Tech Stack:** TypeScript strict ESM, Node `fs/promises`, Zod, Vitest, MCP SDK STDIO transport.

---

## Security decision

Use profile-owned Miftah paths rather than configurable arbitrary paths. A profile isolation object is opt-in; when present it creates a deterministic tree containing `home`, `xdg/config`, `xdg/cache`, `xdg/data`, `xdg/state`, and `xdg/runtime`, all restricted to the owner where the platform supports modes. It injects HOME/XDG (and Windows-compatible HOME/USERPROFILE/APPDATA values) after upstream and profile environments so configuration cannot bypass the generated paths.

The native STDIO guarantee is deliberately narrow: Miftah never resolves, materializes, injects, or bind-mounts another profile's managed path. A hostile native process under the same OS user can still open another profile's absolute path; that requires an OS sandbox, a distinct OS identity, or a correctly configured Docker/Podman container to prevent. Documentation and tests must state this rather than claiming same-UID containment.

Mapped files are copies from existing regular files canonically located under the canonical config directory. Destinations are relative, bounded paths inside the generated root. Miftah creates no backups, performs no automatic migration, and performs no automatic deletion of runtime trees; only an explicit future cleanup feature may remove a marker-owned Miftah path. This avoids deleting user-owned locations or silently discarding an upstream OAuth session.

## Public configuration contract

Add `isolation` to `ProfileConfig` and `ProfileUpstreamOverride`. A named-upstream isolation object augments the profile isolation object for that target: profile file mappings remain available to the target, while target-specific files and container volumes are added after them. Duplicate destinations or generated bindings fail closed rather than selecting a winner.

```ts
interface ProfileIsolationConfig {
  files?: Array<{
    source: string;          // relative regular file below the config directory
    destination: string;     // relative path below the generated runtime root
    environment?: string;    // set to the generated host path for native STDIO
  }>;
  containerVolumes?: Array<{
    source: string;          // relative path below the generated runtime root
    destination: string;     // absolute, normalized POSIX path in the container
    readOnly?: boolean;      // defaults to true; false is explicit
    environment?: string;    // set to the container destination
  }>;
}
```

Validate bounded strings, environment-variable names, unique file destinations, unique generated environment names, unique container destinations, and no absolute/traversal/NUL destination paths. Runtime canonicalization rejects symlinks, source paths outside the canonical config directory, non-regular files, oversize source files, remote transports, non-Docker/Podman commands for volumes, and conflicting existing container mount/environment flags. Errors use stable codes and never include a source path, destination path, file content, raw child output, or a raw filesystem cause.

## Docker/Podman behavior

Only an exact `docker`/`podman` (including executable suffixes/absolute paths) STDIO `run` command may use `containerVolumes`. Generate `--mount` and `--env` argument pairs before the image, never a shell string. Map known runtime subpaths to HOME/XDG container environment values, and map declared `environment` names to the declared container destination. Reject pre-existing mount flags or collisions with generated HOME/XDG/environment bindings instead of guessing precedence. A writable mount is opt-in; documentation must say it weakens the container boundary and that no other host directories should be mounted for isolation claims.

### Task 1: Configuration and generated-schema contract

**Files:**
- Modify: `src/config/types.ts`, `src/config/schema.ts`, `src/config/generate-json-schema.ts`, `src/index.ts`
- Test: `tests/config.test.ts`, `tests/config-runtime-parity.test.ts`, `tests/config-schema-contract.test.ts`, `tests/config-public-contract.test.ts`, `tests/public-api.test.ts`, `tests/package-contract.test.ts`

**Step 1: Write focused failing config/type/schema tests.**

Cover a valid profile isolation object, a named-upstream replacement, traversal/absolute/NUL destinations, duplicate targets or generated environment names, malformed container targets, and public type/package export parity.

**Step 2: Run the focused tests and observe schema failures.**

Run: `NODE_OPTIONS='--require=/private/tmp/miftah-dns-shim.cjs' npx vitest run tests/config.test.ts tests/config-runtime-parity.test.ts tests/config-schema-contract.test.ts tests/config-public-contract.test.ts tests/public-api.test.ts`

Expected: FAIL because `isolation` is rejected or types do not exist.

**Step 3: Implement the smallest strict Zod/type/schema change.**

Keep the configuration publicly typed, reject unknown keys, and update JSON Schema only where the generated representation cannot express an existing runtime constraint.

**Step 4: Re-run the focused tests and typecheck.**

**Step 5: Commit.**

### Task 2: Owned runtime-tree and file materialization service

**Files:**
- Create: `src/isolation/profile-runtime-isolation.ts`
- Modify: `src/runtime/create-runtime.ts`, `src/upstream/upstream-process-manager.ts`, `src/upstream/multi-upstream-process-manager.ts`
- Test: `tests/profile-runtime-isolation.test.ts`, `tests/fixtures/fake-upstream.mjs`

**Step 1: Write a failing real-STDIO test for two profile targets.**

Use two source OAuth fixtures below a temporary config directory. Require the fake upstream to report its generated HOME/XDG path and the mapped file through a test-owned report file. Assert distinct profile roots, `0700` directories/`0600` copied files where supported, post-merge environment precedence, and no source content in stderr/diagnostics.

**Step 2: Run the test and observe the missing isolation behavior.**

Run: `NODE_OPTIONS='--require=/private/tmp/miftah-dns-shim.cjs' npx vitest run tests/profile-runtime-isolation.test.ts`

Expected: FAIL because the fixture receives no generated mapping or profile-owned environment.

**Step 3: Implement canonical, marker-owned preparation.**

Realpath the config directory and sources, reject symlinks/non-regular/out-of-root/oversize sources, create only deterministic marker-owned directories, atomically copy to restrictive files, register complete copied content with the shared redactor before spawn, and return generated environment data. Do not add automatic cleanup or backups.

**Step 4: Add red tests for traversal, symlinks, existing target symlinks, rematerialization after restart, and safe failures; implement only the required guards.**

**Step 5: Re-run the focused suite and commit.**

### Task 3: Docker/Podman argument isolation

**Files:**
- Modify: `src/isolation/profile-runtime-isolation.ts`, `src/upstream/upstream-process-manager.ts`
- Test: `tests/profile-runtime-isolation.test.ts`

**Step 1: Write pure failing argument-generation tests.**

Assert exact argument arrays for Docker and Podman `run`, generated mount/env ordering, default read-only behavior, explicitly writable mounts, Windows-safe host paths, unsupported command/transport rejection, and generated-binding conflict rejection.

**Step 2: Run the focused test and observe missing/incorrect arguments.**

**Step 3: Implement fixed-array generation.**

Place only generated `--mount`/`--env` pairs before the image, reject ambiguous pre-existing mount flags rather than rewriting them, and never invoke a shell.

**Step 4: Re-run the focused suite and commit.**

### Task 4: Runtime, redaction, and documentation contracts

**Files:**
- Modify: `src/runtime/resolve-runtime-config.ts` as needed for shared redaction, `src/utils/errors.ts`, CLI exit mapping if a new stable error is required
- Modify: `README.md`, `docs/config.md`, `docs/security.md`, `docs/architecture.md`, `CHANGELOG.md`
- Test: `tests/negative-paths.test.ts`, `tests/secret-providers.test.ts` only if affected, a focused isolation docs contract

**Step 1: Add failing regressions for safe error boundaries and documentation claims.**

Verify errors and audit/stderr surfaces omit raw mapped paths/content; verify docs state the same-UID limitation, no automatic cleanup/backup/migration, file-copy semantics, and container trust boundary.

**Step 2: Implement the smallest safe error/output treatment and documentation.**

**Step 3: Run focused tests, lint, and typecheck.**

**Step 4: Commit.**

### Task 5: Release validation and delivery

Run the focused suites first, then `npm test`, `npm run test:core`, `npm run test:coverage`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run smoke:cli`, `npm run check:pack`, and `npm run test:package`. Document sandbox-only network/loopback limitations separately from code failures. Obtain an independent review, create a clean PR against `development`, resolve all current-head CI/CodeRabbit/human feedback, merge only when every gate is green, explicitly close Issue #29, and record the merge SHA/evidence in the session plan.
