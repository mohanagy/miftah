import type { PolicyConfig, RiskLevel } from "../config/types.js";

export type PolicyAction = "allow" | "deny" | "confirm";

export interface PolicyDecision {
  action: PolicyAction;
  risk: RiskLevel;
}

export type { PolicyConfig, RiskLevel };
