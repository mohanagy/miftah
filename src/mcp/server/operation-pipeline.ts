import type { AuditScope } from "../../audit/audit-trail.js";
import { PolicyEngine } from "../../policy/policy-engine.js";
import type { PolicyDecision } from "../../policy/policy-types.js";
import { ProfileManager } from "../../profiles/profile-manager.js";
import { RoutingEngine } from "../../routing/routing-engine.js";
import type { RoutingContextSnapshot, RoutingDecision } from "../../routing/routing-types.js";
import { SecretRedactor } from "../../secrets/redact.js";
import { MultiUpstreamProcessManager } from "../../upstream/multi-upstream-process-manager.js";
import { UpstreamProcessManager } from "../../upstream/upstream-process-manager.js";
import type { UpstreamSession } from "../../upstream/upstream-session.js";
import { MiftahError } from "../../utils/errors.js";

export type ProxiedOperationType = "tools/call" | "resources/read" | "prompts/get";

export interface CapturedProfileState {
  readonly activeProfile: string;
  readonly revision: number;
}

export interface ResolvedOperation<Result> {
  readonly upstreamName?: string;
  readonly name: string;
  execute(session: UpstreamSession): Promise<Result>;
  redact(result: Result): Result;
}

export interface ProxiedOperation<Result> {
  readonly source: CapturedProfileState;
  readonly operation: ProxiedOperationType;
  readonly routingName: string;
  readonly policyName: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly requireExplicitRuleForDestructive?: boolean;
  resolveTarget(profile: string): Promise<ResolvedOperation<Result>>;
}

export type RoutingContextProvider = () => Promise<RoutingContextSnapshot>;

interface PipelineOptions {
  readonly profiles: ProfileManager;
  readonly routing: RoutingEngine;
  readonly policy: PolicyEngine;
  readonly upstreams: UpstreamProcessManager | MultiUpstreamProcessManager;
  readonly redactor: SecretRedactor;
  readonly routingContext: RoutingContextProvider;
}

/**
 * Applies the common safety sequence to every proxied MCP operation.
 */
export class OperationPipeline {
  constructor(private readonly options: PipelineOptions) {}

  async execute<Result>(operation: ProxiedOperation<Result>, audit: AuditScope): Promise<Result> {
    try {
      const snapshot = await this.options.routingContext();
      const route = this.options.routing.resolve(
        {
          toolName: operation.routingName,
          args: operation.args,
          context: snapshot.context,
          profileHints: snapshot.profileHints
        },
        operation.source.activeProfile
      );
      const profile = route.profile;
      const profileConfig = this.options.profiles.get(profile);
      const decision = this.options.policy.evaluate(profileConfig.policy, operation.policyName);
      audit.update({
        profile,
        routingReason: route.reason,
        routingSource: routingSource(route),
        policyName: profileConfig.policy ?? "default",
        policyDecision: decision.action,
        risk: decision.risk
      });
      this.assertPolicyAllows(operation, route, decision, profile);

      const target = await operation.resolveTarget(profile);
      audit.update({
        name: this.auditName(operation, target.name),
        ...(target.upstreamName === undefined ? {} : { upstream: target.upstreamName })
      });
      const session = await this.options.upstreams.get(profile, target.upstreamName);
      return this.options.redactor.redact(target.redact(await target.execute(session)));
    } catch (error) {
      throw this.toSafeError(error);
    }
  }

  private assertPolicyAllows(
    operation: ProxiedOperation<unknown>,
    route: RoutingDecision,
    decision: PolicyDecision,
    profile: string
  ): void {
    if (
      operation.requireExplicitRuleForDestructive &&
      decision.risk === "destructive" &&
      !route.reason.startsWith("rule:")
    ) {
      throw new MiftahError(
        "POLICY_BLOCKED",
        `POLICY_BLOCKED: destructive tool '${operation.policyName}' requires an explicit routing rule`
      );
    }
    if (decision.action === "deny") {
      throw new MiftahError(
        "POLICY_BLOCKED",
        `POLICY_BLOCKED: operation '${operation.policyName}' is blocked for profile '${profile}'`
      );
    }
    if (decision.action === "confirm") {
      throw new MiftahError(
        "POLICY_CONFIRMATION_REQUIRED",
        `POLICY_CONFIRMATION_REQUIRED: operation '${operation.policyName}' requires confirmation for profile '${profile}'`
      );
    }
  }

  private auditName(operation: ProxiedOperation<unknown>, name: string): string {
    return operation.operation === "resources/read" ? this.options.redactor.redactUri(name) : name;
  }

  private toSafeError(error: unknown): MiftahError {
    const message = this.options.redactor.redactText(error instanceof Error ? error.message : String(error));
    if (error instanceof MiftahError) {
      return new MiftahError(error.code, message, this.options.redactor.redact(error.details));
    }
    return new MiftahError("UPSTREAM_CALL_FAILED", `UPSTREAM_CALL_FAILED: ${message}`);
  }
}

function routingSource(route: RoutingDecision): "rule" | "active-profile" | "default-profile" | undefined {
  if (route.reason.startsWith("rule:")) return "rule";
  if (route.reason === "active-profile" || route.reason === "default-profile") return route.reason;
  return undefined;
}
