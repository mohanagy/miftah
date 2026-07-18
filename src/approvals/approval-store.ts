import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { MiftahError } from "../utils/errors.js";

const DEFAULT_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_RECORDS = 128;
const MAX_BEARERS_PER_PENDING_APPROVAL = 8;
const MAX_BEARER_ISSUE_ATTEMPTS = 32;
const acceptsAnyBearer = (): boolean => true;

export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed" | "expired";
export type ApprovalMechanism = "form" | "delegated-agent";

export interface ApprovalBinding {
  readonly sourceProfile: string;
  readonly profile: string;
  readonly upstream: string;
  readonly operation: string;
  /** The actual target identifier, retained only inside the keyed binding digest. */
  readonly name: string;
  /** A safe target label suitable for management output and audit events. */
  readonly displayName: string;
  readonly arguments: Record<string, unknown>;
}

export interface ApprovalSummary {
  readonly id: string;
  readonly status: ApprovalStatus;
  readonly sourceProfile: string;
  readonly profile: string;
  readonly upstream: string;
  readonly operation: string;
  readonly name: string;
  readonly mechanism: ApprovalMechanism;
  readonly expiresAt: string;
}

export interface ApprovalRequest {
  /** A one-time bearer used only by approve/deny; it is never retained or listed. */
  readonly token: string;
  readonly approval: ApprovalSummary;
  readonly created: boolean;
}

export interface ApprovalStoreOptions {
  readonly createToken?: () => string;
  readonly createId?: () => string;
  readonly createSessionId?: () => string;
  readonly now?: () => Date;
  readonly ttlMs?: number;
  readonly maxRecords?: number;
}

interface ApprovalRecord {
  readonly id: string;
  status: ApprovalStatus;
  readonly sourceProfile: string;
  readonly profile: string;
  readonly upstream: string;
  readonly operation: string;
  readonly name: string;
  readonly mechanism: ApprovalMechanism;
  readonly sessionId: string;
  readonly tokenDigests: Buffer[];
  readonly bindingDigest: Buffer;
  readonly expiresAtMs: number;
}

