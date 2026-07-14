# Provider Routing Matchers Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add pure, in-tree GitHub, Sentry, Jira, Linear, and PostHog routing matchers with strict configuration, deterministic ambiguity, and safe preview/audit evidence.

**Architecture:** Profile-local declarative matcher bindings describe only canonical public identifiers. A static registry receives a bounded projection of routing input and returns safe candidates/evidence. `RoutingEngine` evaluates it after explicit hints/rules and before fallback; the operation and preview paths serialize the same evidence.

**Tech Stack:** TypeScript strict ESM, Zod, Vitest, existing routing context, audit trail, and real STDIO MCP fixtures.

---

## Task 1: Public matcher configuration contract

**Files:**
- Modify: `src/config/types.ts`, `src/config/schema.ts`, `src/config/generate-json-schema.ts`, `src/index.ts`
- Test: `tests/config.test.ts`, `tests/config-runtime-parity.test.ts`, `tests/config-schema-contract.test.ts`, `tests/config-public-contract.test.ts`, `tests/public-api.test.ts`, `tests/package-contract.test.ts`

1. Write failing tests for a valid typed GitHub profile match, every provider's allowed keys, disabled-by-default behavior, unknown providers/keys, empty bindings, invalid/case-confusing identifiers, duplicate values, unsafe URLs, and exact diagnostics. Keep `routing.plugins` rejected as a dynamic-code surface.
2. Run only the focused config/public-contract tests and confirm the valid declaration and exact diagnostics fail because profile routing matches are unsupported.
3. Add public types and strict Zod schemas for profile-local matcher bindings. Keep input bounded, reject URL credentials/query/fragment/control characters, and preserve JSON Schema/runtime parity.
4. Re-run the focused suite, lint, and type-check. Commit the contract.

## Task 2: Pure provider matcher registry

**Files:**
- Create: `src/routing/provider-matchers.ts`, `src/routing/provider-matcher-types.ts`
- Modify: `src/routing/routing-types.ts`
- Test: `tests/provider-routing-matchers.test.ts`

1. Write a failing pure-unit test for canonical GitHub repository matching from recognized arguments and git context, asserting a safe evidence object rather than raw input.
2. Run that test and confirm the matcher module is absent.
3. Implement a synchronous registry with no Node/process/network imports. Feed it only a bounded projection of allowlisted top-level scalar arguments and pre-normalized safe repository metadata; never pass `MIFTAH_PROJECT` or the whole context object.
4. Add one failing test at a time for GitHub owner/org, issue/PR URLs, and HTTPS/SSH/scp Git remotes; then Sentry org/project/environment/issue URL, Jira site/project, Linear workspace/team, and PostHog host/project. Require an exact provider token in tool names before accepting argument-only signals.
5. Add hostile-input regressions: oversized strings, nested objects, non-string values, URI userinfo/query/fragment, malformed URLs, duplicate configured values, and same-profile multi-signal matches. Evidence must contain only canonical allowed identifiers.
6. Make each test green with the smallest parser/normalizer and commit the registry.

## Task 3: Routing precedence and ambiguity

**Files:**
- Modify: `src/routing/routing-engine.ts`, `src/routing/routing-types.ts`
- Test: `tests/routing-policy.test.ts`, `tests/provider-routing-matchers.test.ts`

1. Write failing routing-engine tests proving environment hints, marker hints, and explicit rules win over matcher candidates; matchers win only over fallback.
2. Write a failing test that two distinct matcher profiles produce stable `ROUTING_AMBIGUOUS`, independent of registry/config order, and that multiple matcher signals for one profile succeed. Assert a bounded sorted evidence list is retained in typed ambiguity details.
3. Implement candidate aggregation and an additive matcher evidence field on `RoutingDecision`; use reason `matcher:<provider>` and retain safe evidence in ambiguity details.
4. Add a regression asserting matcher routing never satisfies the destructive explicit-rule guard, then run routing/policy tests and commit.

## Task 4: Preview and audit parity

**Files:**
- Modify: `src/audit/audit-types.ts`, `src/audit/audit-trail.ts`, `src/mcp/server/operation-pipeline.ts`, `src/mcp/server/miftah-server.ts`
- Test: `tests/mcp-wrapper.test.ts`, `tests/audit-outcomes.test.ts`

1. Write failing real-STDIO MCP tests where preview and a routed operation expose byte-for-byte equivalent safe matcher evidence in their respective public/audit outputs.
2. Add a failing matcher-ambiguity test proving no upstream invocation occurs and the audit is a typed ambiguous result.
3. Wire the decision's safe matcher evidence through operation and preview paths without changing the existing routing-context collection semantics.
4. Add a destructive matcher-routed operation regression proving it remains blocked absent a `rule:`. Run focused MCP/audit suites and commit.

## Task 5: Documentation and delivery contract

**Files:**
- Modify: `README.md`, `docs/config.md`, `docs/architecture.md`, `docs/security.md`, `CHANGELOG.md`
- Create/Modify: `tests/provider-routing-matchers-docs-contract.test.ts`

1. Write a failing documentation contract covering opt-in profile bindings, fixed built-in registry, precedence, ambiguity, audit evidence, and the no-dynamic-code/#34 boundary.
2. Update documentation with a safe GitHub/Sentry example that contains no credentials or raw input logging claims.
3. Run the documentation test, then the focused config/routing/MCP/audit suites, lint, and type-check. Commit the docs.

## Task 6: Release validation and delivery

1. Run `npm test`, `npm run test:core`, `npm run test:coverage`, `npm run lint`, `npm run typecheck`, `npm run build`, `npm run smoke:cli`, `npm run check:pack`, and `npm run test:package`. Record sandbox-only npm/loopback limitations separately from product failures.
2. Rebase/cherry-pick the #30 commits onto the current merged `development` only after #29 is merged, open a PR targeting `development`, resolve all review threads, and wait for current-head CI/CodeRabbit/human gates.
3. Merge only after every gate is green, explicitly close Issue #30, and update the execution plan with merge SHA and validation evidence.
