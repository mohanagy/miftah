import type { AuditScope } from "../../audit/audit-trail.js";
import type { ApprovalBinding } from "../../approvals/approval-store.js";
import { IdentityManager } from "../../identity/identity-manager.js";
import { PolicyEngine } from "../../policy/policy-engine.js";
import type { PolicyDecision } from "../../policy/policy-types.js";
import type { ToolRiskMetadata } from "../../policy/risk-classifier.js";
import { ProfileManager } from "../../profiles/profile-manager.js";
import { matcherEvidenceFromError, RoutingEngine } from "../../routing/routing-engine.js";
import type { RoutingContextSnapshot, RoutingDecision } from "../../routing/routing-types.js";
import { SecretRedactor } from "../../secrets/redact.js";
import { MultiUpstreamProcessManager } from "../../upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../../upstream/upstream-process-manager.js";
import type { UpstreamRequestOptions, UpstreamSession } from "../../upstream/upstream-session.js";
import { MiftahError } from "../../utils/errors.js";

export type ProxiedOperationType =
  | "tools/call"
  | "resources/read"
  | "resources/subscribe"
  | "resources/unsubscribe"
  | "prompts/get";

export type CapturedProfileState = Pick<
  ReturnType<ProfileManager["current"]>,
  "activeProfile" | "revision" | "selectionSource" | "confirmation" | "lease" | "lock"
>;

export interface ApprovalRequestContext {
  readonly requestId: string | number;
  readonly signal: AbortSignal;
}

export interface ResolvedOperation<Result> {
  readonly upstreamName?: string;
  readonly identityUpstreamName?: string;
  readonly name: string;
  execute(session: UpstreamSession, options?: UpstreamRequestOptions): Promise<Result>;
  redact(result: Result): Result;
}

export interface ProxiedOperation<Result> {
  readonly source: CapturedProfileState;
  readonly operation: ProxiedOperationType;
  readonly routingName: string;
  /** Client-visible name used only by fixed provider matcher token recognition. */
  readonly matcherToolName?: string;
  readonly policyName: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly riskMetadata?: ToolRiskMetadata;
  /** Reads only already-cached target risk evidence; it must not discover or start an upstream. */
  riskMetadataForProfile?(profile: string): ToolRiskMetadata | undefined;
  readonly approvalContext?: ApprovalRequestContext;
  /** Carries request lifecycle signals to the selected upstream after policy and approval checks complete. */
  readonly upstreamRequestOptions?: UpstreamRequestOptions;
  readonly requireExplicitRuleForDestructive?: boolean;
  readonly requireExplicitSelectionForDestructive?: boolean;
  resolveTarget(profile: string): Promise<ResolvedOperation<Result>>;
}

export type RoutingContextProvider = () => Promise<RoutingContextSnapshot>;

export type PolicyEnforcementResult =
  | { readonly status: "allowed" }
  | { readonly status: "blocked"; readonly errorCode: "POLICY_BLOCKED"; readonly message: string };

export interface PolicyEnforcementInput {
  readonly policyName: string;
  readonly route: RoutingDecision;
  readonly decision: PolicyDecision;
  readonly profile: string;
  readonly requireExplicitRuleForDestructive?: boolean;
}

/**
 * Evaluates the local policy boundary shared by real calls and route previews.
 * Returns serializable enforcement data so previews cannot claim a call would
 * be allowed when the execution path would block it.
 */
export function evaluatePolicyEnforcement(input: PolicyEnforcementInput): PolicyEnforcementResult {
  if (
    input.requireExplicitRuleForDestructive &&
    input.decision.risk === "destructive" &&
    !input.route.reason.startsWith("rule:")
  ) {
    return {
      status: "blocked",
      errorCode: "POLICY_BLOCKED",
      message: `POLICY_BLOCKED: destructive tool '${input.policyName}' requires an explicit routing rule`
    };
  }
  if (input.decision.action === "deny") {
    return {
      status: "blocked",
      errorCode: "POLICY_BLOCKED",
      message: `POLICY_BLOCKED: operation '${input.policyName}' is blocked for profile '${input.profile}'`
    };
  }
  return { status: "allowed" };
}

