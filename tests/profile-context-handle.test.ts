import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createAuthenticatedRequestContextBoundary,
  type AuthenticatedRequestContext
} from "../src/http/authenticated-request-context.js";
import {
  InMemoryProfileContextRevocationStore,
  ProfileContextHandleError,
  ProfileContextHandleService,
  type ProfileContextHandleServiceOptions,
  type ProfileContextKeyringSnapshot,
  type ProfileContextRevocationStore
} from "../src/profiles/profile-context-handle.js";

const deploymentId = "miftah.example/deployment-a";
const profiles = ["personal", "work"] as const;
const nowMs = 2_000_000_000_000;

function keyring(epoch = 1, key = randomBytes(32), activatedAtMs = nowMs - 1_000): ProfileContextKeyringSnapshot {
  return { activeEpoch: epoch, epochs: [{ epoch, key, activatedAtMs }] };
}

function profileContextOptions(
  overrides: Partial<ProfileContextHandleServiceOptions> = {}
): ProfileContextHandleServiceOptions {
  const sharedKeyring = keyring();
  return {
    deploymentId,
    profiles,
    keyringProvider: () => sharedKeyring,
    auditKey: Buffer.alloc(32, 0x44),
    revocations: new InMemoryProfileContextRevocationStore(),
    clock: () => nowMs,
    ...overrides
  };
}

function sealPlaintext(plaintext: string, key: Uint8Array, epoch = 1): string {
  const initializationVector = Buffer.alloc(12, 0x55);
  const cipher = createCipheriv("aes-256-gcm", key, initializationVector, { authTagLength: 16 });
  const aadParts = ["miftah-profile-context-v1", deploymentId, String(epoch)].flatMap((value) => {
    const encoded = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(encoded.length);
    return [length, encoded];
  });
  cipher.setAAD(Buffer.concat(aadParts));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "mctx1",
    String(epoch),
    initializationVector.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url")
  ].join(".");
}

function sealPayload(payload: unknown, key: Uint8Array, epoch = 1): string {
  return sealPlaintext(JSON.stringify(payload), key, epoch);
}

async function authenticated(chatContext: string, subject = "user-123", expiresAtMs = nowMs + 60 * 60_000) {
  return createAuthenticatedRequestContextBoundary<string>({
    deploymentId,
    bindingKey: Buffer.alloc(32, 0x31),
    auditKey: Buffer.alloc(32, 0x32),
    clock: () => nowMs,
    verifiedClaimsProvider: () => ({
      issuer: "https://issuer.example",
      subject,
      audience: "https://miftah.example",
      chatContext,
      issuedAtMs: nowMs - 1_000,
      expiresAtMs
    })
  }).resolve("request");
}

function service(input: {
  now?: () => number;
  keyringProvider?: () => ProfileContextKeyringSnapshot | Promise<ProfileContextKeyringSnapshot>;
  revocations?: ProfileContextRevocationStore;
  auditKey?: Uint8Array;
  randomBytes?: (size: number) => Uint8Array;
} = {}) {
  const sharedKeyring = keyring();
  return new ProfileContextHandleService({
    deploymentId,
    profiles,
    keyringProvider: input.keyringProvider ?? (() => sharedKeyring),
    auditKey: input.auditKey ?? Buffer.alloc(32, 0x44),
    revocations: input.revocations ?? new InMemoryProfileContextRevocationStore(),
    clock: input.now ?? (() => nowMs),
    ...(input.randomBytes === undefined ? {} : { randomBytes: input.randomBytes })
  });
}

