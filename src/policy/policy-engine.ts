import type { PolicyConfig, RiskLevel } from "../config/types.js";
import type { PolicyDecision } from "./policy-types.js";
import { classifyToolRisk, type RiskClassifierOptions, type ToolRiskMetadata } from "./risk-classifier.js";

/** Matches a tool name against an anchored glob pattern where `*` spans any characters. */
function matchesPattern(value: string, pattern: string): boolean {
  const regex = new RegExp(`^${pattern.split("*").map(escapeRegExp).join(".*")}$`);
  return regex.test(value);
}

/** Escapes regular-expression metacharacters before a glob segment is compiled. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Evaluates tool calls against named policies and risk overrides. */
export class PolicyEngine {
  /** Creates an engine from policy definitions and optional per-tool risk overrides. */
  constructor(
    private readonly policies: Record<string, PolicyConfig> = {},
    private readonly riskOverrides: Record<string, RiskLevel> = {},
    private readonly riskOptions: Omit<RiskClassifierOptions, "overrides"> = {}
  ) {}

  /** Returns whether a tool call is allowed, denied, or requires confirmation. */
  evaluate(policyName: string | undefined, toolName: string, metadata?: ToolRiskMetadata): PolicyDecision {
    const classification = classifyToolRisk(toolName, { ...this.riskOptions, overrides: this.riskOverrides }, metadata);
    const { risk } = classification;
    if (policyName !== undefined && !Object.hasOwn(this.policies, policyName)) {
      return { action: "deny", ...classification };
    }
    const policy = policyName !== undefined ? this.policies[policyName] : undefined;
    if (!policy) return { action: "allow", ...classification };
    if (policy.deny?.some((pattern) => matchesPattern(toolName, pattern))) {
      return { action: "deny", ...classification };
    }
    const allowed = policy.allowRisk ?? policy.allow;
    if (policy.denyRisk?.includes(risk) || (allowed && !allowed.includes(risk))) {
      return { action: "deny", ...classification };
    }
    if (policy.requireConfirmation?.some((pattern) => matchesPattern(toolName, pattern) || pattern === risk)) {
      return { action: "confirm", ...classification };
    }
    return { action: "allow", ...classification };
  }
}
