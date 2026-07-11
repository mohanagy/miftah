import type { AuditEvent } from "../../audit/audit-types.js";
import { PolicyEngine } from "../../policy/policy-engine.js";
import type { PolicyDecision } from "../../policy/policy-types.js";
import { ProfileManager } from "../../profiles/profile-manager.js";
import { RoutingEngine } from "../../routing/routing-engine.js";
import type { RoutingDecision } from "../../routing/routing-types.js";
import { redactSecrets, redactUri } from "../../secrets/redact.js";
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

interface PipelineOptions {
  readonly wrapper: string;
  readonly profiles: ProfileManager;
  readonly routing: RoutingEngine;
  readonly policy: PolicyEngine;
  readonly upstreams: UpstreamProcessManager | MultiUpstreamProcessManager;
  readonly writeAudit: (event: AuditEvent) => Promise<void>;
}

/**
 * Applies the common safety sequence to every proxied MCP operation.
 */
export class OperationPipeline {
  constructor(private readonly options: PipelineOptions) {}

  async execute<Result>(operation: ProxiedOperation<Result>): Promise<Result> {
    const startedAt = Date.now();
    let profile = operation.source.activeProfile;
    let route: RoutingDecision | undefined;
    let decision: PolicyDecision | undefined;
    let name = operation.name;
    let result: Result;

    try {
      route = this.options.routing.resolve(
        { toolName: operation.routingName, args: operation.args },
        operation.source.activeProfile
      );
      profile = route.profile;
      decision = this.options.policy.evaluate(this.options.profiles.get(profile).policy, operation.policyName);
      this.assertPolicyAllows(operation, route, decision, profile);

      const target = await operation.resolveTarget(profile);
      name = target.name;
      const session = await this.options.upstreams.get(profile, target.upstreamName);
      result = target.redact(await target.execute(session));
      result = redactSecrets(result, this.options.upstreams.getSecretValues());
    } catch (error) {
      const safeError = this.toSafeError(error);
      await this.writeAudit({
        operation,
        profile,
        name,
        startedAt,
        route,
        decision,
        status: this.failureStatus(safeError),
        errorCode: safeError.code
      });
      throw safeError;
    }

    await this.writeAudit({
      operation,
      profile,
      name,
      startedAt,
      route,
      decision,
      status: "success"
    });
    return result;
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

  private async writeAudit(input: {
    operation: ProxiedOperation<unknown>;
    profile: string;
    name: string;
    startedAt: number;
    route?: RoutingDecision;
    decision?: PolicyDecision;
    status: AuditEvent["status"];
    errorCode?: string;
  }): Promise<void> {
    await this.options.writeAudit({
      wrapper: this.options.wrapper,
      profile: input.profile,
      operation: input.operation.operation,
      name: this.auditName(input.operation, input.name),
      status: input.status,
      durationMs: Date.now() - input.startedAt,
      ...(input.route ? { routingReason: input.route.reason } : {}),
      ...(input.decision ? { policyDecision: input.decision.action, risk: input.decision.risk } : {}),
      arguments: this.auditArguments(input.operation),
      ...(input.errorCode ? { errorCode: input.errorCode } : {})
    });
  }

  private auditName(operation: ProxiedOperation<unknown>, name: string): string {
    return operation.operation === "resources/read" ? redactUri(name) : name;
  }

  private auditArguments(operation: ProxiedOperation<unknown>): Record<string, unknown> {
    if (operation.operation !== "resources/read" || typeof operation.args.uri !== "string") {
      return operation.args;
    }
    return { ...operation.args, uri: redactUri(operation.args.uri) };
  }

  private failureStatus(error: MiftahError): AuditEvent["status"] {
    return error.code === "POLICY_BLOCKED" || error.code === "POLICY_CONFIRMATION_REQUIRED" ? "blocked" : "failure";
  }

  private toSafeError(error: unknown): MiftahError {
    const message = redactSecrets(error instanceof Error ? error.message : String(error), this.options.upstreams.getSecretValues());
    if (error instanceof MiftahError) return new MiftahError(error.code, message, error.details);
    return new MiftahError("UPSTREAM_CALL_FAILED", `UPSTREAM_CALL_FAILED: ${message}`);
  }
}