describe("production profile-context handles", () => {
  it("rejects malformed construction without leaking property access failures", () => {
    const invalidInputs: unknown[] = [
      null,
      { ...profileContextOptions(), profiles: [] },
      { ...profileContextOptions(), profiles: ["work", "work"] },
      { ...profileContextOptions(), keyringProvider: "not-a-provider" },
      { ...profileContextOptions(), revocations: {} },
      { ...profileContextOptions(), auditKey: Buffer.alloc(31) },
      { ...profileContextOptions(), clock: 1 },
      { ...profileContextOptions(), randomBytes: 1 },
      { ...profileContextOptions(), maximumLifetimeMs: 0 },
      { ...profileContextOptions(), clockSkewMs: -1 },
      new Proxy({}, { get: () => { throw new Error("private construction detail"); } })
    ];

    for (const [index, input] of invalidInputs.entries()) {
      expect(
        () => new ProfileContextHandleService(input as ProfileContextHandleServiceOptions),
        `invalid construction input ${index}`
      ).toThrowError(
        expect.objectContaining({ code: "PROFILE_CONTEXT_INVALID", message: "Profile context is invalid." })
      );
    }
    const inaccessibleStore = new Proxy({}, { get: () => { throw new Error("private store detail"); } });
    expect(() => new ProfileContextHandleService(profileContextOptions({
      revocations: inaccessibleStore as ProfileContextRevocationStore
    }))).toThrowError(expect.objectContaining({ code: "PROFILE_CONTEXT_INVALID" }));
  });

  it("alternates one handle across instances while isolating chats for one subject", async () => {
    const sharedKeyring = keyring();
    const revocations = new InMemoryProfileContextRevocationStore();
    const options = {
      deploymentId,
      profiles,
      keyringProvider: () => sharedKeyring,
      auditKey: Buffer.alloc(32, 0x44),
      revocations,
      clock: () => nowMs
    };
    const first = new ProfileContextHandleService(options);
    const second = new ProfileContextHandleService(options);
    const workChat = await authenticated("chat-work");
    const personalChat = await authenticated("chat-personal");
    const work = await first.mint("work", workChat, 60_000);
    const personal = await second.mint("personal", personalChat, 60_000);

    await expect(second.resolve(work.handle, workChat)).resolves.toMatchObject({ profile: "work" });
    await expect(first.resolve(work.handle, workChat)).resolves.toMatchObject({ profile: "work" });
    await expect(first.resolve(personal.handle, personalChat)).resolves.toMatchObject({ profile: "personal" });
    await expect(second.resolve(work.handle, personalChat)).rejects.toMatchObject({ code: "PROFILE_CONTEXT_INVALID" });
    await expect(first.resolve(personal.handle, workChat)).rejects.toMatchObject({ code: "PROFILE_CONTEXT_INVALID" });
  });

  it("binds issuer, subject, audience, chat, deployment, and profile existence", async () => {
    const sharedKeyring = keyring();
    const owner = await authenticated("chat-work");
    const first = new ProfileContextHandleService({
      deploymentId,
      profiles,
      keyringProvider: () => sharedKeyring,
      auditKey: Buffer.alloc(32, 0x44),
      revocations: new InMemoryProfileContextRevocationStore(),
      clock: () => nowMs
    });
    const handle = await first.mint("work", owner, 60_000);

    await expect(first.resolve(handle.handle, await authenticated("chat-work", "other-user"))).rejects.toMatchObject({
      code: "PROFILE_CONTEXT_INVALID"
    });
    await expect(first.resolve(handle.handle, await authenticated("other-chat"))).rejects.toMatchObject({
      code: "PROFILE_CONTEXT_INVALID"
    });
    await expect(first.mint("unknown", owner, 60_000)).rejects.toMatchObject({ code: "PROFILE_CONTEXT_INVALID" });

    const otherDeployment = new ProfileContextHandleService({
      deploymentId: "miftah.example/deployment-b",
      profiles,
      keyringProvider: () => sharedKeyring,
      auditKey: Buffer.alloc(32, 0x44),
      revocations: new InMemoryProfileContextRevocationStore(),
      clock: () => nowMs
    });
    await expect(otherDeployment.resolve(handle.handle, owner)).rejects.toMatchObject({
      code: "PROFILE_CONTEXT_INVALID"
    });

    const removedProfile = new ProfileContextHandleService({
      deploymentId,
      profiles: ["personal"],
      keyringProvider: () => sharedKeyring,
      auditKey: Buffer.alloc(32, 0x44),
      revocations: new InMemoryProfileContextRevocationStore(),
      clock: () => nowMs
    });
    await expect(removedProfile.resolve(handle.handle, owner)).rejects.toMatchObject({
      code: "PROFILE_CONTEXT_INVALID"
    });
  });

  it("caps lifetime to the host assertion and expires at the exact boundary", async () => {
    let current = nowMs;
    const instance = service({ now: () => current });
    const context = await authenticated("chat-work", "user-123", nowMs + 10_000);
    const minted = await instance.mint("work", context, 60_000);
    expect(minted.expiresAtMs).toBe(nowMs + 10_000);

    current = nowMs + 9_999;
    await expect(instance.resolve(minted.handle, { ...context, expiresAtMs: nowMs + 60_000 })).resolves.toMatchObject({
      profile: "work"
    });
    current = nowMs + 10_000;
    await expect(instance.resolve(minted.handle, { ...context, expiresAtMs: nowMs + 60_000 })).rejects.toMatchObject({
      code: "PROFILE_CONTEXT_EXPIRED"
    });
  });

  it("revokes deployment-wide and prevents another chat from revoking", async () => {
    const sharedKeyring = keyring();
    const revocations = new InMemoryProfileContextRevocationStore();
    const first = new ProfileContextHandleService({
      deploymentId,
      profiles,
      keyringProvider: () => sharedKeyring,
      auditKey: Buffer.alloc(32, 0x44),
      revocations,
      clock: () => nowMs
    });
    const second = new ProfileContextHandleService({
      deploymentId,
      profiles,
      keyringProvider: () => sharedKeyring,
      auditKey: Buffer.alloc(32, 0x44),
      revocations,
      clock: () => nowMs
    });
    const owner = await authenticated("chat-work");
    const other = await authenticated("chat-personal");
    const minted = await first.mint("work", owner, 60_000);

    await expect(second.revoke(minted.handle, other)).rejects.toMatchObject({ code: "PROFILE_CONTEXT_INVALID" });
    await expect(first.resolve(minted.handle, owner)).resolves.toMatchObject({ profile: "work" });
    await second.revoke(minted.handle, owner);
    await expect(first.resolve(minted.handle, owner)).rejects.toMatchObject({ code: "PROFILE_CONTEXT_REVOKED" });
  });

  it("commits a bearer-free switch audit before revoking and disclosing the replacement", async () => {
    const instance = service();
    const context = await authenticated("chat-work");
    const current = await instance.mint("personal", context, 60_000);
    const observed: string[] = [];

    const replacement = await instance.replace(current.handle, "work", context, 60_000, async (audit) => {
      observed.push("audit");
      expect(JSON.stringify(audit)).not.toContain(current.handle);
      expect(audit).toMatchObject({ previous: { profile: "personal" }, replacement: { profile: "work" } });
      await expect(instance.resolve(current.handle, context)).resolves.toMatchObject({ profile: "personal" });
    });
    observed.push("returned");

    expect(observed).toEqual(["audit", "returned"]);
    await expect(instance.resolve(current.handle, context)).rejects.toMatchObject({ code: "PROFILE_CONTEXT_REVOKED" });
    await expect(instance.resolve(replacement.handle, context)).resolves.toMatchObject({ profile: "work" });
  });

  it("keeps the prior handle valid and never discloses a replacement when audit commit fails", async () => {
    const instance = service({ randomBytes: (size) => Buffer.alloc(size, 0x51) });
    const context = await authenticated("chat-work");
    const current = await instance.mint("personal", context, 60_000);
    const auditFailure = new Error("required audit failed");

    await expect(instance.replace(current.handle, "work", context, 60_000, () => {
      throw auditFailure;
    })).rejects.toBe(auditFailure);
    await expect(instance.resolve(current.handle, context)).resolves.toMatchObject({ profile: "personal" });
    expect(String(auditFailure)).not.toContain(current.handle);
  });

  it("keeps the prior handle valid when replacement revocation fails after audit commit", async () => {
    const audited = vi.fn();
    const instance = service({
      revocations: {
        isRevoked: () => false,
        revoke: () => { throw new Error("store details"); }
      }
    });
    const context = await authenticated("chat-work");
    const current = await instance.mint("personal", context, 60_000);

    await expect(instance.replace(current.handle, "work", context, 60_000, audited)).rejects.toMatchObject({
      code: "PROFILE_CONTEXT_UNAVAILABLE",
      message: "Profile context is unavailable."
    });
    expect(audited).toHaveBeenCalledOnce();
    await expect(instance.resolve(current.handle, context)).resolves.toMatchObject({ profile: "personal" });
  });

  it("supports bounded rotation overlap and rejects unknown, future, expired, and rollback epochs", async () => {
    let current = nowMs;
    const firstKey = Buffer.alloc(32, 0x61);
    const secondKey = Buffer.alloc(32, 0x62);
    let snapshot = keyring(1, firstKey, nowMs - 60_000);
    const instance = service({ now: () => current, keyringProvider: () => snapshot });
    const context = await authenticated("chat-work");
    const old = await instance.mint("work", context, 10 * 60_000);

    snapshot = {
      activeEpoch: 2,
      epochs: [
        { epoch: 1, key: firstKey, activatedAtMs: nowMs - 60_000, resolveUntilMs: nowMs + 10 * 60_000 },
        { epoch: 2, key: secondKey, activatedAtMs: nowMs }
      ]
    };
    const fresh = await instance.mint("personal", context, 10 * 60_000);
    expect(fresh.handle).toMatch(/^mctx1\.2\./u);
    await expect(instance.resolve(old.handle, context)).resolves.toMatchObject({ profile: "work" });

    const unknownEpoch = old.handle.replace(/^mctx1\.1\./u, "mctx1.3.");
    await expect(instance.resolve(unknownEpoch, context)).rejects.toMatchObject({ code: "PROFILE_CONTEXT_INVALID" });

    current = nowMs + 10 * 60_000;
    await expect(instance.resolve(old.handle, { ...context, expiresAtMs: current + 60_000 })).rejects.toMatchObject({
      code: "PROFILE_CONTEXT_INVALID"
    });

    snapshot = keyring(1, firstKey, nowMs - 60_000);
    await expect(instance.mint("work", { ...context, expiresAtMs: current + 60_000 }, 10_000)).rejects.toMatchObject({
      code: "PROFILE_CONTEXT_UNAVAILABLE"
    });
  });

  it("fails closed when key, revocation, clock, or randomness state is unavailable", async () => {
    const context = await authenticated("chat-work");
    const stableKeyring = keyring();
    const stable = service({ keyringProvider: () => stableKeyring });
    const minted = await stable.mint("work", context, 60_000);

    await expect(service({ keyringProvider: () => { throw new Error("kms details"); } }).mint("work", context, 60_000))
      .rejects.toMatchObject({ code: "PROFILE_CONTEXT_UNAVAILABLE", message: "Profile context is unavailable." });
    await expect(service({ keyringProvider: () => ({ activeEpoch: 1, epochs: [] }) }).mint("work", context, 60_000))
      .rejects.toMatchObject({ code: "PROFILE_CONTEXT_UNAVAILABLE" });
    await expect(service({ now: () => { throw new Error("clock details"); } }).mint("work", context, 60_000))
      .rejects.toMatchObject({ code: "PROFILE_CONTEXT_UNAVAILABLE" });
    await expect(service({ randomBytes: () => { throw new Error("rng details"); } }).mint("work", context, 60_000))
      .rejects.toMatchObject({ code: "PROFILE_CONTEXT_UNAVAILABLE" });
    await expect(service({ randomBytes: (size) => Buffer.alloc(size - 1) }).mint("work", context, 60_000))
      .rejects.toMatchObject({ code: "PROFILE_CONTEXT_UNAVAILABLE" });
    await expect(service({ now: () => -1 }).mint("work", context, 60_000))
      .rejects.toMatchObject({ code: "PROFILE_CONTEXT_UNAVAILABLE" });
    await expect(service({ now: () => Number.MAX_SAFE_INTEGER + 1 }).mint("work", context, 60_000))
      .rejects.toMatchObject({ code: "PROFILE_CONTEXT_UNAVAILABLE" });

    const unavailableRead = service({
      keyringProvider: () => stableKeyring,
      revocations: { isRevoked: () => { throw new Error("store details"); }, revoke: () => undefined }
    });
    await expect(unavailableRead.resolve(minted.handle, context)).rejects.toMatchObject({
      code: "PROFILE_CONTEXT_UNAVAILABLE",
      message: "Profile context is unavailable."
    });
    const nonBooleanRead = service({
      keyringProvider: () => stableKeyring,
      revocations: { isRevoked: () => "no" as unknown as boolean, revoke: () => undefined }
    });
    await expect(nonBooleanRead.resolve(minted.handle, context)).rejects.toMatchObject({
      code: "PROFILE_CONTEXT_UNAVAILABLE"
    });
    const unavailableWrite = service({
      keyringProvider: () => stableKeyring,
      revocations: { isRevoked: () => false, revoke: () => { throw new Error("store details"); } }
    });
    await expect(unavailableWrite.revoke(minted.handle, context)).rejects.toMatchObject({
      code: "PROFILE_CONTEXT_UNAVAILABLE"
    });
  });

  it("rejects malformed key-manager snapshots and same-epoch key replacement", async () => {
    const context = await authenticated("chat-work");
    const firstKey = Buffer.alloc(32, 0x21);
    const secondKey = Buffer.alloc(32, 0x22);
    const invalidSnapshots: unknown[] = [
      null,
      { activeEpoch: 1, epochs: [null] },
      { activeEpoch: 1, epochs: [
        { epoch: 1, key: firstKey, activatedAtMs: nowMs - 1_000 },
        { epoch: 1, key: firstKey, activatedAtMs: nowMs - 1_000 }
      ] },
      { activeEpoch: 1, epochs: [{ epoch: 1, key: firstKey, activatedAtMs: nowMs - 1_000, resolveUntilMs: nowMs + 1_000 }] },
      { activeEpoch: 1, epochs: [{ epoch: 1, key: firstKey, activatedAtMs: nowMs + 31_000 }] },
      { activeEpoch: 1, epochs: [
        { epoch: 1, key: firstKey, activatedAtMs: nowMs - 1_000 },
        { epoch: 2, key: secondKey, activatedAtMs: nowMs - 1_000, resolveUntilMs: nowMs + 1_000 }
      ] },
      { activeEpoch: 2, epochs: [
        { epoch: 1, key: firstKey, activatedAtMs: nowMs - 2_000 },
        { epoch: 2, key: secondKey, activatedAtMs: nowMs - 1_000 }
      ] },
      { activeEpoch: 2, epochs: [
        { epoch: 1, key: firstKey, activatedAtMs: nowMs - 2_000, resolveUntilMs: nowMs - 2_000 },
        { epoch: 2, key: secondKey, activatedAtMs: nowMs - 1_000 }
      ] },
      { activeEpoch: 2, epochs: [{ epoch: 1, key: firstKey, activatedAtMs: nowMs - 2_000, resolveUntilMs: nowMs + 1_000 }] },
      { activeEpoch: 2, epochs: [
        { epoch: 1, key: firstKey, activatedAtMs: nowMs - 2_000, resolveUntilMs: nowMs + 16 * 60_000 },
        { epoch: 2, key: secondKey, activatedAtMs: nowMs }
      ] }
    ];

    for (const [index, snapshot] of invalidSnapshots.entries()) {
      await expect(new ProfileContextHandleService(profileContextOptions({
        keyringProvider: () => snapshot as ProfileContextKeyringSnapshot
      })).mint("work", context, 60_000), `invalid keyring snapshot ${index}`).rejects.toMatchObject({
        code: "PROFILE_CONTEXT_UNAVAILABLE"
      });
    }

    let snapshot = keyring(1, firstKey);
    const instance = service({ keyringProvider: () => snapshot });
    await instance.mint("work", context, 60_000);
    snapshot = keyring(1, secondKey);
    await expect(instance.mint("work", context, 60_000)).rejects.toMatchObject({
      code: "PROFILE_CONTEXT_UNAVAILABLE"
    });
  });

  it("rejects malformed envelopes, authenticated contexts, and replacement inputs", async () => {
    const instance = service();
    const context = await authenticated("chat-work");
    const minted = await instance.mint("work", context, 60_000);
    const parts = minted.handle.split(".");
    const malformed: unknown[] = [
      undefined,
      "x".repeat(4_097),
      "mctx1.1.bad",
      minted.handle.replace(/^mctx1/u, "wrong"),
      minted.handle.replace(/^mctx1\.1/u, "mctx1.01"),
      [parts[0], parts[1], "!", parts[3], parts[4]].join("."),
      [parts[0], parts[1], parts[2], "!", parts[4]].join("."),
      [parts[0], parts[1], Buffer.alloc(11, 0x55).toString("base64url"), parts[3], parts[4]].join("."),
      [parts[0], parts[1], parts[2], parts[3], Buffer.alloc(15, 0x55).toString("base64url")].join(".")
    ];
    for (const [index, handle] of malformed.entries()) {
      await expect(instance.resolve(handle as string, context), `malformed handle ${index}`).rejects.toMatchObject({
        code: "PROFILE_CONTEXT_INVALID",
        message: "Profile context is invalid."
      });
    }

    const invalidContexts: unknown[] = [
      null,
      [],
      { binding: "bad", expiresAtMs: context.expiresAtMs },
      { binding: context.binding, expiresAtMs: "later" },
      { binding: context.binding, expiresAtMs: nowMs },
      new Proxy({}, { get: () => { throw new Error("private request detail"); } })
    ];
    for (const [index, invalidContext] of invalidContexts.entries()) {
      await expect(
        instance.resolve(minted.handle, invalidContext as AuthenticatedRequestContext),
        `invalid authenticated context ${index}`
      ).rejects.toBeInstanceOf(
        ProfileContextHandleError
      );
    }
    await expect(instance.mint("work", context, 16 * 60_000)).rejects.toMatchObject({
      code: "PROFILE_CONTEXT_INVALID"
    });
    await expect(instance.replace(
      minted.handle,
      "personal",
      context,
      60_000,
      undefined as unknown as () => void
    )).rejects.toMatchObject({ code: "PROFILE_CONTEXT_INVALID" });
  });

  it("rejects authenticated ciphertext with malformed or inconsistent payload fields", async () => {
    const sealingKey = Buffer.alloc(32, 0x31);
    const instance = service({ keyringProvider: () => keyring(1, sealingKey) });
    const context = await authenticated("chat-work");
    const base = {
      version: 1,
      id: Buffer.alloc(16, 0x41).toString("base64url"),
      deploymentId,
      keyEpoch: 1,
      profile: "work",
      binding: context.binding,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 60_000
    };
    const invalidPayloads: unknown[] = [
      null,
      [],
      { ...base, extra: true },
      { ...base, version: 2 },
      { ...base, id: "bad" },
      { ...base, deploymentId: 1 },
      { ...base, profile: 1 },
      { ...base, binding: "bad" },
      { ...base, keyEpoch: "1" },
      { ...base, issuedAtMs: "now" },
      { ...base, expiresAtMs: "later" },
      { ...base, keyEpoch: 0 },
      { ...base, issuedAtMs: -1 },
      { ...base, expiresAtMs: nowMs }
    ];
    for (const [index, payload] of invalidPayloads.entries()) {
      await expect(
        instance.resolve(sealPayload(payload, sealingKey), context),
        `invalid sealed payload ${index}`
      ).rejects.toMatchObject({
        code: "PROFILE_CONTEXT_INVALID"
      });
    }
    await expect(instance.resolve(sealPlaintext("not-json", sealingKey), context)).rejects.toMatchObject({
      code: "PROFILE_CONTEXT_INVALID"
    });
    await expect(instance.resolve(sealPayload({ ...base, deploymentId: "other" }, sealingKey), context))
      .rejects.toMatchObject({ code: "PROFILE_CONTEXT_INVALID" });
    await expect(instance.resolve(sealPayload({ ...base, issuedAtMs: nowMs + 31_000, expiresAtMs: nowMs + 60_000 }, sealingKey), context))
      .rejects.toMatchObject({ code: "PROFILE_CONTEXT_INVALID" });
    await expect(instance.resolve(sealPayload({ ...base, issuedAtMs: nowMs - 1, expiresAtMs: nowMs + 16 * 60_000 }, sealingKey), context))
      .rejects.toMatchObject({ code: "PROFILE_CONTEXT_INVALID" });
  });

  it("normalizes tampering and never reports the bearer or plaintext account data", async () => {
    const instance = service({ randomBytes: (size) => Buffer.alloc(size, 0x5a) });
    const context = await authenticated("chat-work");
    const minted = await instance.mint("work", context, 60_000);
    const resolved = await instance.resolve(minted.handle, context);
    const ciphertext = Buffer.from(minted.handle.split(".")[3]!, "base64url");

    expect(ciphertext.includes(Buffer.from('"profile":"work"', "utf8"))).toBe(false);
    expect(minted.handle).not.toContain(context.binding);
    expect(JSON.stringify(resolved)).not.toContain(minted.handle);
    expect(resolved.auditCorrelation).toMatch(/^mctxc1\.[A-Za-z0-9_-]{22}$/u);

    let failure: unknown;
    try {
      await instance.resolve(`${minted.handle}tampered`, context);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ProfileContextHandleError);
    expect(failure).toMatchObject({ code: "PROFILE_CONTEXT_INVALID", message: "Profile context is invalid." });
    expect(String(failure)).not.toContain(minted.handle);
  });

  it("copies audit material and rejects reused sealing/audit keys", async () => {
    const sealingKey = Buffer.alloc(32, 0x71);
    const auditKey = Buffer.alloc(32, 0x72);
    const snapshot = keyring(1, sealingKey);
    const instance = service({ keyringProvider: () => snapshot, auditKey });
    auditKey.fill(0);
    await expect(instance.mint("work", await authenticated("chat-work"), 60_000)).resolves.toMatchObject({
      profile: "work"
    });

    const reused = Buffer.alloc(32, 0x73);
    await expect(service({ keyringProvider: () => keyring(1, reused), auditKey: reused }).mint(
      "work",
      await authenticated("chat-work"),
      60_000
    )).rejects.toMatchObject({ code: "PROFILE_CONTEXT_UNAVAILABLE" });
  });

  it("bounds the in-memory revocation store instead of silently evicting live entries", () => {
    const store = new InMemoryProfileContextRevocationStore(1);
    const first = Buffer.alloc(16, 0x01).toString("base64url");
    const second = Buffer.alloc(16, 0x02).toString("base64url");
    store.revoke(first, nowMs + 60_000, nowMs);
    expect(() => store.revoke(second, nowMs + 60_000, nowMs)).toThrow("capacity is unavailable");
    expect(store.isRevoked(first, nowMs)).toBe(true);

    const pruningStore = new InMemoryProfileContextRevocationStore(1);
    pruningStore.revoke(first, nowMs + 1, nowMs);
    pruningStore.revoke(second, nowMs + 60_000, nowMs + 1);
    expect(pruningStore.isRevoked(first, nowMs + 1)).toBe(false);
    expect(pruningStore.isRevoked(second, nowMs + 1)).toBe(true);
    pruningStore.revoke(second, nowMs + 1, nowMs + 1);
    expect(pruningStore.isRevoked(second, nowMs + 1)).toBe(false);
    expect(() => pruningStore.revoke("bad", nowMs + 60_000, nowMs)).toThrowError(
      expect.objectContaining({ code: "PROFILE_CONTEXT_INVALID" })
    );
  });

  it("does not expose a handle to the replacement audit callback", async () => {
    const instance = service();
    const context = await authenticated("chat-work");
    const current = await instance.mint("personal", context, 60_000);
    const audit = vi.fn();
    await instance.replace(current.handle, "work", context, 60_000, audit);
    expect(audit).toHaveBeenCalledOnce();
    expect(audit.mock.calls[0]?.[0]).not.toHaveProperty("handle");
    expect(audit.mock.calls[0]?.[0]?.replacement).not.toHaveProperty("handle");
  });
});
