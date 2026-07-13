import type { RoutingConfig } from "../config/types.js";
import type { ProviderMatcherContext } from "./provider-matcher-types.js";

export interface RoutingInput {
  toolName: string;
  /** Client-visible tool name reserved for fixed provider matcher token recognition. */
  matcherToolName?: string;
  args?: Record<string, unknown>;
  context?: Record<string, unknown>;
  matcherContext?: ProviderMatcherContext;
  profileHints?: readonly RoutingContextProfileHint[];
}

/** Bounded, canonical static-matcher evidence safe for routing decisions and audit records. */
export interface RoutingMatcherEvidence {
  readonly profile: string;
  readonly provider: "github" | "sentry" | "jira" | "linear" | "posthog";
  readonly kind: "repository" | "organization" | "project" | "environment" | "site" | "workspace" | "team" | "host";
  readonly value: string;
}

export interface RoutingDecision {
  profile: string;
  reason: string;
  matcherEvidence?: readonly RoutingMatcherEvidence[];
}

/** A root supplied by an MCP client during initialization. */
export interface RoutingContextMcpRoot {
  readonly uri: string;
}

/** Inputs accepted by the internal, metadata-only routing context collector. */
export interface RoutingContextCollectorInput {
  readonly wrapperName: string;
  readonly knownProfileNames: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly runtimeConfigPath?: string;
  readonly mcpRoots?: readonly (string | RoutingContextMcpRoot)[];
  readonly gitExecutable?: string;
}

export interface RoutingContextProfileHint {
  readonly profile: string;
  readonly source: "environment" | "project-marker";
  readonly evidence:
    | { readonly kind: "environment"; readonly variable: "MIFTAH_PROFILE" }
    | { readonly kind: "marker"; readonly path: string };
}

export interface RoutingContextEvidence {
  readonly cwd: string;
  readonly fileRoots: readonly string[];
  readonly environment?: { readonly profile?: string; readonly hasProject?: true };
  readonly marker?: { readonly path: string };
  readonly package?: {
    readonly path: string;
    readonly name?: string;
    readonly repository?: string;
  };
  readonly workspace?: {
    readonly path: string;
    readonly name?: string;
    readonly repository?: string;
  };
  readonly git?: { readonly origin: string };
}

/** Immutable collector output for later routing, preview, and audit integration. */
export interface RoutingContextSnapshot {
  readonly context: Record<string, unknown>;
  readonly evidence: RoutingContextEvidence;
  readonly profileHints: readonly RoutingContextProfileHint[];
  /** Safe, canonical provider metadata reserved for the fixed matcher registry. */
  readonly matcherContext?: ProviderMatcherContext;
}

export type { RoutingConfig };
