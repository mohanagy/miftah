import type { AuditTrail } from "../audit/audit-trail.js";
import type { OAuthCredentialState, OAuthIdentityState } from "./connection-types.js";

export type OAuthConnectionLifecycleAuditAction = "register" | "connect" | "refresh" | "reauth-required" | "disconnect" | "identity";

/** Safe lifecycle information that may be recorded in the local audit journal. */
export interface OAuthConnectionLifecycleAuditEvent {
  readonly action: OAuthConnectionLifecycleAuditAction;
  readonly profile: string;
  readonly upstream: string;
  readonly credentialState: OAuthCredentialState;
  readonly identityState: OAuthIdentityState;
  readonly status: "success" | "failure";
  readonly errorCode?: string;
}

/** Internal port so credential lifecycle code stays independent from a particular audit backend. */
export interface OAuthConnectionLifecycleAuditSink {
  record(event: OAuthConnectionLifecycleAuditEvent): Promise<void>;
}

/**
 * Adapts OAuth lifecycle transitions to the established audit journal without serializing an
 * OAuth reference, resource, issuer, registration, scope, identity evidence, or any credential.
 */
export class AuditTrailOAuthConnectionAuditSink implements OAuthConnectionLifecycleAuditSink {
  constructor(private readonly auditTrail: AuditTrail) {}

  async record(event: OAuthConnectionLifecycleAuditEvent): Promise<void> {
    await this.auditTrail.writeLifecycle({
      operation: `oauth/${event.action}`,
      name: "connection",
      profile: event.profile,
      upstream: event.upstream,
      status: event.status,
      ...(event.errorCode === undefined ? {} : { errorCode: event.errorCode }),
      oauthConnectionState: event.credentialState,
      oauthIdentityState: event.identityState
    });
  }
}
