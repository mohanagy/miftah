import type { RoutingConfig, RoutingRule } from "../config/types.js";
import { MiftahError } from "../utils/errors.js";
import type { RoutingDecision, RoutingInput } from "./routing-types.js";

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
    private readonly defaultProfile = activeProfile
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