/** Holds connection-bound approvals without retaining bearer tokens or raw arguments. */
export class ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();
  private expiredTransitions: ApprovalSummary[] = [];
  private readonly createToken: () => string;
  private readonly createId: () => string;
  private readonly createSessionId: () => string;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly maxRecords: number;
  private readonly tokenKey = randomBytes(32);
  private readonly bindingKey = randomBytes(32);
  private sessionId: string;

  constructor(options: ApprovalStoreOptions = {}) {
    this.createToken = options.createToken ?? (() => randomBytes(32).toString("base64url"));
    this.createId = options.createId ?? randomUUID;
    this.createSessionId = options.createSessionId ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    if (!Number.isInteger(this.ttlMs) || this.ttlMs <= 0) throw new Error("Approval TTL must be a positive integer.");
    if (!Number.isInteger(this.maxRecords) || this.maxRecords <= 0) {
      throw new Error("Approval record limit must be a positive integer.");
    }
    this.sessionId = this.createSessionId();
  }

  get activeSessionId(): string {
    return this.sessionId;
  }

  beginSession(): void {
    this.records.clear();
    this.expiredTransitions = [];
    this.sessionId = this.createSessionId();
  }

  request(
    binding: ApprovalBinding,
    isBearerSafe: (bearer: string) => boolean = acceptsAnyBearer,
    mechanism: ApprovalMechanism = "delegated-agent"
  ): ApprovalRequest {
    this.expire();
    const bindingDigest = this.digestBinding(binding);
    const pending = [...this.records.values()].find(
      (record) =>
        record.sessionId === this.sessionId &&
        record.status === "pending" &&
        timingSafeEqual(record.bindingDigest, bindingDigest)
    );
    if (pending !== undefined) return this.issueToken(pending, false, isBearerSafe);
    this.discardTerminalRecords();
    if (this.records.size >= this.maxRecords) {
      throw new MiftahError("APPROVAL_LIMIT_EXCEEDED", "APPROVAL_LIMIT_EXCEEDED: too many outstanding approvals");
    }

    const expiresAtMs = this.now().getTime() + this.ttlMs;
    const record: ApprovalRecord = {
      id: this.createId(),
      status: "pending",
      sourceProfile: binding.sourceProfile,
      profile: binding.profile,
      upstream: binding.upstream,
      operation: binding.operation,
      name: binding.displayName,
      mechanism,
      sessionId: this.sessionId,
      tokenDigests: [],
      bindingDigest,
      expiresAtMs
    };
    this.records.set(record.id, record);
    try {
      return this.issueToken(record, true, isBearerSafe);
    } catch (error) {
      this.records.delete(record.id);
      throw error;
    }
  }

  approve(token: string): ApprovalSummary {
    const record = this.requirePending(token);
    record.status = "approved";
    return summary(record);
  }

  deny(token: string): ApprovalSummary {
    const record = this.requirePending(token);
    record.status = "denied";
    return summary(record);
  }

  /** Removes an approval that could not be durably recorded before its bearer was disclosed. */
  revoke(approvalId: string): void {
    this.records.delete(approvalId);
  }

  /** Claims an accepted form approval without leaving an async window for a second consumer. */
  approveAndConsume(token: string, binding: ApprovalBinding): ApprovalSummary {
    const record = this.requirePending(token);
    if (!timingSafeEqual(record.bindingDigest, this.digestBinding(binding))) {
      throw new MiftahError("APPROVAL_INVALID", "APPROVAL_INVALID: approval token does not match this operation");
    }
    record.status = "consumed";
    return summary(record);
  }

  /** Atomically claims one matching approved record before any asynchronous upstream work begins. */
  consume(binding: ApprovalBinding): ApprovalSummary | undefined {
    this.expire();
    const bindingDigest = this.digestBinding(binding);
    const record = [...this.records.values()].find(
      (candidate) =>
        candidate.sessionId === this.sessionId &&
        candidate.status === "approved" &&
        timingSafeEqual(candidate.bindingDigest, bindingDigest)
    );
    if (record === undefined) return undefined;
    record.status = "consumed";
    return summary(record);
  }

  list(): readonly ApprovalSummary[] {
    return [...this.records.values()]
      .filter((record) => record.sessionId === this.sessionId && record.status === "pending")
      .map(summary);
  }

  /** Marks stale pending or approved approvals expired before they can authorize a future operation. */
  expire(): readonly ApprovalSummary[] {
    const now = this.now().getTime();
    const expired: ApprovalSummary[] = [];
    for (const record of this.records.values()) {
      if (
        record.sessionId === this.sessionId &&
        (record.status === "pending" || record.status === "approved") &&
        record.expiresAtMs <= now
      ) {
        record.status = "expired";
        const transition = summary(record);
        expired.push(transition);
        this.expiredTransitions.push(transition);
      }
    }
    return expired;
  }

  /** Returns expiry transitions that have not yet been recorded by the owning server. */
  takeExpiredTransitions(): readonly ApprovalSummary[] {
    const transitions = this.expiredTransitions;
    this.expiredTransitions = [];
    return transitions;
  }

  /** Restores unrecorded expiry transitions after a fail-closed audit write failure. */
  restoreExpiredTransitions(transitions: readonly ApprovalSummary[]): void {
    this.expiredTransitions.unshift(...transitions);
  }

  private issueToken(
    record: ApprovalRecord,
    created: boolean,
    isBearerSafe: (bearer: string) => boolean
  ): ApprovalRequest {
    if (record.tokenDigests.length >= MAX_BEARERS_PER_PENDING_APPROVAL) {
      throw new MiftahError(
        "APPROVAL_LIMIT_EXCEEDED",
        "APPROVAL_LIMIT_EXCEEDED: too many approval bearers were issued for this pending operation"
      );
    }
    for (let attempt = 0; attempt < MAX_BEARER_ISSUE_ATTEMPTS; attempt += 1) {
      const token = this.createToken();
      if (!isBearerSafe(token)) continue;
      record.tokenDigests.push(this.digestToken(token));
      return { token, approval: summary(record), created };
    }
    throw new MiftahError(
      "POLICY_CONFIRMATION_REQUIRED",
      "POLICY_CONFIRMATION_REQUIRED: unable to issue a safe one-time approval bearer"
    );
  }

  private discardTerminalRecords(): void {
    for (const [id, record] of this.records) {
      if (record.status === "denied" || record.status === "consumed" || record.status === "expired") {
        this.records.delete(id);
      }
    }
  }

  private requirePending(token: string): ApprovalRecord {
    this.expire();
    const record = this.findToken(token);
    if (record?.status === "expired") {
      throw new MiftahError("APPROVAL_EXPIRED", "APPROVAL_EXPIRED: approval token has expired");
    }
    if (record === undefined || record.sessionId !== this.sessionId) {
      throw new MiftahError("APPROVAL_INVALID", "APPROVAL_INVALID: approval token is invalid for this session");
    }
    if (record.status !== "pending") {
      throw new MiftahError("APPROVAL_NOT_PENDING", "APPROVAL_NOT_PENDING: approval token cannot be decided again");
    }
    return record;
  }

  private findToken(token: string): ApprovalRecord | undefined {
    const digest = this.digestToken(token);
    return [...this.records.values()].find((record) =>
      record.tokenDigests.some((tokenDigest) => timingSafeEqual(tokenDigest, digest))
    );
  }

  private digestToken(token: string): Buffer {
    return createHmac("sha256", this.tokenKey).update(token).digest();
  }

  private digestBinding(binding: ApprovalBinding): Buffer {
    return createHmac("sha256", this.bindingKey)
      .update(
        canonicalJson({
          sessionId: this.sessionId,
          sourceProfile: binding.sourceProfile,
          profile: binding.profile,
          upstream: binding.upstream,
          operation: binding.operation,
          name: binding.name,
          arguments: binding.arguments
        })
      )
      .digest();
  }
}

function summary(record: ApprovalRecord): ApprovalSummary {
  return {
    id: record.id,
    status: record.status,
    sourceProfile: record.sourceProfile,
    profile: record.profile,
    upstream: record.upstream,
    operation: record.operation,
    name: record.name,
    mechanism: record.mechanism,
    expiresAt: new Date(record.expiresAtMs).toISOString()
  };
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  return serialized === undefined ? "null" : serialized;
}
