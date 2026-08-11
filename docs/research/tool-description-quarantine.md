# Tool-description quarantine research

> **Status: research evidence, not a production control.** This study addresses [#36](https://github.com/mohanagy/miftah/issues/36). It does not claim external validation, protection from a malicious upstream, or completion of the independent security review tracked by [#37](https://github.com/mohanagy/miftah/issues/37).

## Recommendation: defer runtime quarantine

Do not add startup blocking, description rewriting, or an external scanner to Miftah before `1.0`. Keep upstream tool metadata untrusted, retain the existing fail-closed equality check over complete client-visible descriptors where cross-profile forwarding requires it, and revisit an opt-in descriptor-approval control only after design partners show that metadata drift is a real problem for them.

This recommendation is deliberately conditional. Production work may proceed only when:

1. design-partner evidence shows that users value notification or approval for changed tool metadata;
2. representative upstream snapshots demonstrate an acceptable false-positive and approval-churn rate;
3. the product has a clear recovery path for intentional upstream upgrades; and
4. any external scanner has a reviewed privacy, availability, provenance, and failure-mode boundary.

## Enforceable boundary

The offline prototype shows that Miftah could compare client-visible `Tool` descriptors and identify additions, removals, and changes. A future opt-in control could require a local decision before exposing a changed snapshot; the current runtime does not quarantine descriptor changes or ask for that approval. Its existing strict cross-profile discovery guard instead rejects unequal complete client-visible descriptors. A descriptor hash says only that metadata changed; it does not establish that the old or new metadata is safe. A heuristic scanner can flag text patterns, but cannot reliably infer an upstream's behavior or intent.

Miftah cannot protect credentials after they are delivered to an upstream selected by the operator. Quarantining or rewriting `description` and `inputSchema` does not sandbox the upstream process, constrain provider-side token scope, inspect every transformed tool result, or stop side effects outside the MCP metadata surface. Separate least-privilege credentials and upstream trust decisions remain required.

## Prototype

[`scripts/tool-description-quarantine-prototype.mjs`](https://github.com/mohanagy/miftah/blob/development/scripts/tool-description-quarantine-prototype.mjs) is an offline, dependency-free research harness in the repository source checkout. It is not included in the npm package, imported by the runtime, or able to alter `tools/list` or `tools/call`.

The harness evaluates two mechanisms:

- **Canonical descriptor hashes:** reject missing, empty, or duplicate tool names; recursively sort and serialize each complete tool descriptor; then hash it with SHA-256. Comparing snapshots identifies added, removed, and changed tools and names the changed top-level fields. This mirrors the existing strict-discovery design of comparing complete client-visible tool objects; it is not a safety classifier.
- **Local heuristic scanning:** five regular-expression rules look for instruction override, secret exfiltration, concealment, authority spoofing, and forced tool chaining. The rules exist to expose likely precision/recall and maintenance problems, not to propose a production detector.

## Recorded synthetic evidence

Run on 2026-08-11 Asia/Dubai (2026-08-10 UTC) with Node `v22.9.0` on Darwin arm64:

| Measure | Result | Interpretation |
| --- | ---: | --- |
| Benign descriptions | 12 | Small, maintainer-authored stress corpus. |
| Malicious descriptions | 10 | Obvious and mildly evasive maintainer-authored examples. |
| Benign descriptions flagged | 1/12 (8.3%) | A legitimate migration instruction triggered the override rule. |
| Malicious descriptions flagged | 8/10 (80%) | Two plausible phrasings evaded every rule. |
| Synthetic snapshot changes identified | 5/5 | One addition, one removal, two description edits, and one schema edit. |
| Invalid snapshot cases rejected | 3/3 | Duplicate, empty, and missing tool names fail closed before comparison. |
| 1,000-tool hash-and-scan median | 4.48 ms | Median of 30 local iterations. |
| 1,000-tool hash-and-scan p95 | 5.63 ms | Local timing only; not a startup SLO or cross-platform guarantee. |

The synthetic corpus does not estimate production false-positive rates. It was intentionally written to demonstrate both a false positive and false negatives. The timing result excludes upstream discovery, persistence, user interaction, scanner network latency, and approval recovery. Repeat the harness on current hardware and representative real snapshots before using any number for a product decision.

## Option assessment

| Option | Security value | Friction and failure mode | Decision |
| --- | --- | --- | --- |
| Observe and audit descriptor hashes | Makes metadata drift visible without claiming maliciousness. | Needs durable baseline ownership, rotation, redaction review, and an operator-facing diff. | Best first product experiment if users ask for it. |
| Block on any unapproved hash | Prevents silent metadata changes after a baseline is trusted. | Every legitimate description/schema release can block startup; first-use trust remains unsolved; removed/renamed tools need recovery UX. | Do not enable by default. Prototype only after real snapshot churn is measured. |
| Heuristic local prompt-injection scanner | Can surface obvious suspicious text without data egress. | The prototype produced both a false positive and false negatives; wording and languages make rules easy to evade and costly to maintain. | Do not use as an enforcement boundary. |
| Rewrite or strip descriptions | Reduces direct exposure to description text. | Damages tool usability, does not constrain behavior, and may move instructions into schema fields, results, resources, or prompts. | Reject. |
| External scanner | May offer broader models/signatures and independent updates. | Sends potentially sensitive metadata to another trust boundary; adds latency, cost, outages, version drift, and vendor-policy dependence. | Evaluate only with explicit operator opt-in and a reviewed local fallback. |
| User approval with a structured diff | Lets an operator judge an intentional upgrade. | Approval fatigue and first-use bootstrapping remain; MCP clients do not provide a uniform trusted human-identity boundary. | Candidate opt-in UX after partner demand is established. |

## Design-partner evidence still required

No design-partner evidence is recorded by this study. Before implementation, collect representative snapshots and ask partners to complete the normal upgrade/startup workflow with a proposed metadata diff. Record:

- how often descriptors change without a security concern;
- whether users can understand and act on the diff;
- startup delay and abandoned/retried sessions;
- approvals that users accept without inspection;
- false positives and missed suspicious descriptions; and
- the recovery experience when an upstream intentionally adds, removes, or renames tools.

If partners do not value the control, or the observed approval churn is not acceptable, close the product experiment without adding runtime quarantine.

## Reproduce

From a repository source checkout:

```bash
node scripts/tool-description-quarantine-prototype.mjs
npx vitest run tests/tool-description-quarantine-research.test.ts
```

The command prints aggregate corpus metrics, flagged benign examples, malicious misses, the descriptor-change summary, environment, and aggregate benchmark values as JSON. Committed documentation records one run for review; the executable output remains the source for any fresh measurement.
