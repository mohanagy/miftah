import { describe, expect, it } from "vitest";
import { ApprovalStore, type ApprovalBinding } from "../src/approvals/approval-store.js";

function requestDelegated(store: ApprovalStore, binding: ApprovalBinding) {
  return store.request(binding, "delegated-agent", () => true);
}

function consumeDelegated(store: ApprovalStore, binding: ApprovalBinding) {
  return store.consume(binding, "delegated-agent");
}

describe("approval store", () => {
  it("does not consume an approved approval for a different normalized argument set", () => {
    const store = new ApprovalStore({
      now: () => new Date("2026-07-12T00:00:00.000Z"),
      createToken: () => "approval-test-token"
    });
    store.beginSession();
    const binding = {
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call" as const,
      name: "create_item",
      displayName: "create_item",
      arguments: { first: "one", second: "two" }
    };

    const requested = requestDelegated(store, binding);
    store.approve(requested.token);

    expect(consumeDelegated(store, { ...binding, arguments: { first: "one", second: "changed" } })).toBeUndefined();
    expect(consumeDelegated(store, { ...binding, arguments: { second: "two", first: "one" } })).toMatchObject({
      id: requested.approval.id,
      status: "consumed"
    });
    expect(JSON.stringify(store.list())).not.toContain("approval-test-token");
  });

  it("keeps the first fallback bearer valid when the same pending operation is requested again", () => {
    let token = 0;
    const store = new ApprovalStore({ createToken: () => `approval-repeat-${++token}` });
    const binding = {
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call" as const,
      name: "create_item",
      displayName: "create_item",
      arguments: { name: "first" }
    };

    const first = requestDelegated(store, binding);
    const second = requestDelegated(store, binding);

    expect(second).toMatchObject({ created: false });
    expect(store.approve(first.token)).toMatchObject({ id: first.approval.id, status: "approved" });
    expect(consumeDelegated(store, binding)).toMatchObject({ id: first.approval.id, status: "consumed" });
  });

  it("fails closed when the same pending operation is requested through another approval mechanism", () => {
    const store = new ApprovalStore({ createToken: () => "approval-mechanism-token" });
    const binding = {
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call" as const,
      name: "create_item",
      displayName: "create_item",
      arguments: { name: "first" }
    };

    const requested = store.request(binding, "form");

    expect(requested.approval.mechanism).toBe("form");
    const requestWithoutMechanism = store.request as unknown as (input: typeof binding) => unknown;
    expect(() => requestWithoutMechanism.call(store, binding)).toThrow(
      expect.objectContaining({ code: "APPROVAL_MECHANISM_MISMATCH" })
    );
    expect(() => store.request(binding, "delegated-agent", () => true)).toThrow(
      expect.objectContaining({ code: "APPROVAL_MECHANISM_MISMATCH" })
    );
    store.approve(requested.token);
    expect(store.consume(binding, "delegated-agent")).toBeUndefined();
    expect(store.consume(binding, "form")).toMatchObject({ id: requested.approval.id, status: "consumed" });
  });

  it("bounds bearer variants for one pending operation without retaining bearer values", () => {
    let token = 0;
    const store = new ApprovalStore({ createToken: () => `approval-bounded-${++token}` });
    const binding = {
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call" as const,
      name: "create_item",
      displayName: "create_item",
      arguments: { name: "first" }
    };

    for (let index = 0; index < 8; index += 1) requestDelegated(store, binding);

    expect(() => requestDelegated(store, binding)).toThrow(expect.objectContaining({ code: "APPROVAL_LIMIT_EXCEEDED" }));
    expect(JSON.stringify(store.list())).not.toContain("approval-bounded-");
  });

  it("retains only keyed digests instead of the bearer or sensitive arguments", () => {
    const token = "approval-record-secret-token";
    const secretArgument = "approval-record-sensitive-argument";
    const store = new ApprovalStore({ createToken: () => token });
    requestDelegated(store, {
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call",
      name: "create_item",
      displayName: "create_item",
      arguments: { value: secretArgument }
    });
    const records = (store as unknown as { records: Map<string, unknown> }).records;
    const record = [...records.values()][0];

    expect(record).toBeDefined();
    expect(JSON.stringify(record)).not.toContain(token);
    expect(JSON.stringify(record)).not.toContain(secretArgument);
    expect(record).not.toHaveProperty("arguments");
  });

  it("expires a pending approval before its bearer can be approved", () => {
    let now = new Date("2026-07-12T00:00:00.000Z");
    const store = new ApprovalStore({
      now: () => now,
      ttlMs: 1_000,
      createToken: () => "approval-expired-token"
    });
    const requested = requestDelegated(store, {
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call",
      name: "create_item",
      displayName: "create_item",
      arguments: { name: "first" }
    });

    now = new Date("2026-07-12T00:00:01.000Z");

    expect(store.expire()).toEqual([expect.objectContaining({ id: requested.approval.id, status: "expired" })]);
    expect(() => store.approve(requested.token)).toThrow(expect.objectContaining({ code: "APPROVAL_EXPIRED" }));
  });

  it("expires an approved approval before it can authorize the matching retry", () => {
    let now = new Date("2026-07-12T00:00:00.000Z");
    const store = new ApprovalStore({
      now: () => now,
      ttlMs: 1_000,
      createToken: () => "approval-approved-expired-token"
    });
    const binding = {
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call",
      name: "create_item",
      displayName: "create_item",
      arguments: { name: "first" }
    };
    const requested = requestDelegated(store, binding);
    store.approve(requested.token);

    now = new Date("2026-07-12T00:00:01.000Z");

    expect(store.expire()).toEqual([expect.objectContaining({ id: requested.approval.id, status: "expired" })]);
    expect(consumeDelegated(store, binding)).toBeUndefined();
  });

  it("does not require a caller to sweep expiry before consuming an approval", () => {
    let now = new Date("2026-07-12T00:00:00.000Z");
    const store = new ApprovalStore({
      now: () => now,
      ttlMs: 1_000,
      createToken: () => "approval-lazy-expired-token"
    });
    const binding = {
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call",
      name: "create_item",
      displayName: "create_item",
      arguments: { name: "first" }
    };
    const requested = requestDelegated(store, binding);
    store.approve(requested.token);
    now = new Date("2026-07-12T00:00:01.000Z");

    expect(consumeDelegated(store, binding)).toBeUndefined();
  });

  it("rejects a bearer from a previous connection session", () => {
    let session = 0;
    const store = new ApprovalStore({
      createToken: () => "approval-old-session-token",
      createSessionId: () => `session-${++session}`
    });
    const requested = requestDelegated(store, {
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call",
      name: "create_item",
      displayName: "create_item",
      arguments: { name: "first" }
    });

    store.beginSession();

    expect(() => store.approve(requested.token)).toThrow(expect.objectContaining({ code: "APPROVAL_INVALID" }));
  });

  it("rejects a replay after an explicit denial", () => {
    const store = new ApprovalStore({ createToken: () => "approval-denied-token" });
    const requested = requestDelegated(store, {
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call",
      name: "create_item",
      displayName: "create_item",
      arguments: { name: "first" }
    });

    expect(store.deny(requested.token)).toMatchObject({ id: requested.approval.id, status: "denied" });
    expect(() => store.approve(requested.token)).toThrow(expect.objectContaining({ code: "APPROVAL_NOT_PENDING" }));
  });

  it("consumes a matching approved operation only once under concurrent retries", async () => {
    const store = new ApprovalStore({ createToken: () => "approval-concurrent-token" });
    const binding = {
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call",
      name: "create_item",
      displayName: "create_item",
      arguments: { name: "first" }
    };
    const requested = requestDelegated(store, binding);
    store.approve(requested.token);

    const consumed = await Promise.all([
      Promise.resolve().then(() => consumeDelegated(store, binding)),
      Promise.resolve().then(() => consumeDelegated(store, binding))
    ]);

    expect(consumed.filter((approval) => approval !== undefined)).toEqual([
      expect.objectContaining({ id: requested.approval.id, status: "consumed" })
    ]);
  });

  it("bounds outstanding approvals and frees terminal records", () => {
    let token = 0;
    const store = new ApprovalStore({
      maxRecords: 2,
      createToken: () => `approval-capacity-${++token}`
    });
    const binding = (name: string) => ({
      sourceProfile: "work",
      profile: "work",
      upstream: "default",
      operation: "tools/call",
      name: "create_item",
      displayName: "create_item",
      arguments: { name }
    });

    const first = requestDelegated(store, binding("first"));
    requestDelegated(store, binding("second"));

    expect(() => requestDelegated(store, binding("third"))).toThrow(
      expect.objectContaining({ code: "APPROVAL_LIMIT_EXCEEDED" })
    );
    store.deny(first.token);
    expect(requestDelegated(store, binding("third"))).toMatchObject({ created: true });
  });
});
