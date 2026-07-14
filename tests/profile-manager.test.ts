import { describe, expect, it } from "vitest";
import { bindProfileTransitionConfirmationVerifier, ProfileManager } from "../src/profiles/profile-manager.js";

describe("profile manager", () => {
  it("switches active profiles and exposes only non-secret metadata", () => {
    const manager = new ProfileManager(
      {
        defaultProfile: "work",
        profiles: {
          work: { description: "Work", tags: ["prod"], env: { TOKEN: "secret" } },
          personal: { description: "Personal", env: { TOKEN: "secret" } }
        }
      },
      { allowProfileSwitchingFromMcp: true }
    );

    expect(manager.current()).toMatchObject({
      activeProfile: "work",
      defaultProfile: "work",
      revision: 0,
      selectionSource: "configured-default",
      scope: "process"
    });
    expect(manager.current().selectedAt).toEqual(expect.any(String));
    expect(manager.switch("personal")).toEqual({
      previousProfile: "work",
      activeProfile: "personal",
      revision: 1
    });
    expect(manager.reset()).toEqual({ previousProfile: "personal", activeProfile: "work", revision: 2 });
    expect(manager.info("personal")).toEqual({
      name: "personal",
      description: "Personal",
      tags: [],
      envKeys: ["TOKEN"]
    });
  });

  it("blocks profile switching when locked", () => {
    const manager = new ProfileManager(
      { defaultProfile: "work", profiles: { work: {}, personal: {} } },
      { allowProfileSwitchingFromMcp: false }
    );

    expect(() => manager.switch("personal")).toThrow(/PROFILE_SWITCH_DISABLED/);
  });

  it("issues a lease for an explicit selection and reports its exact expiry", () => {
    let now = new Date("2026-07-12T00:00:00.000Z");
    const manager = new ProfileManager(
      {
        defaultProfile: "work",
        profiles: {
          work: { lease: { ttlMs: 1_000, requiredForRisk: ["write"] } },
          personal: {}
        }
      },
      { allowProfileSwitchingFromMcp: true },
      undefined,
      { now: () => now }
    );

    expect(manager.current()).toMatchObject({
      activeProfile: "work",
      lease: { state: "required", profile: "work", requiredForRisk: ["write"] }
    });

    manager.switch("work");
    expect(manager.current()).toMatchObject({
      activeProfile: "work",
      selectionSource: "mcp-switch",
      lease: { state: "active", profile: "work", expiresAt: "2026-07-12T00:00:01.000Z" }
    });

    now = new Date("2026-07-12T00:00:01.000Z");
    expect(manager.current()).toMatchObject({
      activeProfile: "work",
      lease: { state: "expired", profile: "work", expiresAt: "2026-07-12T00:00:01.000Z" }
    });
  });

  it("clears a runtime lease when a new MCP session begins", async () => {
    const manager = new ProfileManager(
      {
        defaultProfile: "work",
        profiles: { work: { lease: { ttlMs: 1_000, requiredForRisk: ["write"] } } }
      },
      { allowProfileSwitchingFromMcp: true }
    );
    manager.switch("work");
    expect(manager.current().lease).toMatchObject({ state: "active", profile: "work" });

    await manager.beginSession();

    expect(manager.current()).toMatchObject({
      activeProfile: "work",
      lease: { state: "required", profile: "work" }
    });
  });

  it("does not treat a previous connection's explicit selection as current-session selection", async () => {
    const manager = new ProfileManager(
      { defaultProfile: "work", profiles: { work: {}, personal: {} } },
      { allowProfileSwitchingFromMcp: true, requireProfileSwitchConfirmation: true },
      { scope: "process", configPath: "/tmp/miftah-profile-session-boundary.json" }
    );
    const confirmations = new WeakSet<object>();
    bindProfileTransitionConfirmationVerifier(manager, (request) => {
      if (
        request.action !== "switch" ||
        request.profile !== "personal" ||
        request.revision !== 0 ||
        !confirmations.has(request.proof)
      ) {
        return false;
      }
      confirmations.delete(request.proof);
      return true;
    });
    const confirmation = Object.freeze({});
    confirmations.add(confirmation);
    manager.switch("personal", { confirmation, expectedRevision: manager.current().revision });
    expect(manager.current()).toMatchObject({
      activeProfile: "personal",
      selectionSource: "mcp-switch",
      confirmation: "confirmed"
    });

    await manager.beginSession();

    expect(manager.current()).toMatchObject({
      activeProfile: "personal",
      selectionSource: "prior-session",
      confirmation: "not-confirmed"
    });
  });

  it("prevents switching away from an opted-in runtime lock until it is unlocked", async () => {
    const manager = new ProfileManager(
      { defaultProfile: "work", profiles: { work: {}, personal: {} } },
      { allowProfileSwitchingFromMcp: true, allowProfileLockingFromMcp: true }
    );

    expect(manager.lock()).toMatchObject({ profile: "work" });
    expect(manager.current().lock).toMatchObject({ state: "runtime", profile: "work" });
    expect(() => manager.switch("personal")).toThrow(expect.objectContaining({ code: "PROFILE_LOCKED" }));

    expect(manager.unlock()).toMatchObject({ profile: "work" });
    expect(manager.current().lock).toEqual({ state: "none" });
    expect(manager.switch("personal")).toMatchObject({ activeProfile: "personal" });

    manager.lock();
    await manager.beginSession();
    expect(manager.current().lock).toEqual({ state: "none" });
  });

  it("keeps configured locks immutable even when runtime locking is otherwise disabled", () => {
    const manager = new ProfileManager(
      { defaultProfile: "work", profiles: { work: {}, personal: {} } },
      { lockToProfile: "work" }
    );

    expect(() => manager.lock()).toThrow(expect.objectContaining({ code: "PROFILE_LOCKED" }));
    expect(() => manager.unlock()).toThrow(expect.objectContaining({ code: "PROFILE_LOCKED" }));
  });

  it("does not let a direct caller claim a profile confirmation", () => {
    const manager = new ProfileManager(
      { defaultProfile: "work", profiles: { work: {}, personal: {} } },
      { allowProfileSwitchingFromMcp: true, requireProfileSwitchConfirmation: true }
    );

    expect(() => manager.switch("personal")).toThrow(
      expect.objectContaining({ code: "PROFILE_SWITCH_CONFIRMATION_REQUIRED" })
    );
    const forgedConfirmation = { confirmed: true } as unknown as NonNullable<Parameters<typeof manager.switch>[1]>;
    expect(() => manager.switch("personal", forgedConfirmation)).toThrow(
      expect.objectContaining({ code: "PROFILE_SWITCH_CONFIRMATION_REQUIRED" })
    );
    const forgedProof = { confirmation: Object.freeze({}), expectedRevision: manager.current().revision } as NonNullable<
      Parameters<typeof manager.switch>[1]
    >;
    expect(() => manager.switch("personal", forgedProof)).toThrow(
      expect.objectContaining({ code: "PROFILE_SWITCH_CONFIRMATION_REQUIRED" })
    );
    expect(manager.current()).toMatchObject({ activeProfile: "work", confirmation: "not-confirmed" });
  });

  it("accepts a server-minted confirmation proof only for its bound transition", () => {
    const manager = new ProfileManager(
      { defaultProfile: "work", profiles: { work: {}, personal: {} } },
      { allowProfileSwitchingFromMcp: true, requireProfileSwitchConfirmation: true }
    );
    const confirmations = new WeakSet<object>();
    let verifierCalls = 0;
    bindProfileTransitionConfirmationVerifier(manager, (request) => {
      verifierCalls += 1;
      if (
        request.action !== "switch" ||
        request.profile !== "personal" ||
        request.revision !== 0 ||
        !confirmations.has(request.proof)
      ) {
        return false;
      }
      confirmations.delete(request.proof);
      return true;
    });
    const confirmation = Object.freeze({});
    confirmations.add(confirmation);

    expect(manager.switch("personal", { confirmation, expectedRevision: 0 })).toMatchObject({ activeProfile: "personal" });
    expect(manager.current().confirmation).toBe("confirmed");
    expect(verifierCalls).toBe(1);
  });

  it("rejects a transition after its selection generation becomes stale before checking confirmation", async () => {
    const manager = new ProfileManager(
      { defaultProfile: "work", profiles: { work: {}, personal: {} } },
      { allowProfileSwitchingFromMcp: true, requireProfileSwitchConfirmation: true }
    );
    let verifierCalls = 0;
    bindProfileTransitionConfirmationVerifier(manager, () => {
      verifierCalls += 1;
      return true;
    });
    const expectedRevision = manager.current().revision;
    await manager.beginSession();
    const confirmation = Object.freeze({});

    expect(() => manager.switch("work", { confirmation, expectedRevision })).toThrow(
      expect.objectContaining({ code: "PROFILE_SELECTION_STALE" })
    );
    expect(verifierCalls).toBe(0);
    expect(manager.current().activeProfile).toBe("work");
  });
});
