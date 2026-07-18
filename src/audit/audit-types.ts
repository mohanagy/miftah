import type {
  PolicyAction,
  RiskClassificationConfidence,
  RiskClassificationSource,
  RiskLevel
} from "../policy/policy-types.js";
import type { RoutingContextEvidence, RoutingMatcherEvidence } from "../routing/routing-types.js";
import type { IdentityStatus } from "../identity/identity-types.js";
import type { ProfileLeaseStatus, ProfileLockStatus, ProfileSelection } from "../profiles/profile-manager.js";
import type { ApprovalMechanism } from "../approvals/approval-store.js";

export type AuditFailureMode = "fail-open" | "fail-closed";

/** Immutable version marker for JSONL records written by the current audit journal. */
export const AUDIT_RECORD_SCHEMA_VERSION = 1 as const;

/** Opt-in local JSONL journal rotation and archive retention settings. */
export interface AuditRotationOptions {
  /** Rotate before a complete write would make the active segment larger than this many bytes. */
  readonly maxBytes?: number;
  /** Rotate on the next write after the active segment has reached this age. */
  readonly maxAgeMs?: number;
  /** Maximum number of regular managed archive segments to retain. */
  readonly retainFiles: number;
}

/** Optional local tamper-evidence format for redacted audit records. */
export interface AuditIntegrityOptions {
  readonly algorithm: "sha256-chain";
}

export interface AuditWriteFailure {
  timestamp: string;
  errorCode: "AUDIT_WRITE_FAILED";
  message: string;
}

export interface AuditHealth {
  state: "healthy" | "failed";
  lastFailure?: AuditWriteFailure;
}

export type AuditEventKind = "operation" | "lifecycle" | "approval" | "profile";
export type AuditStatus = "success" | "failure" | "blocked" | "denied" | "confirmation-required" | "ambiguous";
export type AuditRoutingSource = "rule" | "matcher" | "active-profile" | "default-profile";
export type ApprovalAuditAction = "requested" | "approved" | "denied" | "expired" | "consumed";
export type ProfileAuditAction =
  | "confirmation-requested"
  | "confirmation-accepted"
  | "confirmation-denied"
  | "confirmation-expired"
  | "switch"
  | "reset"
  | "lock"
  | "unlock"
  | "lease-issued"
  | "lease-expired";

export interface AuditEvent {
  wrapper: string;
  profile: string;
  kind?: AuditEventKind;
  eventId?: string;
  requestId?: string;
  sessionId?: string;
  sourceProfile?: string;
  upstream?: string;
  approvalId?: string;
  approvalSessionId?: string;
  approvalAction?: ApprovalAuditAction;
  approvalMechanism?: ApprovalMechanism;
  profileAction?: ProfileAuditAction;
  expiresAt?: string;
  lockToProfile?: string;
  profileSelectionSource?: ProfileSelection["selectionSource"];
  profileConfirmation?: ProfileSelection["confirmation"];
  profileLeaseState?: ProfileLeaseStatus["state"];
  profileLeaseExpiresAt?: string;
  profileLockState?: ProfileLockStatus["state"];
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
  routingMatcherEvidence?: readonly RoutingMatcherEvidence[];
  arguments?: unknown;
  errorCode?: string;
}
