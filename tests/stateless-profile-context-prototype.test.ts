import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InMemoryProfileContextRevocations,
  StatelessProfileContextError,
  StatelessProfileContextPrototype,
  type AuthenticatedProfileContext
} from "./prototypes/stateless-profile-context.js";

const deploymentId = "miftah.example/deployment-a";
const profiles = ["personal", "work"] as const;

function authenticatedContext(contextId: string, subject = "user-123"): AuthenticatedProfileContext {
  return {
    issuer: "https://issuer.example",
    subject,
    audience: "miftah.example",
    contextId
  };
}

function instances(now: () => Date) {
  const encryptionKey = randomBytes(32);
  const bindingKey = randomBytes(32);
  const auditKey = randomBytes(32);
  const revocations = new InMemoryProfileContextRevocations();
  const options = {
    deploymentId,
    profiles,
    encryptionKey,
    bindingKey,
    auditKey,
    revocations,
    now
  };
  return {
    first: new StatelessProfileContextPrototype(options),
    second: new StatelessProfileContextPrototype(options),
    revocations,
    keys: { encryptionKey, bindingKey, auditKey }
  };
}

describe("stateless profile context prototype", () => {
  it("keeps two chats for one principal isolated even when requests alternate instances", () => {
    const now = () => new Date("2026-08-11T08:00:00.000Z");
    const { first, second } = instances(now);
    const workChat = authenticatedContext("chat-work");
    const personalChat = authenticatedContext("chat-personal");
    const workHandle = first.mint("work", workChat, 60_000);
    const personalHandle = second.mint("personal", personalChat, 60_000);

    expect(second.resolve(workHandle, workChat).profile).toBe("work");
    expect(first.resolve(personalHandle, personalChat).profile).toBe("personal");
    expect(first.resolve(workHandle, workChat).profile).toBe("work");
    expect(second.resolve(personalHandle, personalChat).profile).toBe("personal");

    expect(() => first.resolve(workHandle, personalChat)).toThrowError(StatelessProfileContextError);
    expect(() => second.resolve(personalHandle, workChat)).toThrowError(StatelessProfileContextError);
  });

  it("binds every resolution to the authenticated principal and deployment", () => {
    const now = () => new Date("2026-08-11T08:00:00.000Z");
    const { first, keys } = instances(now);
    const owner = authenticatedContext("chat-work");
    const handle = first.mint("work", owner, 60_000);

    expect(() => first.resolve(handle, authenticatedContext("chat-work", "user-456"))).toThrowError(
      expect.objectContaining({ code: "PROFILE_CONTEXT_INVALID" })
    );

    const otherDeployment = new StatelessProfileContextPrototype({
      deploymentId: "miftah.example/deployment-b",
      profiles,
      encryptionKey: keys.encryptionKey,
      bindingKey: keys.bindingKey,
      auditKey: keys.auditKey,
      revocations: new InMemoryProfileContextRevocations(),
      now
    });
    expect(() => otherDeployment.resolve(handle, owner)).toThrowError(
      expect.objectContaining({ code: "PROFILE_CONTEXT_INVALID" })
    );
  });

  it("revokes across instances and expires at the exact boundary", () => {
    let current = new Date("2026-08-11T08:00:00.000Z");
    const now = () => current;
    const { first, second } = instances(now);
    const context = authenticatedContext("chat-work");
    const revoked = first.mint("work", context, 60_000);
    const expiring = first.mint("work", context, 10_000);

    second.revoke(revoked, context);
    expect(() => first.resolve(revoked, context)).toThrowError(
      expect.objectContaining({ code: "PROFILE_CONTEXT_REVOKED" })
    );

    current = new Date("2026-08-11T08:00:10.000Z");
    expect(() => second.resolve(expiring, context)).toThrowError(
      expect.objectContaining({ code: "PROFILE_CONTEXT_EXPIRED" })
    );
  });

  it("never returns or reports the capability-bearing handle", () => {
    const now = () => new Date("2026-08-11T08:00:00.000Z");
    const { first } = instances(now);
    const context = authenticatedContext("chat-work");
    const handle = first.mint("work", context, 60_000);
    const resolution = first.resolve(handle, context);

    expect(JSON.stringify(resolution)).not.toContain(handle);
    expect(resolution.auditCorrelation).toMatch(/^mctx_[a-f0-9]{16}$/u);
    expect(handle).not.toContain("work");
    expect(handle).not.toContain(context.subject);

    let failure: unknown;
    try {
      first.resolve(`${handle}tampered`, context);
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).not.toContain(handle);
    expect(failure).toEqual(
      expect.objectContaining({ code: "PROFILE_CONTEXT_INVALID", message: "Profile context is invalid." })
    );
  });
});
