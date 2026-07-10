import type { PolicyConfig, RiskLevel } from "../config/types.js";
import type { PolicyDecision } from "./policy-types.js";
import { classifyRisk } from "./risk-classifier.js";

function matchesPattern(value: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class PolicyEngine {
  constructor(
    private readonly policies: Record<string, PolicyConfig> = {},
    private readonly riskOverrides: Record<string, RiskLevel> = {}
  ) {}

  evaluate(policyName: string | undefined, toolName: string): PolicyDecision {
    const risk = classifyRisk(toolName, this.riskOverrides);
    const policy = policyName ? this.policies[policyName] : undefined;
    if (!policy) return { action: "allow", risk };
    if (policy.deny?.some((pattern) => matchesPattern(toolName, pattern))) {
      return { action: "deny", risk };
    }
    const allowed = policy.allowRisk ?? policy.allow;
    if (policy.denyRisk?.includes(risk) || (allowed && !allowed.includes(risk))) {
      return { action: "deny", risk };
    }
    if (policy.requireConfirmation?.some((pattern) => matchesPattern(toolName, pattern) || pattern === risk)) {
      return { action: "confirm", risk };
    }
    return { action: "allow", risk };
  }
}
