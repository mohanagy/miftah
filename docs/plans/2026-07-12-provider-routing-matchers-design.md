# Provider Routing Matchers Design

## Goal

Add deterministic, opt-in routing signals for common provider identifiers without granting routing code access to credentials, subprocesses, filesystem discovery, or the network.

## Alternatives considered

1. Load arbitrary JavaScript matcher modules from configuration. This would make the routing trust boundary unenforceable and belongs to the later extension API work (#34).
2. Use a generic selector DSL at top level. It would be difficult to validate, would expose too much raw request data, and would make safe evidence ambiguous.
3. Use typed, profile-local declarative bindings backed by a fixed in-tree registry. This keeps account attribution visible in the profile that owns it and is the selected design.

## Selected contract

`profiles.<profile>.routing.match` is optional. When present, it has only known provider keys (`github`, `sentry`, `jira`, `linear`, and `posthog`) and typed arrays of canonical, bounded non-secret identifiers. For example, a GitHub profile may declare repositories, organizations, and git remotes; Sentry may declare organizations, projects, environments, and issue identifiers. Multiple profiles may deliberately claim the same identifier, but a request that produces distinct profile candidates fails with the existing stable `ROUTING_AMBIGUOUS` error.

The existing top-level `routing.plugins` declaration remains rejected: it would imply dynamic code loading. #30 creates an internal static registry only; #34 owns a public/dynamic extension contract.

## Data flow and trust boundary

The routing engine continues to prefer explicit environment and marker hints, then explicit `routing.rules`. It invokes static matchers only before fallback. A matcher receives a bounded projection of the tool name, recognized scalar argument fields, and already-sanitized routing context. It returns canonical candidate identifiers and safe evidence such as `{ provider: "github", kind: "repository", value: "owner/repository" }`; raw URLs with userinfo, query strings, fragments, or unrecognized nested values never enter evidence.

The engine emits `matcher:<provider>` as the reason. That intentionally does not satisfy the existing destructive-operation requirement for an explicit `rule:`. The same safe matcher evidence is attached to route preview and to the operation audit event; an ambiguity is never forwarded upstream.
