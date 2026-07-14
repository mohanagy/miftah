import type { ProfileConfig, RoutingConfig, RoutingRule } from "../config/types.js";
import type { PluginRegistry, PluginRoutingCandidate } from "../plugins/plugin-registry.js";
import { MiftahError } from "../utils/errors.js";
import {
  isCanonicalProviderMatcherEvidence,
  matchProviderBindings,
  projectProviderMatcherInput
} from "./provider-matchers.js";
import type {
  ProviderMatcherCandidate,
  ProviderMatcherKind,
  ProviderMatcherProvider
} from "./provider-matcher-types.js";
import type { RoutingDecision, RoutingInput, RoutingMatcherEvidence } from "./routing-types.js";

const MAX_ROUTING_MATCHER_EVIDENCE = 64;
const pluginIdentifierPattern = /^[a-z][a-z0-9-]{0,63}$/u;
const pluginBindingPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

type MatcherCandidate =
  | {
      readonly profile: string;
      readonly evidence: {
        readonly provider: ProviderMatcherProvider;
        readonly kind: ProviderMatcherKind;
        readonly value: string;
      };
    }
  | {
      readonly profile: string;
      readonly evidence: {
        readonly provider: `plugin:${string}`;
        readonly kind: "binding";
        readonly value: string;
      };
    };

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
    private readonly profiles: Readonly<Record<string, ProfileConfig>> = {},
    private readonly plugins?: PluginRegistry
  ) {}

  setActiveProfile(profile: string): void {
    this.activeProfile = profile;
  }

  resolve(input: RoutingInput, activeProfile = this.activeProfile): RoutingDecision {
    const preliminary = this.resolvePreMatcher(input);
    if (preliminary !== undefined) return preliminary;
    return this.resolveMatcherBand(input, activeProfile);
  }

  /** Runs local routing plugins only after higher-precedence hints and explicit rules do not decide the request. */
  async resolveWithPlugins(
    input: RoutingInput,
    activeProfile = this.activeProfile,
    signal?: AbortSignal
  ): Promise<RoutingDecision> {
    const preliminary = this.resolvePreMatcher(input);
    if (preliminary !== undefined || this.plugins?.hasRoutingMatchers() !== true) {
      return preliminary ?? this.resolveMatcherBand(input, activeProfile);
    }
    const matcherInput = this.projectMatcherInput(input);
    const pluginCandidates = await this.plugins.matchRouting(input.matcherToolName ?? input.toolName, matcherInput, signal);
    return this.resolveMatcherBand(input, activeProfile, pluginCandidates, matcherInput);
  }

  private resolvePreMatcher(input: RoutingInput): RoutingDecision | undefined {
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

    return undefined;
  }

  private resolveMatcherBand(
    input: RoutingInput,
    activeProfile: string,
    pluginCandidates: readonly PluginRoutingCandidate[] = [],
    matcherInput = this.projectMatcherInput(input)
  ): RoutingDecision {
    const matcherCandidates = [
      ...staticMatcherCandidates(this.profiles, matcherInput),
      ...pluginCandidates.map(pluginMatcherCandidate)
    ];
    const matcherProfiles = [...new Set(matcherCandidates.map((candidate) => candidate.profile))].sort();
    const matcherEvidence = routingMatcherEvidence(matcherCandidates);
    if (matcherProfiles.length > 1) {
      throw new MiftahError(
        "ROUTING_AMBIGUOUS",
        `ROUTING_AMBIGUOUS: matcher profiles are ${matcherProfiles.join(", ")}`,
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

  private projectMatcherInput(input: RoutingInput) {
    return projectProviderMatcherInput(input.matcherToolName ?? input.toolName, input.args, input.matcherContext);
  }
}

function staticMatcherCandidates(
  profiles: Readonly<Record<string, ProfileConfig>>,
  input: ReturnType<typeof projectProviderMatcherInput>
): readonly MatcherCandidate[] {
  return matchProviderBindings(profiles, input).map(staticMatcherCandidate);
}

function staticMatcherCandidate(candidate: ProviderMatcherCandidate): MatcherCandidate {
  return { profile: candidate.profile, evidence: candidate.evidence };
}

function pluginMatcherCandidate(candidate: PluginRoutingCandidate): MatcherCandidate {
  return {
    profile: candidate.profile,
    evidence: { provider: `plugin:${candidate.pluginId}`, kind: "binding", value: candidate.binding }
  };
}

function routingMatcherEvidence(candidates: readonly MatcherCandidate[]): readonly RoutingMatcherEvidence[] {
  return candidates
    .map(toRoutingMatcherEvidence)
    .sort(compareMatcherEvidence)
    .slice(0, MAX_ROUTING_MATCHER_EVIDENCE);
}

function toRoutingMatcherEvidence(candidate: MatcherCandidate): RoutingMatcherEvidence {
  if (candidate.evidence.kind === "binding") {
    return {
      profile: candidate.profile,
      provider: candidate.evidence.provider,
      kind: "binding",
      value: candidate.evidence.value
    };
  }
  return {
    profile: candidate.profile,
    provider: candidate.evidence.provider,
    kind: candidate.evidence.kind,
    value: candidate.evidence.value
  };
}

/** Extracts only structurally safe static-matcher evidence from an ambiguity error. */
export function matcherEvidenceFromError(error: unknown): readonly RoutingMatcherEvidence[] | undefined {
  if (!(error instanceof MiftahError) || error.code !== "ROUTING_AMBIGUOUS") return undefined;
  const source = error.details?.matcherEvidence;
  if (!Array.isArray(source) || source.length === 0 || source.length > MAX_ROUTING_MATCHER_EVIDENCE) return undefined;
  const evidence: RoutingMatcherEvidence[] = [];
  for (const item of source) {
    if (!isRoutingMatcherEvidence(item)) return undefined;
    evidence.push(item);
  }
  return isSortedMatcherEvidence(evidence) ? evidence : undefined;
}

function isRoutingMatcherEvidence(value: unknown): value is RoutingMatcherEvidence {
  if (!isRecord(value) || !isBoundedPlainText(value.profile, 256) || !isBoundedPlainText(value.value, 256)) return false;
  if (
    typeof value.provider === "string" &&
    typeof value.kind === "string" &&
    value.provider.startsWith("plugin:")
  ) {
    return (
      value.kind === "binding" &&
      pluginIdentifierPattern.test(value.provider.slice("plugin:".length)) &&
      pluginBindingPattern.test(value.value)
    );
  }
  return isCanonicalProviderMatcherEvidence(value.provider, value.kind, value.value);
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
