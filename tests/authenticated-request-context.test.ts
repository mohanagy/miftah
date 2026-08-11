import { describe, expect, it } from "vitest";
import {
  AuthenticatedRequestContextError,
  createAuthenticatedRequestContextBoundary,
  requireAuthenticatedRequestContext,
  type AuthenticatedRequestContextBoundaryOptions,
  type VerifiedHttpRequestClaims
} from "../src/index.js";

const bindingKey = Buffer.from("11".repeat(32), "hex");
const auditKey = Buffer.from("22".repeat(32), "hex");
const otherBindingKey = Buffer.from("33".repeat(32), "hex");
const nowMs = Date.UTC(2026, 7, 11, 10, 0, 0);

interface HostRequest {
  readonly verifiedClaims?: VerifiedHttpRequestClaims;
  readonly headers?: Readonly<Record<string, string>>;
  readonly clientInfo?: Readonly<Record<string, string>>;
}

function claims(overrides: Partial<VerifiedHttpRequestClaims> = {}): VerifiedHttpRequestClaims {
  return {
    issuer: "https://identity.example.test",
    subject: "subject-123",
    audience: "miftah.example.test",
    chatContext: "chat-work",
    issuedAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 60_000,
    ...overrides
  };
}

function boundary(
  overrides: Partial<Parameters<typeof createAuthenticatedRequestContextBoundary<HostRequest>>[0]> = {}
) {
  return createAuthenticatedRequestContextBoundary<HostRequest>({
    deploymentId: "deployment-a",
    bindingKey,
    auditKey,
    clock: () => nowMs,
    verifiedClaimsProvider: (request) => request.verifiedClaims,
    ...overrides
  });
}

