import type { ProfileConfig, RoutingConfig, RoutingRule } from "../config/types.js";
import { MiftahError } from "../utils/errors.js";
import { matchProviderBindings, projectProviderMatcherInput } from "./provider-matchers.js";
import type { ProviderMatcherCandidate } from "./provider-matcher-types.js";
import type { RoutingDecision, RoutingInput, RoutingMatcherEvidence } from "./routing-types.js";

const MAX_ROUTING_MATCHER_EVIDENCE = 64;

function getPath(input: RoutingInput, path: string): unknown {
  const [root, ...parts] = path.split(".");
  const source = root === "args" ? input.args : root === "context" ? input.context : undefined;
  return parts.reduce<unknown>((value, part) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[part];
  }, source);
}

function matches(rule: RoutingRule, input: RoutingInput): boolean {
  return Object.entries(rule.when).every(([path, expected]) => {
    const actual = getPath(input, path);

    if (path.startsWith("context.") && Array.isArray(actual)) {
      return actual.some((value) => isScalar(value) && isScalar(expected) && matchesValue(value, expected));
    }

    return matchesValue(actual, expected);
  });
}

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (typeof expected === "string" && expected.includes("*")) {
    const pattern = new RegExp(`^${expected.split("*").map(escapeRegExp).join(".*")}$`);
    return typeof actual === "string" && pattern.test(actual);
  }
  return actual === expected;
}

function isScalar(value: unknown): boolean {
  return value === null || (typeof value !== "object" && typeof value !== "function");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class RoutingEngine {
  constructor(
    private readonly config: RoutingConfig = {},
    private activeProfile: string,
    private readonly defaultProfile = activeProfile,
    private readonly profiles: Readonly<Record<string, ProfileConfig>> = {}
  ) {}

  setActiveProfile(profile: string): void {
    this.activeProfile = profile;
  }

  resolve(input: RoutingInput, activeProfile = this.activeProfile): RoutingDecision {
    const environmentHint = input.profileHints?.find((hint) => hint.source === "environment");
    if (environmentHint) {
      return { profile: environmentHint.profile, reason: "profile-hint:environment" };
    }

    const markerProfiles = [
      ...new Set(
        (input.profileHints ?? [])
          .filter((hint) => hint.source === "project-marker")
          .map((hint) => hint.profile)
      )
    ].sort();
    if (markerProfiles.length > 1) {
      throw new MiftahError(
        "ROUTING_AMBIGUOUS",
        `ROUTING_AMBIGUOUS: project-marker profile hints are ${markerProfiles.join(", ")}`
      );
    }
    if (markerProfiles.length === 1) {
      return { profile: markerProfiles[0]!, reason: "profile-hint:project-marker" };
    }

    const matchingRules = (this.config.rules ?? []).filter((rule) => matches(rule, input));
    const profiles = [...new Set(matchingRules.map((rule) => rule.profile))];
    if (profiles.length > 1) {
      throw new MiftahError(
        "ROUTING_AMBIGUOUS",
        `ROUTING_AMBIGUOUS: matching profiles are ${profiles.join(", ")}`
      );
    }
    if (profiles.length === 1) {
      const rule = matchingRules.find((candidate) => candidate.profile === profiles[0]);
      return { profile: profiles[0]!, reason: `rule:${rule?.name ?? "unnamed"}` };
    }

    const matcherCandidates = matchProviderBindings(
      this.profiles,
      projectProviderMatcherInput(input.matcherToolName ?? input.toolName, input.args, input.matcherContext)
    );
    const matcherProfiles = [...new Set(matcherCandidates.map((candidate) => candidate.profile))].sort();
    const matcherEvidence = routingMatcherEvidence(matcherCandidates);
    if (matcherProfiles.length > 1) {
      throw new MiftahError(
        "ROUTING_AMBIGUOUS",
        `ROUTING_AMBIGUOUS: static matcher profiles are ${matcherProfiles.join(", ")}`,
        { matcherEvidence }
      );
    }
    if (matcherProfiles.length === 1) {
      return {
        profile: matcherProfiles[0]!,
        reason: `matcher:${matcherEvidence[0]!.provider}`,
        matcherEvidence
      };
    }

    const fallback = this.config.fallback ?? "activeProfile";
    if (fallback === "activeProfile") return { profile: activeProfile, reason: "active-profile" };
    if (fallback === "default") return { profile: this.defaultProfile, reason: "default-profile" };
    if (fallback === "block") {
      throw new MiftahError("ROUTING_BLOCKED", "ROUTING_BLOCKED: no routing rule matched this request");
    }
    throw new MiftahError(
      "ROUTING_AMBIGUOUS",
      "ROUTING_AMBIGUOUS: no routing rule matched this request"
    );
  }
}

function routingMatcherEvidence(candidates: readonly ProviderMatcherCandidate[]): readonly RoutingMatcherEvidence[] {
  return candidates.slice(0, MAX_ROUTING_MATCHER_EVIDENCE).map((candidate) => ({
    profile: candidate.profile,
    provider: candidate.evidence.provider,
    kind: candidate.evidence.kind,
    value: candidate.evidence.value
  }));
}

/** Extracts only structurally safe static-matcher evidence from an ambiguity error. */
export function matcherEvidenceFromError(error: unknown): readonly RoutingMatcherEvidence[] | undefined {
  if (!(error instanceof MiftahError) || error.code !== "ROUTING_AMBIGUOUS") return undefined;
  const source = error.details?.matcherEvidence;
  if (!Array.isArray(source) || source.length === 0 || source.length > MAX_ROUTING_MATCHER_EVIDENCE) return undefined;
  const evidence: RoutingMatcherEvidence[] = [];
  for (const item of source) {
    if (!isRoutingMatcherEvidence(item)) return undefined;
    evidence.push({
      profile: item.profile,
      provider: item.provider,
      kind: item.kind,
      value: item.value
    });
  }
  return isSortedMatcherEvidence(evidence) ? evidence : undefined;
}

function isRoutingMatcherEvidence(value: unknown): value is RoutingMatcherEvidence {
  if (!isRecord(value) || !isBoundedPlainText(value.profile, 256) || !isBoundedPlainText(value.value, 256)) return false;
  if (value.value.includes("?") || value.value.includes("#") || value.value.includes("@")) return false;
  return (
    (value.provider === "github" && (value.kind === "repository" || value.kind === "organization")) ||
    (value.provider === "sentry" && (value.kind === "organization" || value.kind === "project" || value.kind === "environment")) ||
    (value.provider === "jira" && (value.kind === "site" || value.kind === "project")) ||
    (value.provider === "linear" && (value.kind === "workspace" || value.kind === "team")) ||
    (value.provider === "posthog" && (value.kind === "host" || value.kind === "project"))
  );
}

function isBoundedPlainText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSortedMatcherEvidence(evidence: readonly RoutingMatcherEvidence[]): boolean {
  for (let index = 1; index < evidence.length; index += 1) {
    if (compareMatcherEvidence(evidence[index - 1]!, evidence[index]!) > 0) return false;
  }
  return true;
}

function compareMatcherEvidence(first: RoutingMatcherEvidence, second: RoutingMatcherEvidence): number {
  for (const comparison of [
    compareText(first.provider, second.provider),
    compareText(first.kind, second.kind),
    compareText(first.value, second.value),
    compareText(first.profile, second.profile)
  ]) {
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareText(first: string, second: string): number {
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}
