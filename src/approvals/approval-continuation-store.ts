import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { InputRequiredResult } from "@modelcontextprotocol/server";
import type { ApprovalBinding, ApprovalSummary } from "./approval-store.js";
import { MiftahError } from "../utils/errors.js";

const DEFAULT_MAX_RECORDS = 128;
const MAX_STATE_LENGTH = 512;

export interface ApprovalContinuation {
  readonly approvalId: string;
}

/** Internal control flow that carries an MCP multi-round-trip result through policy and audit layers. */
export class ApprovalInputRequiredSignal extends Error {
  constructor(
    readonly result: InputRequiredResult,
    readonly errorCode: MiftahError["code"]
  ) {
    super("MCP input is required before the operation can continue.");
    this.name = "ApprovalInputRequiredSignal";
  }
}

interface ApprovalContinuationRecord {
  readonly bindingDigest: Buffer;
  readonly approval: ApprovalSummary;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

function invalidContinuation(): MiftahError {
  return new MiftahError("APPROVAL_INVALID", "APPROVAL_INVALID: approval continuation is invalid or no longer pending");
}

/** Keeps form-approval retries bounded, integrity-protected, and usable across request-scoped server instances. */
export class ApprovalContinuationStore {
  private readonly records = new Map<string, ApprovalContinuationRecord>();
  private readonly stateKey = randomBytes(32);
  private readonly bindingKey = randomBytes(32);

  constructor(private readonly maxRecords = DEFAULT_MAX_RECORDS) {
    if (!Number.isInteger(maxRecords) || maxRecords <= 0) {
      throw new Error("Approval continuation record limit must be a positive integer.");
    }
  }

  mint(binding: ApprovalBinding, approval: ApprovalSummary): string {
    this.discardExpired();
    if (this.records.size >= this.maxRecords) {
      throw new MiftahError("APPROVAL_LIMIT_EXCEEDED", "APPROVAL_LIMIT_EXCEEDED: too many outstanding approvals");
    }
    this.records.set(approval.id, {
      bindingDigest: this.digestBinding(binding),
      approval
    });
    return this.state({ approvalId: approval.id });
  }

  /** Verifies wire integrity before the SDK exposes decoded state to a request handler. */
  verify(state: string): ApprovalContinuation {
    if (state.length === 0 || state.length > MAX_STATE_LENGTH) throw invalidContinuation();
    const [payload, signature, extra] = state.split(".");
    if (!payload || !signature || extra !== undefined) throw invalidContinuation();
    const expected = Buffer.from(this.sign(payload), "base64url");
    let received: Buffer;
    try {
      received = Buffer.from(signature, "base64url");
    } catch {
      throw invalidContinuation();
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw invalidContinuation();
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    } catch {
      throw invalidContinuation();
    }
    if (
      typeof decoded !== "object" ||
      decoded === null ||
      Array.isArray(decoded) ||
      (decoded as { version?: unknown }).version !== 1 ||
      typeof (decoded as { approvalId?: unknown }).approvalId !== "string"
    ) {
      throw invalidContinuation();
    }
    const approvalId = (decoded as { approvalId: string }).approvalId;
    if (!this.records.has(approvalId)) throw invalidContinuation();
    return { approvalId };
  }

  pending(continuation: ApprovalContinuation, binding: ApprovalBinding): ApprovalSummary {
    const record = this.records.get(continuation.approvalId);
    if (record === undefined) throw invalidContinuation();
    const receivedBinding = this.digestBinding(binding);
    if (
      receivedBinding.length !== record.bindingDigest.length ||
      !timingSafeEqual(receivedBinding, record.bindingDigest)
    ) {
      throw invalidContinuation();
    }
    return record.approval;
  }

  complete(continuation: ApprovalContinuation): void {
    if (!this.records.delete(continuation.approvalId)) throw invalidContinuation();
  }

  state(continuation: ApprovalContinuation): string {
    if (!this.records.has(continuation.approvalId)) throw invalidContinuation();
    const payload = Buffer.from(
      JSON.stringify({ version: 1, approvalId: continuation.approvalId }),
      "utf8"
    ).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  private discardExpired(): void {
    const now = Date.now();
    for (const [approvalId, record] of this.records) {
      if (Date.parse(record.approval.expiresAt) <= now) this.records.delete(approvalId);
    }
  }

  private digestBinding(binding: ApprovalBinding): Buffer {
    const argumentsForContinuation = { ...binding.arguments };
    if (binding.operation === "profiles/switch" || binding.operation === "profiles/reset") {
      // A retry re-captures profile state. The profile manager still enforces the new revision and lock,
      // while the continuation remains bound to the same requested action and target profile.
      delete argumentsForContinuation.selectionRevision;
    }
    return createHmac("sha256", this.bindingKey)
      .update(canonicalJson({ ...binding, arguments: argumentsForContinuation }))
      .digest();
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.stateKey).update(payload).digest("base64url");
  }
}
