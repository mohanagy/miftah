import { describe, expect, it } from "vitest";
import { ApprovalContinuationStore } from "../src/approvals/approval-continuation-store.js";
import type { ApprovalBinding, ApprovalSummary } from "../src/approvals/approval-store.js";

function binding(argumentsValue: Record<string, unknown> = { name: "first" }): ApprovalBinding {
  return {
    sourceProfile: "work",
    profile: "work",
    upstream: "default",
    operation: "tools/call",
    name: "create_item",
    displayName: "create_item",
    arguments: argumentsValue
  };
}

function approval(id: string, expiresAt = "2999-01-01T00:00:00.000Z"): ApprovalSummary {
  return {
    id,
    status: "pending",
    sourceProfile: "work",
    profile: "work",
    upstream: "default",
    operation: "tools/call",
    name: "create_item",
    mechanism: "form",
    expiresAt
  };
}

describe("approval continuation store", () => {
  it("integrity-binds one pending continuation to the exact operation", () => {
    const store = new ApprovalContinuationStore();
    const original = binding({ nested: { second: 2, first: 1 }, name: "first" });
    const state = store.mint(original, approval("approval-1"));
    const continuation = store.verify(state);

    expect(store.pending(continuation, binding({ name: "first", nested: { first: 1, second: 2 } }))).toMatchObject({
      id: "approval-1",
      mechanism: "form"
    });
    expect(() => store.pending(continuation, binding({ name: "changed" }))).toThrow("APPROVAL_INVALID");
    const changedLastCharacter = state.endsWith("A") ? "B" : "A";
    expect(() => store.verify(`${state.slice(0, -1)}${changedLastCharacter}`)).toThrow("APPROVAL_INVALID");

    store.complete(continuation);
    expect(() => store.verify(state)).toThrow("APPROVAL_INVALID");
    expect(() => store.complete(continuation)).toThrow("APPROVAL_INVALID");
  });

  it("keeps profile-transition approval stable while the independently enforced revision changes", () => {
    const store = new ApprovalContinuationStore();
    const first: ApprovalBinding = {
      ...binding({ profile: "personal", selectionRevision: 1 }),
      profile: "personal",
      upstream: "profiles",
      operation: "profiles/switch",
      name: "personal",
      displayName: "profile 'personal'"
    };
    const state = store.mint(first, { ...approval("approval-2"), profile: "personal", operation: "profiles/switch" });
    const continuation = store.verify(state);

    expect(store.pending(continuation, {
      ...first,
      arguments: { profile: "personal", selectionRevision: 2 }
    }).id).toBe("approval-2");
  });

  it("bounds pending state and discards expired entries before admitting a replacement", () => {
    expect(() => new ApprovalContinuationStore(0)).toThrow("positive integer");
    const store = new ApprovalContinuationStore(1);
    const expiredState = store.mint(binding(), approval("expired", "2000-01-01T00:00:00.000Z"));
    const currentState = store.mint(binding(), approval("current"));

    expect(() => store.verify(expiredState)).toThrow("APPROVAL_INVALID");
    expect(store.verify(currentState)).toEqual({ approvalId: "current" });
    expect(() => store.mint(binding(), approval("overflow"))).toThrow("APPROVAL_LIMIT_EXCEEDED");
  });

  it.each(["", "not-a-state", "e30.invalid", `${"a".repeat(513)}.value`])(
    "rejects malformed state %j",
    (state) => {
      const store = new ApprovalContinuationStore();
      expect(() => store.verify(state)).toThrow("APPROVAL_INVALID");
    }
  );

  it("reissues the exact signed state for a still-pending continuation", () => {
    const store = new ApprovalContinuationStore();
    const valid = store.mint(binding(), approval("approval-3"));
    const continuation = store.verify(valid);
    expect(store.state(continuation)).toBe(valid);
  });
});
