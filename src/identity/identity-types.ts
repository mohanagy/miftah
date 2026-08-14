import type { IdentityFingerprint } from "../config/types.js";

/** Safe lifecycle states for a configured upstream identity verifier. */
export type IdentityVerificationStatus =
  | "unconfigured"
  | "not-verified"
  | "verified"
  | "expired"
  | "mismatch"
  | "unsupported"
  | "failed";

/** Durable account-binding state, kept separate from live-session verification. */
export type IdentityBindingState = "verified" | "unverified" | "changed" | "expired" | "unavailable";

/** Bounded explanation of why a configured identity capability cannot be used. */
export interface IdentityProbeCapabilityDiagnostic {
  readonly status: "unsupported";
  readonly tool: string;
  readonly requirement: "read-only-no-required-input";
  readonly reason: "tool-not-found" | "not-read-only" | "input-schema-not-safe";
}

/** A bounded, non-secret identity verification result safe for status and audit surfaces. */
export interface IdentityStatus {
  status: IdentityVerificationStatus;
  profile: string;
  upstream: string;
  expected?: IdentityFingerprint;
  actual?: IdentityFingerprint;
  verifiedAt?: string;
  /** Present only when this runtime has a durable binding store. */
  bindingState?: IdentityBindingState;
  /** Previously verified, bounded evidence loaded from or written to the binding store. */
  bound?: IdentityFingerprint;
  boundAt?: string;
  /** Present only for a discovered capability mismatch; it never contains upstream output. */
  capability?: IdentityProbeCapabilityDiagnostic;
  errorCode?:
    | "IDENTITY_MISMATCH"
    | "IDENTITY_BINDING_UNAVAILABLE"
    | "IDENTITY_PROBE_UNSUPPORTED"
    | "IDENTITY_VERIFICATION_FAILED";
}

/** Removes persisted evidence duplicated from the bounded live result before journaling. */
export function identityStatusForAudit(status: IdentityStatus): IdentityStatus {
  const auditStatus = structuredClone(status);
  delete auditStatus.bound;
  delete auditStatus.boundAt;
  return auditStatus;
}
