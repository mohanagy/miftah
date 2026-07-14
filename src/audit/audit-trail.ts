import { randomUUID } from "node:crypto";
import { AuditLogger } from "./audit-logger.js";
import type {
  ApprovalAuditAction,
  AuditEvent,
  AuditHealth,
  AuditRoutingSource,
  AuditStatus,
  ProfileAuditAction
} from "./audit-types.js";
import type { RoutingContextEvidence, RoutingMatcherEvidence } from "../routing/routing-types.js";

export interface AuditOperationInput {
  operation: string;
  name: string;
  sourceProfile: string;
  profile?: string;
  arguments?: Record<string, unknown>;
}

export interface AuditScopeUpdate {
  name?: string;
  profile?: string;
  upstream?: string;
  routingReason?: string;
  routingSource?: AuditRoutingSource;
  policyName?: string;
  policyDecision?: AuditEvent["policyDecision"];
  risk?: AuditEvent["risk"];
  riskSource?: AuditEvent["riskSource"];
  riskConfidence?: AuditEvent["riskConfidence"];
  identity?: AuditEvent["identity"];
  routingEvidence?: RoutingContextEvidence;
  routingMatcherEvidence?: readonly RoutingMatcherEvidence[];
  profileSelectionSource?: AuditEvent["profileSelectionSource"];
  profileConfirmation?: AuditEvent["profileConfirmation"];
  profileLeaseState?: AuditEvent["profileLeaseState"];
  profileLeaseExpiresAt?: AuditEvent["profileLeaseExpiresAt"];
  profileLockState?: AuditEvent["profileLockState"];
}

export interface AuditScopeResult {
  status: AuditStatus;
  errorCode?: string;
}

export interface AuditLifecycleInput {
  operation: string;
  name: string;
  profile: string;
  upstream?: string;
  lockToProfile?: string;
  status: AuditStatus;
  errorCode?: string;
}

export interface AuditApprovalInput {
  approvalId: string;
  approvalSessionId: string;
  approvalAction: ApprovalAuditAction;
  sourceProfile: string;
  profile: string;
  upstream: string;
  operation: string;
  name: string;
  expiresAt?: string;
}

export interface AuditProfileInput {
  profileAction: ProfileAuditAction;
  sourceProfile: string;
  profile: string;
  operation: string;
  name: string;
  profileSelectionSource?: AuditEvent["profileSelectionSource"];
  profileConfirmation?: AuditEvent["profileConfirmation"];
  profileLeaseState?: AuditEvent["profileLeaseState"];
  profileLeaseExpiresAt?: AuditEvent["profileLeaseExpiresAt"];
  profileLockState?: AuditEvent["profileLockState"];
  status?: AuditStatus;
}

/** Creates one final audit record per MCP request when audit logging is configured. */
export class AuditTrail {
  readonly sessionId = randomUUID();

  constructor(
    private readonly wrapperName: string,
    private readonly logger?: AuditLogger
  ) {}

  beginOperation(input: AuditOperationInput): AuditScope {
    return new AuditScope(this, input);
  }

  health(): { enabled: boolean; state?: AuditHealth["state"]; lastFailure?: AuditHealth["lastFailure"] } {
    if (!this.logger) return { enabled: false };
    return { enabled: true, ...this.logger.health() };
  }

  async ensureWritable(): Promise<void> {
    await this.logger?.ensureWritable();
  }

  async write(event: AuditEvent): Promise<void> {
    await this.logger?.log(event);
  }

  /** Writes a stateful security transition with fail-closed semantics regardless of the ordinary audit availability mode. */
  async writeRequired(event: AuditEvent): Promise<void> {
    await this.logger?.logRequired(event);
  }

  /** Writes related stateful transitions as one required append. */
  async writeRequiredBatch(events: readonly AuditEvent[]): Promise<void> {
    await this.logger?.logRequiredBatch(events);
  }