interface PipelineOptions {
  readonly profiles: ProfileManager;
  readonly routing: RoutingEngine;
  readonly policy: PolicyEngine;
  readonly upstreams: UpstreamProcessManager | MultiUpstreamProcessManager;
  readonly redactor: SecretRedactor;
  readonly routingContext: RoutingContextProvider;
  readonly identities: IdentityManager;
  readonly onSession?: (session: UpstreamSession, target: ResolvedOperation<unknown>) => void | Promise<void>;
  readonly approvals: {
    requireApproval(binding: ApprovalBinding, context?: ApprovalRequestContext): Promise<void>;
  };
  readonly profileAudits?: {
    leaseExpired(input: { source: CapturedProfileState; profile: string; operation: ProxiedOperationType }): Promise<void>;
  };
  readonly now?: () => Date;
}

/**
 * Applies the common safety sequence to every proxied MCP operation.
 */
export class OperationPipeline {
  private readonly now: () => Date;

  constructor(private readonly options: PipelineOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async execute<Result>(operation: ProxiedOperation<Result>, audit: AuditScope): Promise<Result> {
    try {
      const snapshot = await this.options.routingContext();
      audit.update({ routingEvidence: this.options.redactor.redactForAudit(snapshot.evidence) });
      const route = await this.options.routing.resolveWithPlugins(
        {
          toolName: operation.routingName,
          matcherToolName: operation.matcherToolName ?? operation.routingName,
          args: operation.args,
          context: snapshot.context,
          matcherContext: snapshot.matcherContext,
          profileHints: snapshot.profileHints
        },
        operation.source.activeProfile,
        operation.upstreamRequestOptions?.signal ?? operation.approvalContext?.signal
      );
      const profile = route.profile;
      const profileConfig = this.options.profiles.get(profile);
      const decision = this.options.policy.evaluate(
        profileConfig.policy,
        operation.policyName,
        operation.riskMetadataForProfile?.(profile) ?? operation.riskMetadata
      );
      audit.update({
        profile,
        routingReason: route.reason,
        routingSource: routingSource(route),
        policyName: profileConfig.policy ?? "default",
        policyDecision: decision.action,
        risk: decision.risk,
        riskSource: decision.riskSource,
        riskConfidence: decision.riskConfidence,
        ...(route.matcherEvidence === undefined
          ? {}
          : { routingMatcherEvidence: this.options.redactor.redactForAudit(route.matcherEvidence) })
      });
      this.updateSelectionAudit(audit, operation.source);
      this.assertPolicyAllows(operation, route, decision, profile);
      await this.assertProfileSelectionAllows(operation, profile, profileConfig.lease, decision.risk);

      const target = await operation.resolveTarget(profile);
      audit.update({
        name: this.auditName(operation, target.name),
        ...(target.upstreamName === undefined ? {} : { upstream: target.upstreamName })
      });
      if (decision.action === "confirm") {
        const binding: ApprovalBinding = {
          sourceProfile: operation.source.activeProfile,
          profile,
          upstream: target.upstreamName ?? "default",
          operation: operation.operation,
          name: target.name,
          displayName: this.auditName(operation, target.name),
          arguments: operation.args
        };
        await this.options.approvals.requireApproval(binding, operation.approvalContext);
      }
      const session = await this.options.upstreams.get(profile, target.upstreamName);
      await this.options.onSession?.(session, target);
      if (this.options.identities.requiresVerification(profile, target.identityUpstreamName, decision.risk)) {
        const identity = await this.options.identities.verify(profile, target.identityUpstreamName, session, {
          request: operation.upstreamRequestOptions
        });
        audit.update({ identity: this.options.redactor.redactForAudit(identity) });
        await this.options.identities.requireVerified(profile, target.identityUpstreamName, session, {
          request: operation.upstreamRequestOptions
        });
      }
      await this.assertProfileSelectionAllows(operation, profile, profileConfig.lease, decision.risk);
      return this.options.redactor.redact(target.redact(await target.execute(session, operation.upstreamRequestOptions)));
    } catch (error) {
      const safeError = this.toSafeError(error);
      const matcherEvidence = matcherEvidenceFromError(safeError);
      if (matcherEvidence !== undefined) {
        audit.update({ routingMatcherEvidence: matcherEvidence });
      }
      throw safeError;
    }
  }

  /** Throws the safe policy error when the routed operation is blocked by its enforcement decision. */
  private assertPolicyAllows(
    operation: ProxiedOperation<unknown>,
    route: RoutingDecision,
    decision: PolicyDecision,
    profile: string
  ): void {
    const enforcement = evaluatePolicyEnforcement({
      policyName: operation.policyName,
      route,
      decision,
      profile,
      requireExplicitRuleForDestructive: operation.requireExplicitRuleForDestructive
    });
    if (enforcement.status === "blocked") {
      throw new MiftahError(enforcement.errorCode, enforcement.message);
    }
  }

  private async assertProfileSelectionAllows(
    operation: ProxiedOperation<unknown>,
    profile: string,
    lease: { readonly requiredForRisk: readonly ("write" | "destructive")[] } | undefined,
    risk: "read" | "write" | "destructive"
  ): Promise<void> {
    const source = operation.source;
    if (
      operation.requireExplicitSelectionForDestructive === true &&
      risk === "destructive" &&
      !this.hasExplicitCurrentSessionSelection(source, profile)
    ) {
      throw new MiftahError(
        "PROFILE_SELECTION_REQUIRED",
        `PROFILE_SELECTION_REQUIRED: destructive operation '${operation.policyName}' requires an explicit current-session profile selection`
      );
    }
    if (lease === undefined || !lease.requiredForRisk.includes(risk as "write" | "destructive")) return;
    await this.assertCapturedLeaseAllows(operation, source, profile, risk as "write" | "destructive");
  }

  private hasExplicitCurrentSessionSelection(source: CapturedProfileState, profile: string): boolean {
    if (source.activeProfile !== profile) return false;
    if (source.lock.state === "configured" && source.lock.profile === profile) return true;
    return (
      (source.selectionSource === "mcp-switch" || source.selectionSource === "reset") &&
      source.confirmation !== "not-confirmed"
    );
  }

  private async assertCapturedLeaseAllows(
    operation: ProxiedOperation<unknown>,
    source: CapturedProfileState,
    profile: string,
    risk: "write" | "destructive"
  ): Promise<void> {
    const lease = source.lease;
    if (
      source.activeProfile !== profile ||
      lease.state === "not-required" ||
      lease.state === "required" ||
      lease.profile !== profile ||
      !lease.requiredForRisk.includes(risk)
    ) {
      throw new MiftahError(
        "PROFILE_LEASE_REQUIRED",
        `PROFILE_LEASE_REQUIRED: profile '${profile}' requires an explicit unexpired lease for ${risk} operations`
      );
    }
    if (lease.state === "expired" || this.leaseHasExpired(lease)) {
      await this.options.profileAudits?.leaseExpired({ source, profile, operation: operation.operation });
      throw new MiftahError(
        "PROFILE_LEASE_EXPIRED",
        `PROFILE_LEASE_EXPIRED: profile '${profile}' lease has expired for ${risk} operations`
      );
    }
  }

  private leaseHasExpired(lease: { readonly expiresAt: string }): boolean {
    const expiresAtMs = Date.parse(lease.expiresAt);
    return !Number.isFinite(expiresAtMs) || expiresAtMs <= this.now().getTime();
  }

  private updateSelectionAudit(audit: AuditScope, source: CapturedProfileState): void {
    audit.update({
      profileSelectionSource: source.selectionSource,
      profileConfirmation: source.confirmation,
      profileLeaseState: source.lease.state,
      profileLockState: source.lock.state,
      ...("expiresAt" in source.lease ? { profileLeaseExpiresAt: source.lease.expiresAt } : {})
    });
  }

  private auditName(operation: ProxiedOperation<unknown>, name: string): string {
    return operation.operation.startsWith("resources/") ? this.options.redactor.redactUri(name) : name;
  }

  private toSafeError(error: unknown): MiftahError {
    const message = this.options.redactor.redactText(error instanceof Error ? error.message : String(error));
    if (error instanceof MiftahError) {
      return new MiftahError(error.code, message, this.options.redactor.redact(error.details));
    }
    return new MiftahError("UPSTREAM_CALL_FAILED", `UPSTREAM_CALL_FAILED: ${message}`);
  }
}

function routingSource(route: RoutingDecision): "rule" | "matcher" | "active-profile" | "default-profile" | undefined {
  if (route.reason.startsWith("rule:")) return "rule";
  if (route.reason.startsWith("matcher:")) return "matcher";
  if (route.reason === "active-profile" || route.reason === "default-profile") return route.reason;
  return undefined;
}