describe("authenticated request context boundary", () => {
  it("creates deterministic cross-instance bindings while isolating two chats for one subject", async () => {
    const firstInstance = boundary();
    const secondInstance = boundary();
    const work = await requireAuthenticatedRequestContext(firstInstance, { verifiedClaims: claims() });
    const replayedOnSecondInstance = await requireAuthenticatedRequestContext(secondInstance, {
      verifiedClaims: claims()
    });
    const personal = await secondInstance.resolve({
      verifiedClaims: claims({ chatContext: "chat-personal" })
    });

    expect(replayedOnSecondInstance).toEqual(work);
    expect(personal.binding).not.toBe(work.binding);
    expect(personal.auditCorrelation).not.toBe(work.auditCorrelation);
    expect(work.binding).toMatch(/^mab1\.[A-Za-z0-9_-]{43}$/u);
    expect(work.auditCorrelation).toMatch(/^mac1\.[A-Za-z0-9_-]{22}$/u);
    expect(JSON.stringify(work)).not.toContain("subject-123");
    expect(JSON.stringify(work)).not.toContain("chat-work");

    expect(() => firstInstance.assertBinding(work.binding, replayedOnSecondInstance)).not.toThrow();
    expect(() => firstInstance.assertBinding(work.binding, personal)).toThrowError(
      expect.objectContaining({ code: "AUTH_CONTEXT_MISMATCH", message: "AUTH_CONTEXT_MISMATCH" })
    );
  });

  it.each([
    ["issuer", { issuer: "https://other-issuer.example.test" }],
    ["subject", { subject: "other-subject" }],
    ["audience", { audience: "other-audience.example.test" }],
    ["chat", { chatContext: "other-chat" }]
  ] as const)("fails a handle binding after the authenticated %s changes", async (_label, changed) => {
    const contextBoundary = boundary();
    const minted = await contextBoundary.resolve({ verifiedClaims: claims() });
    const changedContext = await contextBoundary.resolve({ verifiedClaims: claims(changed) });

    expect(() => contextBoundary.assertBinding(minted.binding, changedContext)).toThrowError(
      expect.objectContaining({ code: "AUTH_CONTEXT_MISMATCH" })
    );
  });

  it("fails a handle binding after deployment or deployment-key binding changes", async () => {
    const minted = await boundary().resolve({ verifiedClaims: claims() });
    const otherDeployment = await boundary({ deploymentId: "deployment-b" }).resolve({ verifiedClaims: claims() });
    const otherKey = await boundary({ bindingKey: otherBindingKey }).resolve({ verifiedClaims: claims() });

    expect(() => boundary().assertBinding(minted.binding, otherDeployment)).toThrowError(
      expect.objectContaining({ code: "AUTH_CONTEXT_MISMATCH" })
    );
    expect(() => boundary().assertBinding(minted.binding, otherKey)).toThrowError(
      expect.objectContaining({ code: "AUTH_CONTEXT_MISMATCH" })
    );
  });

  it("accepts a still-current verified assertion replay but rejects it at exact expiry", async () => {
    let clockMs = nowMs;
    const contextBoundary = boundary({ clock: () => clockMs });
    const request = { verifiedClaims: claims({ expiresAtMs: nowMs + 1_000 }) };

    const first = await contextBoundary.resolve(request);
    expect(await contextBoundary.resolve(request)).toEqual(first);

    clockMs = nowMs + 1_000;
    await expect(contextBoundary.resolve(request)).rejects.toMatchObject({
      code: "AUTH_CONTEXT_EXPIRED",
      message: "AUTH_CONTEXT_EXPIRED"
    });
  });

  it("fails closed when the trusted host boundary is missing, unavailable, or returns no claims", async () => {
    const spoofedRequest: HostRequest = {
      headers: { "x-chat-id": "attacker-chat", authorization: "Bearer unverified" },
      clientInfo: { name: "attacker-controlled", version: "1" }
    };

    await expect(requireAuthenticatedRequestContext(undefined, spoofedRequest)).rejects.toMatchObject({
      code: "AUTH_CONTEXT_UNAVAILABLE",
      message: "AUTH_CONTEXT_UNAVAILABLE"
    });
    await expect(boundary().resolve(spoofedRequest)).rejects.toMatchObject({
      code: "AUTH_CONTEXT_UNAVAILABLE",
      message: "AUTH_CONTEXT_UNAVAILABLE"
    });
    await expect(
      boundary({
        verifiedClaimsProvider: () => {
          throw new Error("private provider failure with subject-123");
        }
      }).resolve(spoofedRequest)
    ).rejects.toMatchObject({ code: "AUTH_CONTEXT_UNAVAILABLE", message: "AUTH_CONTEXT_UNAVAILABLE" });
    await expect(
      boundary({
        clock: () => {
          throw new Error("private clock backend failure");
        }
      }).resolve({ verifiedClaims: claims() })
    ).rejects.toMatchObject({ code: "AUTH_CONTEXT_UNAVAILABLE", message: "AUTH_CONTEXT_UNAVAILABLE" });
    await expect(
      boundary({ clock: () => Number.NaN }).resolve({ verifiedClaims: claims() })
    ).rejects.toMatchObject({ code: "AUTH_CONTEXT_INVALID", message: "AUTH_CONTEXT_INVALID" });
  });

  it.each([
    ["empty issuer", { issuer: "" }],
    ["control character", { chatContext: "chat\nforged" }],
    ["future issuance", { issuedAtMs: nowMs + 1 }],
    ["negative issuance", { issuedAtMs: -1 }],
    ["inverted lifetime", { issuedAtMs: nowMs + 1_000, expiresAtMs: nowMs + 500 }],
    ["non-finite expiry", { expiresAtMs: Number.POSITIVE_INFINITY }],
    ["oversized chat", { chatContext: "x".repeat(4_097) }],
    ["ill-formed Unicode", { subject: "subject-\ud800" }]
  ] as const)("returns only a fixed invalid error for %s", async (_label, invalid) => {
    const result = boundary().resolve({ verifiedClaims: claims(invalid) });

    await expect(result).rejects.toMatchObject({ code: "AUTH_CONTEXT_INVALID", message: "AUTH_CONTEXT_INVALID" });
    await expect(result).rejects.not.toThrow("subject-123");
  });

  it("normalizes an invalid runtime provider result for JavaScript consumers", async () => {
    await expect(
      boundary({
        verifiedClaimsProvider: () => null as unknown as VerifiedHttpRequestClaims
      }).resolve({})
    ).rejects.toMatchObject({ code: "AUTH_CONTEXT_INVALID", message: "AUTH_CONTEXT_INVALID" });
    await expect(
      boundary({
        verifiedClaimsProvider: () =>
          new Proxy(claims(), {
            get(target, property, receiver) {
              if (property === "then") return Reflect.get(target, property, receiver);
              throw new Error("private claim getter failure");
            }
          })
      }).resolve({})
    ).rejects.toMatchObject({ code: "AUTH_CONTEXT_INVALID", message: "AUTH_CONTEXT_INVALID" });
  });

  it("rejects malformed expected bindings with the same non-sensitive mismatch contract", async () => {
    const contextBoundary = boundary();
    const current = await contextBoundary.resolve({ verifiedClaims: claims() });

    expect(() => contextBoundary.assertBinding("subject-123", current)).toThrowError(
      expect.objectContaining({ code: "AUTH_CONTEXT_MISMATCH", message: "AUTH_CONTEXT_MISMATCH" })
    );
    expect(() =>
      contextBoundary.assertBinding(current.binding, { ...current, binding: "mab1.invalid" })
    ).toThrowError(expect.objectContaining({ code: "AUTH_CONTEXT_MISMATCH", message: "AUTH_CONTEXT_MISMATCH" }));
    expect(() =>
      contextBoundary.assertBinding(undefined as unknown as string, undefined as unknown as typeof current)
    ).toThrowError(expect.objectContaining({ code: "AUTH_CONTEXT_MISMATCH", message: "AUTH_CONTEXT_MISMATCH" }));
    expect(() =>
      contextBoundary.assertBinding(
        current.binding,
        new Proxy(current, {
          get() {
            throw new Error("private current-context getter failure");
          }
        })
      )
    ).toThrowError(expect.objectContaining({ code: "AUTH_CONTEXT_MISMATCH", message: "AUTH_CONTEXT_MISMATCH" }));
  });

  it("rejects invalid deployment, provider, and key configuration before accepting a host boundary", () => {
    expect(() => boundary({ bindingKey: Buffer.alloc(31) })).toThrowError(
      expect.objectContaining({ code: "AUTH_CONTEXT_INVALID" })
    );
    const throwingKey = new Proxy(Buffer.alloc(32), {
      get() {
        throw new Error("private key access failure");
      }
    });
    expect(() => boundary({ bindingKey: throwingKey })).toThrowError(
      expect.objectContaining({ code: "AUTH_CONTEXT_INVALID", message: "AUTH_CONTEXT_INVALID" })
    );
    expect(() => boundary({ auditKey: Buffer.alloc(4_097) })).toThrowError(
      expect.objectContaining({ code: "AUTH_CONTEXT_INVALID" })
    );
    expect(() => boundary({ auditKey: bindingKey })).toThrowError(
      expect.objectContaining({ code: "AUTH_CONTEXT_INVALID" })
    );
    expect(() => boundary({ deploymentId: "" })).toThrowError(
      expect.objectContaining({ code: "AUTH_CONTEXT_INVALID" })
    );
    expect(() =>
      createAuthenticatedRequestContextBoundary(undefined as unknown as AuthenticatedRequestContextBoundaryOptions<HostRequest>)
    ).toThrowError(expect.objectContaining({ code: "AUTH_CONTEXT_INVALID" }));
    expect(() =>
      createAuthenticatedRequestContextBoundary(
        new Proxy({} as AuthenticatedRequestContextBoundaryOptions<HostRequest>, {
          get() {
            throw new Error("private options getter failure");
          }
        })
      )
    ).toThrowError(expect.objectContaining({ code: "AUTH_CONTEXT_INVALID" }));
    expect(() => boundary({ clock: "not-a-clock" as unknown as () => number })).toThrowError(
      expect.objectContaining({ code: "AUTH_CONTEXT_INVALID" })
    );
    expect(() =>
      boundary({ verifiedClaimsProvider: undefined as unknown as (request: HostRequest) => VerifiedHttpRequestClaims })
    ).toThrowError(expect.objectContaining({ code: "AUTH_CONTEXT_INVALID" }));
  });

  it("copies deployment configuration and keys before resolving requests", async () => {
    const mutableBindingKey = Buffer.from(bindingKey);
    const mutableAuditKey = Buffer.from(auditKey);
    const options: AuthenticatedRequestContextBoundaryOptions<HostRequest> = {
      deploymentId: "deployment-a",
      bindingKey: mutableBindingKey,
      auditKey: mutableAuditKey,
      clock: () => nowMs,
      verifiedClaimsProvider: (request) => request.verifiedClaims
    };
    const configured = createAuthenticatedRequestContextBoundary(options);
    (options as { deploymentId: string }).deploymentId = "deployment-mutated";
    (
      options as unknown as {
        verifiedClaimsProvider: (request: HostRequest) => VerifiedHttpRequestClaims;
      }
    ).verifiedClaimsProvider = () => claims({ chatContext: "mutated-chat" });
    mutableBindingKey.fill(9);
    mutableAuditKey.fill(8);

    expect(await configured.resolve({ verifiedClaims: claims() })).toEqual(
      await boundary().resolve({ verifiedClaims: claims() })
    );
  });

  it("uses the real clock when an embedding host does not inject one", async () => {
    const liveNow = Date.now();
    const contextBoundary = createAuthenticatedRequestContextBoundary<HostRequest>({
      deploymentId: "deployment-a",
      bindingKey,
      auditKey,
      verifiedClaimsProvider: (request) => request.verifiedClaims
    });

    await expect(
      contextBoundary.resolve({
        verifiedClaims: claims({ issuedAtMs: liveNow - 1_000, expiresAtMs: liveNow + 60_000 })
      })
    ).resolves.toMatchObject({ expiresAtMs: liveNow + 60_000 });
  });

  it("exposes errors without identity, provider, request, or key details", () => {
    const error = new AuthenticatedRequestContextError("AUTH_CONTEXT_UNAVAILABLE");

    expect(error.message).toBe("AUTH_CONTEXT_UNAVAILABLE");
    expect(error).not.toHaveProperty("details");
    expect(JSON.stringify(error)).toBe('{"code":"AUTH_CONTEXT_UNAVAILABLE"}');
    expect(new AuthenticatedRequestContextError("private" as "AUTH_CONTEXT_INVALID")).toMatchObject({
      code: "AUTH_CONTEXT_INVALID",
      message: "AUTH_CONTEXT_INVALID"
    });
  });
});