  async writeLifecycle(input: AuditLifecycleInput): Promise<void> {
    await this.write({
      wrapper: this.wrapperName,
      kind: "lifecycle",
      eventId: randomUUID(),
      sessionId: this.sessionId,
      sourceProfile: input.profile,
      profile: input.profile,
      operation: input.operation,
      name: input.name,
      status: input.status,
      durationMs: 0,
      ...(input.upstream === undefined ? {} : { upstream: input.upstream }),
      ...(input.lockToProfile === undefined ? {} : { lockToProfile: input.lockToProfile }),
      ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode })
    });
  }

  /** Records a safe state transition for a one-time approval without serializing its bearer or arguments. */
  async writeApproval(input: AuditApprovalInput): Promise<void> {
    await this.write(this.approvalEvent(input));
  }

  /** Writes a profile-confirmation approval and its dedicated state event through one required serialized append. */
  async writeApprovalAndProfile(input: AuditApprovalInput, profile: AuditProfileInput): Promise<void> {
    await this.writeRequiredBatch([this.approvalEvent(input), this.profileEvent(profile)]);
  }

  private approvalEvent(input: AuditApprovalInput): AuditEvent {
    return {
      wrapper: this.wrapperName,
      kind: "approval",
      eventId: randomUUID(),
      sessionId: this.sessionId,
      approvalId: input.approvalId,
      approvalSessionId: input.approvalSessionId,
      approvalAction: input.approvalAction,
      sourceProfile: input.sourceProfile,
      profile: input.profile,
      upstream: input.upstream,
      operation: input.operation,
      name: input.name,
      status: input.approvalAction === "denied" ? "denied" : "success",
      durationMs: 0,
      ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt })
    };
  }

  /** Records a safe connection-bound profile state transition without any persisted-state paths or approval bearers. */
  async writeProfile(input: AuditProfileInput): Promise<void> {
    await this.writeProfiles([input]);
  }

  /** Records related profile state transitions through one required serialized append. */
  async writeProfiles(inputs: readonly AuditProfileInput[]): Promise<void> {
    await this.writeRequiredBatch(inputs.map((input) => this.profileEvent(input)));
  }

  private profileEvent(input: AuditProfileInput): AuditEvent {
    return {
      wrapper: this.wrapperName,
      kind: "profile",
      eventId: randomUUID(),
      sessionId: this.sessionId,
      sourceProfile: input.sourceProfile,
      profile: input.profile,
      operation: input.operation,
      name: input.name,
      profileAction: input.profileAction,
      status: input.status ?? profileActionStatus(input.profileAction),
      durationMs: 0,
      ...(input.profileSelectionSource === undefined
        ? {}
        : { profileSelectionSource: input.profileSelectionSource }),
      ...(input.profileConfirmation === undefined ? {} : { profileConfirmation: input.profileConfirmation }),
      ...(input.profileLeaseState === undefined ? {} : { profileLeaseState: input.profileLeaseState }),
      ...(input.profileLeaseExpiresAt === undefined
        ? {}
        : { profileLeaseExpiresAt: input.profileLeaseExpiresAt }),
      ...(input.profileLockState === undefined ? {} : { profileLockState: input.profileLockState })
    };
  }

  /** Records a background lifecycle event without letting audit I/O disrupt process management. */
  recordLifecycle(input: AuditLifecycleInput): void {
    void this.writeLifecycle(input).catch(() => undefined);
  }

  wrapper(): string {
    return this.wrapperName;
  }
}

function profileActionStatus(action: ProfileAuditAction): AuditStatus {
  if (action === "confirmation-requested") return "confirmation-required";
  if (action === "confirmation-denied" || action === "confirmation-expired" || action === "lease-expired") {
    return "denied";
  }
  return "success";
}

/** Accumulates request context and prevents duplicate terminal records. */
export class AuditScope {
  private readonly requestId = randomUUID();
  private readonly startedAt = Date.now();
  private readonly event: AuditOperationInput & AuditScopeUpdate;
  private finalized = false;
  private resultOverride?: AuditScopeResult;

  constructor(
    private readonly trail: AuditTrail,
    input: AuditOperationInput
  ) {
    this.event = { ...input, profile: input.profile ?? input.sourceProfile };
  }

  get isFinalized(): boolean {
    return this.finalized;
  }

  update(update: AuditScopeUpdate): void {
    Object.assign(this.event, update);
  }

  /** Overrides the default terminal outcome when a request returns structured failure details. */
  setResult(result: AuditScopeResult): void {
    if (this.finalized) throw new Error("Audit scope already has a terminal event");
    if (this.resultOverride) throw new Error("Audit scope terminal outcome is already set");
    this.resultOverride = result;
  }

  async finish(result: AuditScopeResult): Promise<void> {
    if (this.finalized) throw new Error("Audit scope already has a terminal event");
    this.finalized = true;
    const terminalResult = this.resultOverride ?? result;
    await this.trail.write({
      wrapper: this.trail.wrapper(),
      kind: "operation",
      eventId: this.requestId,
      requestId: this.requestId,
      sessionId: this.trail.sessionId,
      sourceProfile: this.event.sourceProfile,
      profile: this.event.profile ?? this.event.sourceProfile,
      operation: this.event.operation,
      name: this.event.name,
      status: terminalResult.status,
      durationMs: Date.now() - this.startedAt,
      ...(this.event.upstream === undefined ? {} : { upstream: this.event.upstream }),
      ...(this.event.routingReason === undefined ? {} : { routingReason: this.event.routingReason }),
      ...(this.event.routingSource === undefined ? {} : { routingSource: this.event.routingSource }),
      ...(this.event.policyName === undefined ? {} : { policyName: this.event.policyName }),
      ...(this.event.policyDecision === undefined ? {} : { policyDecision: this.event.policyDecision }),
      ...(this.event.risk === undefined ? {} : { risk: this.event.risk }),
      ...(this.event.riskSource === undefined ? {} : { riskSource: this.event.riskSource }),
      ...(this.event.riskConfidence === undefined ? {} : { riskConfidence: this.event.riskConfidence }),
      ...(this.event.identity === undefined ? {} : { identity: this.event.identity }),
      ...(this.event.routingEvidence === undefined ? {} : { routingEvidence: this.event.routingEvidence }),
      ...(this.event.routingMatcherEvidence === undefined
        ? {}
        : { routingMatcherEvidence: this.event.routingMatcherEvidence }),
      ...(this.event.profileSelectionSource === undefined
        ? {}
        : { profileSelectionSource: this.event.profileSelectionSource }),
      ...(this.event.profileConfirmation === undefined ? {} : { profileConfirmation: this.event.profileConfirmation }),
      ...(this.event.profileLeaseState === undefined ? {} : { profileLeaseState: this.event.profileLeaseState }),
      ...(this.event.profileLeaseExpiresAt === undefined
        ? {}
        : { profileLeaseExpiresAt: this.event.profileLeaseExpiresAt }),
      ...(this.event.profileLockState === undefined ? {} : { profileLockState: this.event.profileLockState }),
      ...(this.event.arguments === undefined ? {} : { arguments: this.event.arguments }),
      ...(terminalResult.errorCode === undefined ? {} : { errorCode: terminalResult.errorCode })
    });
  }

}
