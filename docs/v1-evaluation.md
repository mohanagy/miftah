# v1 external evaluation

This protocol turns external Miftah use into comparable, privacy-safe evidence for issues #25, #88, #202, and #290. It is the shared evidence path for the product wedge, OAuth and Console validation, first-use product contract, and README redesign.

Evaluator baseline: `@lubab/miftah@0.5.8`. Stable release candidate: `@lubab/miftah@1.0.0`. Record the exact package version, upstream MCP version or immutable image reference, client, operating system, provider class, and authentication owner for every attempt. If the target changes, do not combine results until the participant repeats the affected steps or an explicitly documented delta assessment establishes why the result remains applicable.

This document is the evidence protocol, not participant-level completed evidence. On 2026-08-11, the maintainer reported 5 completed workflows, 3 later returns, and 3 unaided evaluators and authorized closure of the related issues. That status is a maintainer attestation; the underlying participant records were not independently inspected during release preparation. The attested counters apply to the 0.5.8 baseline only. Applying them to the 1.0.0 candidate requires complete linked records plus repeated affected steps or an accepted, documented delta assessment.

## Closure gates

The evidence set must include:

- five completed multi-account workflows from external participants, with at least three distinct providers represented across the set;
- three returning users who independently use or verify the configured connector in a later session;
- three unaided evaluators who start from the README and can identify Miftah's value, fit, account model, authentication path, and safe first success without maintainer coaching;
- explicit records of setup friction, recovery attempts, rejected assumptions, and failures as well as successful outcomes.

One person may contribute to more than one gate, but each gate keeps its own evidence. A maintainer, contributor to the evaluated build, synthetic fixture, or automated test does not count as an external participant.

## Privacy and consent

Ask the participant for consent before recording evidence. Collect no tokens, OAuth codes, raw configuration, logs, account or organization names, private URLs, provider payloads, or personal identifiers. The participant should redact screenshots and quotations before sharing them.

Use identifiers such as `P1` and provider classes such as `source control` or `analytics`. Public issue comments contain only the deidentified rollup. If a failure might be a vulnerability, stop the public workflow and use the private process in [`SECURITY.md`](../SECURITY.md).

## Participant workflow

### 1. Start without maintainer coaching

Give the participant only the repository URL and the task below. The maintainer may observe and answer safety questions, but must not select a setup path, command, profile name, authentication method, or recovery step.

> Configure one existing MCP service through Miftah with two named profiles for the same provider. Confirm which profile is active, safely verify the intended account when the upstream supports it, switch profiles deliberately, and repeat the verification. Stop if a step asks you to paste a secret into shared configuration or evidence.

Record where the participant starts, what they expect Miftah to do, and whether they correctly identify who owns authentication.

### 2. Pin and identify the target

Install the evaluator target and record its reported version:

```bash
npm install -g @lubab/miftah@0.5.8
miftah version
```

Do not count an attempt when the installed version cannot be established or the upstream is floating without an immutable version or image reference.

### 3. Configure and validate two profiles

The participant chooses the documented terminal wizard, browser Console, preset, or reviewed local/remote setup path. Before connecting a client, they run the equivalent checks for their config and both profiles:

```bash
miftah validate --config <config-path>
miftah doctor --config <config-path>
miftah test-profile --config <config-path> --profile <profile-a>
miftah test-profile --config <config-path> --profile <profile-b>
```

Passing diagnostics demonstrates only what each command reports. It does not prove provider scopes, account identity, or a successful real workflow.

### 4. Connect, verify, switch, and recover

In a supported client, the participant:

1. connects the single Miftah connector and calls `miftah_current_profile`;
2. performs a bounded read-only upstream action or configured identity probe to verify the intended account, recording `not verified` when the upstream cannot prove identity safely;
3. calls `miftah_use_profile` to select the other named profile and accepts or rejects any required approval deliberately;
4. repeats the current-profile and safe identity check, then completes one useful provider workflow;
5. follows the documented diagnostic or reauthorization path for any failure without exposing credentials.

A completed workflow requires a real upstream result under the intended profile, not only successful configuration, login, health, or tool listing. Wrong-account ambiguity, unexplained recovery, cross-profile leakage, or maintainer intervention prevents the attempt from counting as complete, but remains important failure evidence.

### 5. Return later

A returning user is a participant who, in a later session after the original setup session has ended, independently launches or reconnects the same reviewed connector, confirms its version and selected profile, and completes or verifies a useful provider action without setup coaching. Merely responding to a follow-up message does not count.

Record the elapsed interval, whether configuration or credentials changed, the first command or UI path used, and any new friction.

## README comprehension check

For each of the three unaided evaluators, ask them to explain before setup:

- the problem Miftah solves and when a direct MCP entry is simpler;
- the one-connector, named-profile account model;
- whether Miftah, the upstream, or the provider owns authentication for their chosen path;
- how they would validate configuration and verify the selected account safely;
- where audit, policy, identity, OAuth, client support, platform limits, and recovery guidance live.

Then observe their first safe success. Record the first point of confusion and the first page or command that resolves it. Do not count a comprehension gate that was answered through maintainer explanation.

## Deidentified evidence template

Copy one section per attempt into a private working note, remove sensitive material, and publish only the final deidentified fields:

```text
Participant: P1
External and unaffiliated with evaluated build: yes/no
Consent to deidentified public rollup: yes/no
Date and return date (if any): YYYY-MM-DD / YYYY-MM-DD or none
Miftah package and reported version: @lubab/miftah@0.5.8 / ...
Upstream immutable version or image: ...
Provider class / auth owner: ... / Miftah, upstream, or provider
Client / OS: ... / ...
Setup path chosen without coaching: ...
Two same-provider profiles configured: yes/no
validate / doctor outcomes: pass, fail, or not run
test-profile <profile-a> outcome: pass, fail, or not run
test-profile <profile-b> outcome: pass, fail, or not run
Initial and switched profile confirmed: yes/no
Identity evidence: verified, not verified, or mismatched
Real workflow outcome: completed/failed, with deidentified description
Recovery attempted and outcome: ...
README comprehension outcome and first confusion: ...
Later-session return outcome: completed/failed/not attempted
Maintainer intervention before completion: none or description
Safe deidentified quote (optional): ...
```

## Public rollup

Maintain this table in the tracking issue or link to an equivalent deidentified record. Do not replace missing results with projections.

| Participant | Version | Provider class | Client / OS | Two profiles | Real workflow | Unaided README | Later return | Evidence link |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P1 | pending | pending | pending | pending | pending | pending | pending | pending |
| P2 | pending | pending | pending | pending | pending | pending | pending | pending |
| P3 | pending | pending | pending | pending | pending | pending | pending | pending |
| P4 | pending | pending | pending | pending | pending | n/a | pending | pending |
| P5 | pending | pending | pending | pending | pending | n/a | pending | pending |

Map the final evidence explicitly:

- issue #25: five real multi-account workflows and product-wedge learning;
- issue #88: OAuth, Console, recovery, compatibility, and three returning users;
- issue #202: three unaided participants can discover trust, auth, account, client, and recovery controls;
- issue #290: three unaided participants achieve the README's safe first-use contract;
- issue #39: at least three real providers are represented, the independent security review is closed, and the final v1 target is reconciled under the [independent review brief](independent-security-review.md); provider evidence alone cannot close this release gate.

Failed attempts are learning, not completion. Complete linked records and accepted closure gates are required before replacing pending rows with completion evidence. Future evidence updates should not infer participant details from the maintainer-level counters.
