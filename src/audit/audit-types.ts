import type {
  PolicyAction,
  RiskClassificationConfidence,
  RiskClassificationSource,
  RiskLevel
} from "../policy/policy-types.js";
import type { RoutingContextEvidence } from "../routing/routing-types.js";
import type { IdentityStatus } from "../identity/identity-types.js";

export type AuditFailureMode = "fail-open" | "fail-closed";

export interface AuditWriteFailure {
  timestamp: string;
  errorCode: "AUDIT_WRITE_FAILED";
  message: string;
}

export interface AuditHealth {
  state: "healthy" | "failed";
  lastFailure?: AuditWriteFailure;
}

export type AuditEventKind = "operation" | "lifecycle";
export type AuditStatus = "success" | "failure" | "blocked" | "denied" | "confirmation-required" | "ambiguous";
export type AuditRoutingSource = "rule" | "active-profile" | "default-profile";

export interface AuditEvent {
  wrapper: string;
  profile: string;
  kind?: AuditEventKind;
  eventId?: string;
  requestId?: string;
  sessionId?: string;
  sourceProfile?: string;
  upstream?: string;
  lockToProfile?: string;
  operation: "tools/call" | "resources/read" | "prompts/get" | string;
  name: string;
  status: AuditStatus;
  durationMs: number;
  routingReason?: string;
  routingSource?: AuditRoutingSource;
  policyName?: string;
  policyDecision?: PolicyAction;
  risk?: RiskLevel;
  riskSource?: RiskClassificationSource;
  riskConfidence?: RiskClassificationConfidence;
  identity?: IdentityStatus | readonly IdentityStatus[];
  routingEvidence?: RoutingContextEvidence;
  arguments?: unknown;
  errorCode?: string;
}
