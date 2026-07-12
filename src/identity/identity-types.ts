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

/** A bounded, non-secret identity verification result safe for status and audit surfaces. */
export interface IdentityStatus {
  status: IdentityVerificationStatus;
  profile: string;
  upstream: string;
  expected?: IdentityFingerprint;
  actual?: IdentityFingerprint;
  verifiedAt?: string;
  errorCode?: "IDENTITY_MISMATCH" | "IDENTITY_PROBE_UNSUPPORTED" | "IDENTITY_VERIFICATION_FAILED";
}
