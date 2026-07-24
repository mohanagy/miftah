import type { PolicyConfig, RiskLevel } from "../config/types.js";

export type PolicyAction = "allow" | "deny" | "confirm";
export type RiskClassificationSource =
  | "local-override"
  | "trusted-upstream-annotation"
  | "trusted-provider-adapter"
  | "trusted-command-adapter"
  | "annotation-conflict"
  | "name-heuristic"
  | "unknown-default";
export type RiskClassificationConfidence = "high" | "medium" | "low";

/** The four MCP behavioral hints that can inform risk only after explicit upstream trust. */
export interface ToolRiskAnnotations {
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface RiskClassification {
  risk: RiskLevel;
  riskSource: RiskClassificationSource;
  riskConfidence: RiskClassificationConfidence;
}

export interface PolicyDecision extends RiskClassification {
  action: PolicyAction;
}

export type { PolicyConfig, RiskLevel };
