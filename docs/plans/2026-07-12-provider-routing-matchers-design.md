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

## Canonical grammar

Every declaration is ASCII, bounded to 256 bytes, and has no controls. GitHub repositories are lowercase `owner/repository` and organizations are lowercase slugs; an issue/PR URL and a Git remote normalize to that same repository key. Sentry organizations are lowercase slugs, projects are `organization/project`, and environments are safe ASCII labels. Jira sites are canonical HTTPS origins with no userinfo, query, fragment, or non-root path, and project keys are uppercase Jira-style identifiers. Linear workspaces/teams are lowercase slugs. PostHog hosts are canonical HTTPS origins with no credentials/query/fragment/path and projects are decimal IDs. Declarations reject duplicate canonical values.

Argument-only signals run only when the normalized tool name carries the exact provider token (for example, `github__search_issues`). A canonical provider URL or a canonical Git remote is a stronger signal and can identify its provider independently of the tool name. Matchers never inspect `MIFTAH_PROJECT`, arbitrary nested argument values, or arbitrary routing-context fields. Their only context inputs are normalized repository URLs/remotes and explicitly allowlisted package/workspace repository metadata.

Git remotes support canonical `https://github.com/owner/repository.git`, `ssh://git@github.com/owner/repository.git`, and `git@github.com:owner/repository.git` forms. Remotes containing user credentials, a query, a fragment, an unsupported host, or an invalid shape are omitted before routing evidence is created.

## Data flow and trust boundary

The routing engine continues to prefer explicit environment and marker hints, then explicit `routing.rules`. It invokes static matchers only before fallback. A matcher receives a bounded projection of the tool name, recognized scalar argument fields, and pre-normalized allowlisted repository metadata. It returns canonical candidate identifiers and safe evidence such as `{ provider: "github", kind: "repository", value: "owner/repository" }`; raw URLs with userinfo, query strings, fragments, or unrecognized nested values never enter evidence.

The engine emits `matcher:<provider>` as the reason. That intentionally does not satisfy the existing destructive-operation requirement for an explicit `rule:`. Candidates and evidence are deduplicated and sorted by provider, kind, value, and profile. On ambiguity, the routing error carries only that bounded safe evidence so the pipeline and preview can audit the blocked decision without forwarding it upstream.
