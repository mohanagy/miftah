import type { PolicyAction, RiskLevel } from "../policy/policy-types.js";

export interface AuditEvent {
  wrapper: string;
  profile: string;
  operation: "tools/call" | "resources/read" | "prompts/get" | string;
  name: string;
  status: "success" | "failure" | "blocked";
  durationMs: number;
  routingReason?: string;
  policyDecision?: PolicyAction;
  risk?: RiskLevel;
  arguments?: unknown;
  errorCode?: string;
}
