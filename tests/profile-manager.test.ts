import { describe, expect, it } from "vitest";
import { ProfileManager } from "../src/profiles/profile-manager.js";

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
});
