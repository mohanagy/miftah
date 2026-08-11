# MRTR and Tasks Decision

Status: Multi Round-Trip Requests are implemented for confirmation workflows. The Tasks extension remains unimplemented until the interoperability and durability gates below are met.

Issue: [#366](https://github.com/mohanagy/miftah/issues/366)

Specification sources: [MCP 2026-07-28 announcement](https://blog.modelcontextprotocol.io/posts/2026-07-28/), [SEP-2322 MRTR](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2322), [SEP-2663 Tasks extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2663), [Tasks overview](https://modelcontextprotocol.io/extensions/tasks/overview), and the [experimental Tasks repository](https://github.com/modelcontextprotocol/ext-tasks)

## Decision

Miftah uses `input_required` for operations that are otherwise ready to run but need one exact human confirmation. This covers policy approval and account/profile transition confirmation. The response embeds a generic form request; the client returns `inputResponses` and the byte-exact opaque `requestState` on a fresh retry.

Missing setup data and recovery are not converted into MRTR in this release. Setup is a local CLI or Console workflow that may change configuration and credentials, while recovery currently returns bounded diagnostics and an explicit next action. Neither has one resumable MCP operation with a stable authorization boundary. Adding an interactive round merely to gather arbitrary configuration would widen the credential and mutation surface.

The `io.modelcontextprotocol/tasks` extension remains unimplemented. No evaluated Miftah operation currently clears all selection gates, and the extension is still explicitly experimental. Consequently there is no selected Miftah task and the requirement for a durable task identifier plus authenticated lookup is not applicable yet. Miftah makes no Tasks interoperability claim.

## MRTR security and lifecycle contract

- Form MRTR is enabled only when the client declares `elicitation.form`. The embedded request contains only a generic boolean `approved` field and no target arguments, profile-context handle, credential, or continuation secret.
- Continuation state is short-lived, integrity protected, bounded in memory, and bound to the exact source profile, selected profile, upstream, operation, target, normalized arguments, and authenticated request-context correlation when present.
- A mismatched operation, profile, handle, chat, or principal cannot consume another request's state. Accepted state is consumed atomically before upstream work and cannot be replayed.
- A declined, expired, malformed, missing, or already-consumed response fails closed. A rejected mismatch does not consume the legitimate caller's pending continuation.
- The approval check happens before acquiring the selected upstream. Cancelling later work propagates the request signal to that upstream, records `REQUEST_CANCELLED`, releases the request-scoped modern runtime, and does not create or change a profile lock or lease.
- Clients without the declared form capability receive `POLICY_CONFIRMATION_REQUIRED` (or the corresponding profile-confirmation code) and an actionable explanation. No bearer is disclosed in the default human mode. The existing explicitly configured `delegated-agent` fallback remains connection-bound and one-time for legacy automation.

## Audit outcome vocabulary

The audit journal distinguishes each workflow state without storing `requestState`, input responses, profile-context handles, or full operation arguments:

| Workflow meaning | Audit representation |
| --- | --- |
| Incomplete and waiting for input | operation status `confirmation-required`, plus approval action `requested` |
| Cancelled by the caller | operation status `cancelled` with `REQUEST_CANCELLED` |
| Failed or rejected | operation status `failure` with a stable redacted error code |
| Completed | operation status `success`; an approved MRTR also records `approved` then `consumed` |

Each request round has its own operation record. A confirmation-required first round is therefore complete as a protocol exchange but incomplete as the requested business operation.

## Tasks evaluation

| Candidate | Decision | Reason |
| --- | --- | --- |
| Upstream startup | Defer | Startup is lazy and bounded by configured timeouts. A task must not hide a failed child start or keep an orphan process after cancellation. |
| OAuth authorization | Defer | Browser authorization already uses an issuer-bound connection identity and an explicit loopback handoff. A task would require durable encrypted state, authenticated owner lookup, expiry, and a supported client resume flow. |
| Diagnostics and readiness | Defer | `doctor`, `test-profile`, and health checks are bounded status operations with explicit redacted results; converting them would add polling without a demonstrated latency need. |
| Audit export | Defer | Export is a local CLI snapshot to an explicit private path, not a remote MCP operation. Turning it into a task would introduce remote file ownership and download authorization questions. |
| Recovery | Defer | Current recovery returns stable error codes and concrete next commands. No single recovery action is both long-running and safe to resume automatically. |

Tasks may be reconsidered only when all of these gates are satisfied:

1. the extension and Miftah's SDK line expose a supported end-to-end server and client contract;
2. a supported real host demonstrates one concrete operation that routinely exceeds a normal request budget;
3. the task store has a durable opaque identifier, authenticated principal/chat/profile ownership, bounded expiry, encrypted sensitive state, idempotent creation, and atomic terminal transitions;
4. `tasks/get`, `tasks/update`, and `tasks/cancel` enforce the same ownership for task lookup and terminal result retrieval, `inputResponses` updates, and cancellation, and survive process or connection loss;
5. cancellation proves no profile lock, lease, OAuth handoff, process reservation, or upstream child is left behind;
6. packaged interoperability tests cover reconnect, duplicate creation, replay, expiry, cancellation, redaction, and audit outcomes.

## Executable evidence and claim boundary

- The packed-artifact contract starts the installed `miftah serve --transport http`, connects the supported MCP TypeScript client in the modern era, completes one form round trip, verifies one upstream mutation, and checks `requested`, `approved`, and `consumed` audit actions.
- The stateless profile-context runtime test alternates two authenticated chats against fresh request-scoped servers. A stolen continuation with the other chat's valid handle fails, the original chat succeeds once, and replay fails.
- The modern HTTP cancellation test observes one upstream cancellation notification, request-scoped upstream cleanup, unchanged `none`/`not-required` lock and lease state, and the explicit cancelled audit outcome.
- Source and package tests establish Miftah behavior with the supported TypeScript client. They do not establish Tasks compatibility or compatibility with an untested host.

## Stop rule

Do not implement or advertise Tasks because an operation is merely asynchronous or inconvenient. Stop unless a real supported client, a concrete long-running Miftah use case, authenticated durable ownership, cleanup semantics, and packaged reconnect evidence all exist together.
