import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileManager } from "../src/profiles/profile-manager.js";
import { resolveProfileStatePath } from "../src/profiles/profile-state.js";
import { MiftahError } from "../src/utils/errors.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-profile-state-"));
  directories.push(directory);
  return directory;
}

const profiles = {
  defaultProfile: "work",
  profiles: { work: {}, personal: {} }
};

describe("profile state", () => {
  it("persists a workspace selection atomically and restores its source metadata", async () => {
    const directory = await createDirectory();
    const configPath = join(directory, "miftah.json");
    const state = { persistActiveProfile: true as const, scope: "workspace" as const, configPath };
    const first = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, state);

    await first.initialize();
    await first.switchPersisted("personal");

    expect(first.current()).toMatchObject({
      activeProfile: "personal",
      selectionSource: "mcp-switch",
      scope: "workspace"
    });

    const statePath = resolveProfileStatePath(state);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ profile: "personal", scope: "workspace" });
    if (process.platform !== "win32") {
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
      expect((await stat(dirname(statePath))).mode & 0o777).toBe(0o700);
    }

    const restarted = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, state);
    await restarted.initialize();

    expect(restarted.current()).toMatchObject({
      activeProfile: "personal",
      selectionSource: "persisted-workspace",
      scope: "workspace"
    });
    expect(restarted.current().selectedAt).toEqual(expect.any(String));
  });

  it("falls back safely when durable state is corrupt, stale, or superseded by a lock", async () => {
    const directory = await createDirectory();
    const configPath = join(directory, "miftah.json");
    const state = { persistActiveProfile: true as const, scope: "workspace" as const, configPath };
    const statePath = resolveProfileStatePath(state);

    const initial = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, state);
    await initial.initialize();
    await initial.switchPersisted("personal");
    const validRecord = JSON.parse(await readFile(statePath, "utf8")) as { configIdentity: string };
    await writeFile(statePath, "not-json");
    const corrupt = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, state);
    await corrupt.initialize();
    expect(corrupt.current()).toMatchObject({
      activeProfile: "work",
      selectionSource: "configured-default",
      stateDiagnostic: "PROFILE_STATE_INVALID"
    });

    await writeFile(
      statePath,
      JSON.stringify({
        version: 1,
        scope: "workspace",
        configIdentity: validRecord.configIdentity,
        profile: "removed",
        selectedAt: new Date().toISOString()
      })
    );
    const stale = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, state);
    await stale.initialize();
    expect(stale.current()).toMatchObject({ activeProfile: "work", stateDiagnostic: "PROFILE_STATE_STALE" });

    const locked = new ProfileManager(
      profiles,
      { allowProfileSwitchingFromMcp: true, lockToProfile: "personal" },
      state
    );
    await locked.initialize();
    expect(locked.current()).toMatchObject({ activeProfile: "personal", selectionSource: "configured-lock" });
  });

  it("does not let a reset bypass a configured lock or write durable state", async () => {
    const directory = await createDirectory();
    const configPath = join(directory, "miftah.json");
    const state = { persistActiveProfile: true as const, scope: "workspace" as const, configPath };
    const manager = new ProfileManager(
      profiles,
      { allowProfileSwitchingFromMcp: true, lockToProfile: "personal" },
      state
    );

    await manager.initialize();
    expect(() => manager.reset()).toThrow(/PROFILE_SWITCH_DISABLED/);
    await expect(manager.resetPersisted()).rejects.toMatchObject({ code: "PROFILE_SWITCH_DISABLED" });
    expect(manager.current()).toMatchObject({ activeProfile: "personal", selectionSource: "configured-lock" });
    await expect(access(resolveProfileStatePath(state))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects inherited object properties as direct or persisted profile selections", async () => {
    const directory = await createDirectory();
    const configPath = join(directory, "miftah.json");
    const state = { persistActiveProfile: true as const, scope: "workspace" as const, configPath };
    const manager = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, state);

    for (const inheritedProfile of ["toString", "__proto__"]) {
      expect(() => manager.switch(inheritedProfile)).toThrow(/PROFILE_NOT_FOUND/);
    }

    await manager.initialize();
    await manager.switchPersisted("personal");
    const statePath = resolveProfileStatePath(state);
    const record = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    await writeFile(statePath, JSON.stringify({ ...record, profile: "toString" }));

    const restarted = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, state);
    await restarted.initialize();
    expect(restarted.current()).toMatchObject({
      activeProfile: "work",
      selectionSource: "configured-default",
      stateDiagnostic: "PROFILE_STATE_STALE"
    });
  });

  it("keeps session selections isolated and writes only complete records under concurrent workspace changes", async () => {
    const directory = await createDirectory();
    const configPath = join(directory, "miftah.json");
    const workspace = { persistActiveProfile: true as const, scope: "workspace" as const, configPath };
    const managers = Array.from(
      { length: 8 },
      () => new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, workspace)
    );
    await Promise.all(managers.map((manager) => manager.initialize()));
    await Promise.all(managers.map((manager, index) => manager.switchPersisted(index % 2 === 0 ? "work" : "personal")));

    const record = JSON.parse(await readFile(resolveProfileStatePath(workspace), "utf8")) as { profile?: string };
    expect(record.profile === "work" || record.profile === "personal").toBe(true);

    const sessionOptions = { scope: "session" as const, configPath };
    const firstSession = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, sessionOptions);
    const secondSession = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, sessionOptions);
    await Promise.all([firstSession.initialize(), secondSession.initialize()]);
    await firstSession.switchPersisted("personal");
    expect(firstSession.current().activeProfile).toBe("personal");
    expect(secondSession.current()).toMatchObject({ activeProfile: "work", scope: "session" });
  });

  it("does not let another process silently replace an active client's in-memory selection", async () => {
    const directory = await createDirectory();
    const state = {
      persistActiveProfile: true as const,
      scope: "workspace" as const,
      configPath: join(directory, "miftah.json")
    };
    const activeClient = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, state);
    const externalManager = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, state);
    await Promise.all([activeClient.initialize(), externalManager.initialize()]);

    await externalManager.switchPersisted("personal");

    expect(activeClient.current()).toMatchObject({ activeProfile: "work", selectionSource: "configured-default" });
    const restartedClient = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, state);
    await restartedClient.initialize();
    expect(restartedClient.current()).toMatchObject({ activeProfile: "personal", selectionSource: "persisted-workspace" });
  });

  it("resets session scope when the MCP connection begins", async () => {
    const directory = await createDirectory();
    const manager = new ProfileManager(
      profiles,
      { allowProfileSwitchingFromMcp: true },
      { scope: "session", configPath: join(directory, "miftah.json") }
    );

    await manager.initialize();
    await manager.switchPersisted("personal");
    await manager.beginSession();

    expect(manager.current()).toMatchObject({
      activeProfile: "work",
      selectionSource: "configured-default",
      scope: "session"
    });
  });

  it("namespaces global selections by configuration identity", async () => {
    const directory = await createDirectory();
    const globalStateDirectory = join(directory, "user-state");
    const firstState = {
      persistActiveProfile: true as const,
      scope: "global" as const,
      configPath: join(directory, "first.miftah.json"),
      globalStateDirectory
    };
    const secondState = { ...firstState, configPath: join(directory, "second.miftah.json") };
    const first = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, firstState);

    await first.initialize();
    await first.switchPersisted("personal");

    const restarted = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, firstState);
    const unrelated = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, secondState);
    await Promise.all([restarted.initialize(), unrelated.initialize()]);

    expect(restarted.current()).toMatchObject({
      activeProfile: "personal",
      selectionSource: "persisted-global",
      scope: "global"
    });
    expect(unrelated.current()).toMatchObject({ activeProfile: "work", selectionSource: "configured-default" });
    expect(resolveProfileStatePath(firstState)).not.toBe(resolveProfileStatePath(secondState));
  });

  it("ignores relative XDG_STATE_HOME values when deriving global state", () => {
    if (process.platform === "win32" || process.platform === "darwin") return;
    const original = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "relative-state-directory";
    try {
      const path = resolveProfileStatePath({
        persistActiveProfile: true,
        scope: "global",
        configPath: "/tmp/miftah-profile-state.json"
      });
      expect(path.startsWith(join(homedir(), ".local", "state", "miftah", "state"))).toBe(true);
    } finally {
      if (original === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = original;
    }
  });

  it("leaves the active profile unchanged when durable persistence cannot write", async () => {
    const directory = await createDirectory();
    const configPath = join(directory, "miftah.json");
    await writeFile(join(directory, ".miftah"), "not-a-directory");
    const manager = new ProfileManager(
      profiles,
      { allowProfileSwitchingFromMcp: true },
      { persistActiveProfile: true, scope: "workspace", configPath }
    );

    await manager.initialize();
    await expect(manager.switchPersisted("personal")).rejects.toMatchObject({ code: "PROFILE_STATE_WRITE_FAILED" });
    expect(manager.current()).toMatchObject({ activeProfile: "work", selectionSource: "configured-default" });
  });

  it("restores durable profile state when a required profile audit write fails", async () => {
    const directory = await createDirectory();
    const configPath = join(directory, "miftah.json");
    const state = { persistActiveProfile: true as const, scope: "workspace" as const, configPath };
    const manager = new ProfileManager(profiles, { allowProfileSwitchingFromMcp: true }, state);

    await manager.initialize();
    await manager.switchPersisted("personal");
    await expect(
      manager.mutateAudited(
        () => manager.switchPersisted("work"),
        async () => {
          throw new MiftahError("AUDIT_WRITE_FAILED", "AUDIT_WRITE_FAILED: test audit sink rejected profile transition");
        }
      )
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });

    expect(manager.current()).toMatchObject({ activeProfile: "personal", selectionSource: "mcp-switch" });
    expect(JSON.parse(await readFile(resolveProfileStatePath(state), "utf8"))).toMatchObject({ profile: "personal" });
  });
});
