# Threat model

> **Status:** Maintainer-authored model for the current development branch. It is not an independent security assessment. The independent review tracked by [#37](https://github.com/mohanagy/miftah/issues/37) has not yet been commissioned; see [Independent review status](#independent-review-status).

Miftah is an MCP-aware credential broker. This document makes the security boundaries behind its defaults explicit: what is protected, who crosses each boundary, which controls are implemented, and which risks remain. It complements the operational [security model](security.md), implementation [architecture](architecture.md), and [security reporting policy with a private reporting channel](../SECURITY.md).

## Scope and method

This model covers:

- trusted and untrusted MCP clients and upstreams;
- prompt-driven tool and profile switching;
- local process and environment exposure;
- secret providers and credential files;
- remote transport and session authentication;
- routing ambiguity and policy fail-open paths;
- audit confidentiality and integrity;
- plugin and supply-chain boundaries; and
- denial of service and concurrency limits.

The method is intentionally practical: describe the system and its trust boundaries, identify threats to protected assets, map each threat to implemented controls, then record the residual risk and validation work. It follows the structure recommended by the [OWASP Threat Modeling Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Threat_Modeling_Cheat_Sheet.html). It also considers MCP-specific authorization and transport guidance from the [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices).

This is a model of Miftah's wrapper and its documented configuration surface, not a claim that every configured upstream, plugin, operating system, dependency, or deployment is safe. Changes to a boundary, secret flow, configuration default, dependency trust decision, or externally exposed transport require this document and its targeted tests to be reviewed together.

The forward-looking [OAuth and local Console design delta](oauth-console-threat-model.md) records the additional protocol, callback, credential, browser, and local-control-plane decisions required before those capabilities can be implemented. It does not change the implemented-control claims in this current model or mark the independent review complete.

## Protected assets

| Asset | Why it matters | Intended protection |
| --- | --- | --- |
| Secret values, provider tokens, and provider output | Disclosure can grant access to an upstream account or infrastructure. | Canonical secret references, opt-in plaintext, configured/scoped child environments, bounded provider execution, and shared redaction. |
| Configuration, profile selection, and credential-runtime copies | Unintended mutation or disclosure can select the wrong account or expose a credential file. | Configuration-owned paths, explicit persistence, restrictive runtime trees where supported, and fail-closed Windows isolation. |
| MCP session IDs, delegated approval bearers, profile locks, and leases | These capabilities can alter which operation is allowed or selected. | Connection binding, bounded lifetimes, keyed digests for delegated approval bearers, and exact-operation binding. Default human confirmation creates no bearer without MCP form elicitation. |
| Route, policy, and tool-capability decisions | Incorrect routing or risk classification can send an operation to the wrong account or permit an unsafe operation. | Immutable snapshots, explicit configuration, conservative fallbacks, and ambiguity refusal. |
| Audit and identity metadata | It supports incident investigation but can itself expose sensitive context or be altered locally. | Metadata-only, redacted journals, restrictive paths where available, and optional local tamper evidence. |
| Availability of local runtimes and sessions | Resource exhaustion can deny access or destabilize a shared host. | Bounded request bodies, sessions, output capture, process deadlines, lifecycle state, and capacity limits. |

## Actors and trust assumptions

| Actor or component | Trust assumption | Boundary implication |
| --- | --- | --- |
| Operator | Chooses Miftah configuration, providers, plugins, host controls, and deployment topology. | Operator configuration is privileged input; Miftah validates its shape but cannot make a malicious operator-approved target trustworthy. |
| MCP client | May send malformed, ambiguous, or socially engineered requests. | Miftah-owned configuration/state paths and provider routing are not caller-controlled. Default human confirmation fails closed without an MCP form boundary; delegated approval bearers and runtime locks/leases are connection-bound. Neither mode cryptographically proves a human identity. Profile persistence is explicit and configuration-owned. Forwarded arguments remain an upstream boundary. |
| Upstream MCP service | May be unavailable, misleading, compromised, or return sensitive data. | An upstream is a trust boundary even when configured by the operator. Tool annotations are not trusted for risk downgrades by default, and remote diagnostics retain safe codes rather than response bodies. |
| Local provider or plugin child | May fail, hang, emit sensitive output, or behave maliciously. | It runs outside the Miftah process with limited inputs, but it is not thereby trusted or sandboxed. |
| Same OS user, host administrator, local container daemon, and network | Can inspect or interfere with local resources beyond Miftah's authority. | A same OS user is not a strong isolation boundary; a local daemon and host security remain operator infrastructure. |
| Dependency and source supply chain | May change code before it becomes an allowlisted local module or published package. | Miftah can constrain configured execution paths, not independently verify the integrity or behavior of every dependency. |

## Trust boundaries and data flows

```text
untrusted MCP client
  -> Miftah STDIO or loopback HTTP ingress
     -> connection-bound profile, routing, policy, approval, and audit scopes
        -> configured secret resolver -> provider child / credential source
        -> selected upstream client -> local STDIO child or remote HTTPS upstream
        -> local redacted audit journal

trusted operator configuration controls the permitted profiles, upstreams,
secret references, audit destination, and explicitly allowlisted plugins.
```

| Flow | Boundary | Controls at the boundary |
| --- | --- | --- |
| MCP client to local ingress | Untrusted request becomes a local operation. | Exact protocol/host/origin checks for HTTP, required secret-backed bearer authentication for explicitly enabled non-loopback binding, bounded request bodies, isolated HTTP session runtimes, and stable error categories. |
| Request to routing and policy | User-controlled names and arguments affect target selection. | Immutable routing context, explicit rules and locks, conservative risk classification, policy checks, confirmation/approval lifecycle, and fail-closed ambiguity. |
| Resolver to secret provider or child environment | A secret is materialized for a configured consumer. | Typed provider grammar, fixed provider programs with argument arrays, bounded capture, timeouts/cancellation, child-environment scoping, and redaction registration before return. Windows resolution avoids current-directory lookup. |
| Miftah to upstream | A selected profile's credentials and operation cross to an external/local service. | Exact target resolution, profile-bound credentials, HTTPS outside loopback development addresses, normal certificate validation, and redacted diagnostics. |
| Miftah to audit storage | Sensitive operation metadata becomes a local artifact. | Redaction, metadata-only defaults, owner-only permissions where supported, explicit export, fail-closed default writes, and optional local hash-chain evidence. |
| Miftah to routing-plugin host | A configured matcher receives limited routing data. | Explicit allowlisting, resolved-path preflight, scrubbed environment, bounded canonical signal projection, and contained child execution. |
| Miftah to secret-provider plugin | A configured provider receives a reference it is allowed to resolve. | Typed registration, bounded child execution, scoped environment, and one canonical reference rather than the full Miftah configuration. |

## Threats, controls, and residual risks

| Threat and attacker goal | Implemented controls | Residual risk and operator decision |
| --- | --- | --- |
| **Secret disclosure** through configuration, a provider child, stderr, diagnostics, audit records, or a tool result. | Plaintext references are disabled by default; secret references use typed canonical grammar; provider programs use argument arrays; output is bounded; resolved values enter shared redaction before diagnostics/audit output. On Windows, provider resolution avoids current-directory lookup. | Miftah cannot protect a value after delivering it to an operator-approved child process or upstream. Redaction cannot make a malicious host safe or reliably detect every transformed unknown secret. Use separate least-privilege provider tokens. |
| **Prompt-driven profile or tool confusion** causes a client to select an unintended account or execute a destructive operation. | The operator owns profile configuration and optional profile locks; callers cannot choose a persistence path or scope; routing is explicit/conservative; destructive and ambiguous requests do not silently route; approval is bound to one connection and exact operation. | Approval, locks, and leases are not authentication or proof of human intent. A permitted client can still ask for an allowed action; provider-side scopes remain the authority for what the credential can do. |
| **Provider or plugin subprocess abuse** uses command injection, hangs, leaks output, or leaves a process tree alive. | Children use argument arrays and no shell; execution is bounded and cancellable; Windows resolves trusted launcher/executable paths and joins the child to a kill-on-close Job Object; plugin hosts receive a scrubbed, limited interface. | The Job Object containment covers ordinary descendants, not services, scheduled tasks, elevation brokers, WMI-created processes, or side effects already completed. A local plugin is not an operating-system sandbox. Review every configured module and its changes. |
| **Credential-runtime or container handoff exposure** gives one profile's managed copy to another process. | Profile credential isolation is opt-in; paths are derived from canonical configuration identity; only approved regular files are copied; Docker/Podman arguments are fixed and conflicting mounts/environment flags are rejected; Windows credential isolation fails closed rather than claiming POSIX permissions. | POSIX ownership does not stop another process running as the same OS user. Container protection depends on a trusted local daemon, intended generated mounts only, and no host-level race before the daemon resolves a path. |
| **Remote transport or local HTTP session confusion** exposes an operation to the wrong client, host, or endpoint. | STDIO is the default; HTTP is literal-loopback first; non-loopback use requires explicit opt-in, a secret-backed bearer, and exact hosts; Host/Origin/authorization/session headers are strictly validated; HTTP sessions have separate runtimes and bounded lifecycle. Remote non-loopback upstreams require HTTPS with normal certificate validation. | Local HTTP isolation is runtime/session isolation, not host-compromise protection. A bearer held by a compromised permitted local client can be used until it is rotated/reconfigured or the server stops. Do not disable TLS validation. |
| **Routing ambiguity, deceptive metadata, or policy fail-open** selects a different upstream or downgrades risk. | Workspace metadata is bounded and cannot add configuration; upstream annotations are ignored for risk downgrades unless the operator explicitly trusts the base upstream; unknown/ambiguous matches fail closed; client-visible schemas must match before cross-profile forwarding. | Miftah policy is a local control. It cannot reduce privileges granted by a provider token or prove that an upstream's claims/identity are correct. |
| **Audit loss, disclosure, or undetected replacement** hides security-relevant activity. | Records are redacted and metadata-only by default; audit preparation fails closed by default; rotation/retention reject unsafe paths; export is explicit; optional SHA-256 chaining records local continuity evidence. | An opt-in fail-open mode trades audit completeness for availability. A terminal audit failure can follow an already-completed upstream side effect. The local chain is tamper evidence, not a cryptographic signature, nonrepudiation system, or remotely protected archive. |
| **Misleading upstream identity or response data** is treated as proof of authorization or account scope, a changed binding is trusted without live verification, or another process silently changes an active client's account choice. | Identity verification is opt-in and bounded; persistence keeps only configured allowlisted evidence in config-namespaced restrictive state, live protected calls re-probe, multi-profile selection can require an explicit/confirmed current-session choice, and OAuth metadata receives only a coarse identity state. Raw identity output and remote errors are not retained, and external durable changes do not mutate an active client's in-memory selection. | Identity verification is not authentication, credential validity, provider authentication, account authorization, or scope validation. Persisted evidence is visibility, not live authorization, and does not make a compromised upstream trustworthy. |
| **Plugin, dependency, or source supply-chain compromise** gains same-user host access. | Local plugins are explicitly allowlisted, preflighted below the configuration directory, isolated in a child host, and given only limited routing signals. | These controls are not a substitute for dependency provenance, code review, signatures, host hardening, or separate OS identities. Treat configured plugin code and the package supply chain as operator trust decisions. |
| **Denial of service and concurrency exhaustion** consumes processes, output buffers, HTTP sessions, audit capacity, or host resources. | Provider output and time are bounded; HTTP bodies and sessions are bounded before allocation; lifecycle management keeps a no-eviction capacity reservation through cleanup/recovery; failures are surfaced instead of silently admitting unlimited replacements. | Miftah does not provide a general host resource quota, distributed rate limit, or protection from a malicious same-user process, local administrator, upstream, or network. Operators must size and monitor the host and set appropriate deployment limits. |

## Security-sensitive defaults and validation

Security defaults deliberately favor refusal over convenience:

| Default | Why | Published contract and review point |
| --- | --- | --- |
| Plaintext secret references are opt-in; external references have strict typed grammar. | Prevent accidental values in configuration and avoid an ambiguous command surface. | Secret-provider behavior and reference grammar are exercised in [`tests/secret-providers.test.ts`](../tests/secret-providers.test.ts) and [`tests/secret-provider-docs-contract.test.ts`](../tests/secret-provider-docs-contract.test.ts). |
| Provider/plugin children use fixed argument arrays, bounded execution, and Windows Job Object containment. | Avoid shell interpretation, unbounded output, and ordinary-descendant leaks. | [`tests/windows-secret-command-contract.test.ts`](../tests/windows-secret-command-contract.test.ts) and the secret-provider suite cover the public contract. |
| HTTP binds literal loopback by default; non-loopback operation requires explicit authentication/host configuration. | A local broker should not unexpectedly become a network service. | The ingress and session contract is described in [security.md](security.md) and [architecture.md](architecture.md); changes require targeted runtime tests. |
| Unknown or ambiguous routing and untrusted risk annotations do not lower risk. | A possibly wrong account/tool classification is safer to block than to guess. | The routing, matcher, and risk documentation contracts protect these published defaults. |
| Audit writes are fail-closed by default and output is redacted. | Losing auditability or writing sensitive context silently is unsafe for a credential broker. | [security.md](security.md) states the audit boundary and its explicit fail-open trade-off; changes require targeted runtime tests. |

[`tests/threat-model-docs-contract.test.ts`](../tests/threat-model-docs-contract.test.ts) keeps the public scope, links, threat rows, and material residual-risk qualifications from drifting away from these implementation contracts. It does not validate runtime behavior or replace adversarial testing and independent review.

## Guarantees and explicit non-goals

Miftah provides local control and containment around the configured wrapper surface. It does **not** claim to:

- sandbox an arbitrary plugin or native process;
- protect credential files from a hostile process running as the same OS user or a host administrator;
- constrain provider-side token scopes, authenticate a human, or prove an upstream identity is authorized;
- prevent all side effects after an upstream has accepted an operation;
- provide a remotely anchored immutable audit log, a cryptographic signature, or nonrepudiation; or
- solve package provenance, whole-host denial of service, or a compromised local daemon.

These are design boundaries, not permission to ignore them. Use separate OS identities or an appropriately configured OS/container sandbox for stronger native isolation; use least-privilege provider credentials; preserve audit evidence in an independently protected destination; and treat local plugin and daemon changes as privileged deployment changes.

## Operator deployment responsibilities

- Keep the host, Node runtime, package dependencies, and configured provider binaries patched and review their provenance.
- Review every configuration, plugin, provider, container image, generated mount, and remote upstream before enabling it.
- Use unique least-privilege provider credentials per account/risk level; never put real values in commits, examples, tickets, or support logs.
- Keep remote upstream endpoints on HTTPS with certificate validation enabled. Use non-loopback local HTTP only when an explicit bearer, exact allowed hosts/origins, and the surrounding network controls are appropriate.
- Use a protected audit destination if integrity evidence must survive a local-host compromise, and retain/export only the data required for operations or incident response.
- Report suspected vulnerabilities privately under the [security policy](../SECURITY.md), not in public issues or pull requests containing exploit details.

## Independent review status

**Current project status (2026-07-14): not yet commissioned.** This document does not claim an independent review, an external finding count, or remediation of findings that have not been reported. The maintainer-authored controls above are implementation statements, not a substitute for external assurance.

The planned independent review scope is the security-critical implementation and its tests: configuration/schema parsing; secret resolution and redaction; child-process and Windows Job Object containment; profile/runtime and container isolation; local HTTP ingress/session handling; routing, policy, approval, and identity boundaries; audit confidentiality/integrity; local plugins and dependency/supply-chain controls; and denial-of-service/capacity behavior. Reviewers should test negative paths and trust-boundary crossings, not only happy-path configuration.

The release target in [#37](https://github.com/mohanagy/miftah/issues/37) is to publish the review completion and a high-level remediation status before `1.0`, without publishing proof-of-concept details prematurely. Any critical or high finding must be remediated or have an explicit release-blocking decision; no unresolved critical/high finding may remain at release. Vulnerability disclosure timing follows the [security policy](../SECURITY.md).

## Maintenance and review

Maintainers update this model when introducing a new secret source, child execution path, transport, persistent state, routing signal, policy capability, plugin interface, audit destination, or deployment boundary. Each change should add a focused test for the security behavior it relies on, run the relevant platform matrix, and revisit the matching residual-risk row. Material findings from the independent review will be summarized here at a level that does not create a new exploit guide.
