/** Provider identifiers supported by Miftah's fixed in-tree routing matcher registry. */
export type ProviderMatcherProvider = "github" | "sentry" | "jira" | "linear" | "posthog";

/** Canonical identifier categories returned by the fixed provider matcher registry. */
export type ProviderMatcherKind =
  | "repository"
  | "organization"
  | "project"
  | "environment"
  | "site"
  | "workspace"
  | "team"
  | "host";

/** One canonical, bounded identifier that is safe for static matcher evaluation. */
export interface ProviderMatcherSignal {
  readonly provider: ProviderMatcherProvider;
  readonly kind: ProviderMatcherKind;
  readonly value: string;
  readonly source: "argument" | "context" | "url";
}

/** The strict projection consumed by the fixed static provider matcher registry. */
export interface ProviderMatcherInput {
  readonly signals: readonly ProviderMatcherSignal[];
}

/** Safe repository metadata emitted by the routing-context collector for provider matching. */
export interface ProviderMatcherContext {
  readonly githubRepositories: readonly string[];
}

/** Minimal safe evidence attached to a successful static matcher candidate. */
export interface ProviderMatcherEvidence {
  readonly provider: ProviderMatcherProvider;
  readonly kind: ProviderMatcherKind;
  readonly value: string;
}

/** One profile selected by a fixed matcher binding and its safe evidence. */
export interface ProviderMatcherCandidate {
  readonly profile: string;
  readonly evidence: ProviderMatcherEvidence;
}
