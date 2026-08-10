# Independent security review brief

This brief defines the external review required by issues #37 and #39. It turns the public [threat model](threat-model.md) into a reviewable engagement without claiming that a review has happened.

## Target and independence

The engagement baseline is the current published release, `@lubab/miftah@0.5.8`. Before work starts, the maintainer and reviewer must record the exact commit and package version under review, the upstream dependencies or fixtures used, the operating systems exercised, and the review dates. The eventual v1 release candidate must receive either a final review at its exact commit or a reviewer-accepted delta review from the recorded baseline.

The reviewer supplies an independence declaration covering employment, contribution, financial, and other material relationships with Miftah and its maintainers. A maintainer self-review, automated scanner, dependency report, or AI-only review is useful input but does not satisfy this independent gate.

## Review scope

Review the security claims and boundaries in [`threat-model.md`](threat-model.md), [`security.md`](security.md), and the OAuth and Console threat model. At minimum, cover:

- configuration schema, migration, safe writes, permissions, symlink and replacement races;
- secret references, environment and OS-vault boundaries, credential envelopes, and redaction;
- child-process launch and shutdown, executable resolution, Windows job containment, and output handling;
- profile, runtime, connection, OAuth, and container isolation, including wrong-account and cross-profile failure paths;
- local HTTP, Console authorization, Origin and CSRF checks, loopback OAuth callback validation, state, issuer, PKCE, timeout, and cancellation;
- routing, policy, approvals, connection locking, identity evidence, and fail-closed behavior;
- audit integrity and the documented limits of local tamper evidence;
- plugins, provider adapters, package contents, dependency and supply-chain boundaries;
- denial-of-service, resource exhaustion, malformed upstream messages, and cleanup behavior.

Include relevant Linux, macOS, and Windows paths when the implementation differs. The review may exclude a live third-party provider or unsupported client only when the report names the exclusion and explains how fixtures, code review, or residual risk cover it.

## Expected methods

The reviewer chooses the exact method, but the report must distinguish source review, automated testing or scanning, manual adversarial testing, and documentation analysis. Exercise negative paths and boundary violations, not only happy-path behavior. Validate important claims against the packaged artifact as well as source when packaging can change the result.

Miftah maintainers provide architecture and setup help, answer scope questions, and reproduce findings. They do not constrain severity, suppress an in-scope result, or author the reviewer's conclusions.

## Deliverables and disclosure

The reviewer provides:

1. a private report with target identifiers, scope, exclusions, methods, findings, severity and rationale, affected versions, reproduction guidance, and recommended remediation;
2. a remediation-verification addendum that records the exact fix commit or package for every critical or high finding and the independent reviewer's retest result or written acceptance;
3. a public completion summary naming the reviewer or organization when permitted, review dates, target, scope, exclusions, severity counts, remediation status, and residual limitations without exploit-enabling detail;
4. the signed or otherwise attributable independence declaration.

Send vulnerability details through the private process in [`SECURITY.md`](../SECURITY.md). Do not open a public GitHub issue with credentials, private provider data, or an unpatched exploit. Public issue #37 should link only the completion summary and safe remediation evidence.

## Closure gate

The review gate closes only when:

- the external reviewer has delivered the required report and independence declaration;
- there is no unresolved critical or high-severity finding in the reviewed v1 target;
- every critical or high finding has an exact remediation commit, regression test where practical, and independent reviewer retest or written verification acceptance by that reviewer;
- the public completion summary states the exact target, scope, exclusions, severity counts, and remediation status;
- any change between the reviewed target and the v1 release candidate has been included in the review or accepted by the independent reviewer through a documented delta assessment.

Medium and lower findings must have a documented disposition, owner, and timeframe. Acceptance of residual risk must name the decision maker and rationale. Passing existing CI or publishing this brief does not satisfy the gate.

## Maintainer handoff checklist

- [ ] Freeze and record the exact review target.
- [ ] Provide build, test, architecture, threat-model, and safe fixture instructions.
- [ ] Confirm a private reporting channel and response contacts from `SECURITY.md`.
- [ ] Receive and archive the independence declaration and private report.
- [ ] Triage findings without changing reviewer-authored severity evidence.
- [ ] Remediate and add regression coverage.
- [ ] Obtain independent reviewer verification or written acceptance by that reviewer.
- [ ] Publish the safe completion summary and link it from #37.
- [ ] Reconcile the final v1 candidate against the reviewed target before closing #39.
