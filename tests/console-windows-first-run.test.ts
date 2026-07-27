import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aclMocks = vi.hoisted(() => ({
  createPrivateDirectory: vi.fn<(directory: string) => Promise<boolean>>(),
  createPrivateDirectoryInParent: vi.fn<(parent: string, directory: string) => Promise<boolean>>(),
  secureFile: vi.fn<(path: string) => Promise<boolean>>(),
  verifyPath: vi.fn<(path: string, kind: "file" | "directory") => Promise<boolean>>(),
  verifyPaths: vi.fn<(paths: readonly { readonly path: string; readonly kind: "file" | "directory" }[]) => Promise<boolean>>()
}));

vi.mock("../src/cli/windows-config-acl.js", () => ({
  createWindowsPrivateDirectory: aclMocks.createPrivateDirectory,
  createWindowsPrivateDirectoryInPrivateParent: aclMocks.createPrivateDirectoryInParent,
  secureWindowsConfigFile: aclMocks.secureFile,
  verifyWindowsConfigPathSecurity: aclMocks.verifyPath,
  verifyWindowsConfigPathsSecurity: aclMocks.verifyPaths
}));

vi.mock("../src/oauth/local-lock.js", () => ({
  OAuthLocalLockUnavailableError: class OAuthLocalLockUnavailableError extends Error {},
  withOAuthLocalLock: async (
    _scope: string,
    _value: string,
    _waitMilliseconds: number,
    operation: () => Promise<unknown>
  ) => operation()
}));

import { ConsoleDashboardApplicationService } from "../src/console/console-dashboard-application-service.js";
import { FileSetupDraftStore } from "../src/setup/setup-draft.js";

const temporaryDirectories: string[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  aclMocks.verifyPath.mockResolvedValue(true);
  aclMocks.verifyPaths.mockResolvedValue(true);
  aclMocks.secureFile.mockResolvedValue(true);
  aclMocks.createPrivateDirectory.mockImplementation(async (directory) => {
    try {
      await mkdir(directory);
      return true;
    } catch {
      return false;
    }
  });
  aclMocks.createPrivateDirectoryInParent.mockImplementation(async (_parent, directory) => {
    try {
      await mkdir(directory);
      return true;
    } catch {
      return false;
    }
  });
});

afterEach(async () => {
  if (platformDescriptor !== undefined) Object.defineProperty(process, "platform", platformDescriptor);
  aclMocks.createPrivateDirectory.mockReset();
  aclMocks.createPrivateDirectoryInParent.mockReset();
  aclMocks.secureFile.mockReset();
  aclMocks.verifyPath.mockReset();
  aclMocks.verifyPaths.mockReset();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Console Windows first-run boundary", () => {
  it("reuses the trusted creator verification for a newly created config directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "miftah-console-windows-first-run-"));
    temporaryDirectories.push(parent);
    const configDirectory = join(parent, "miftah");
    const configPath = join(configDirectory, "miftah.json");
    const service = new ConsoleDashboardApplicationService({ configDirectory, defaultConfigPath: configPath });

    await expect(service.onboardNativeOAuth({
      name: "first-run",
      profile: "default",
      resource: "https://mcp.example.test/mcp",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: ["openid"]
    })).resolves.toMatchObject({ changed: true, write: true });

    expect(aclMocks.createPrivateDirectoryInParent).toHaveBeenCalledWith(parent, configDirectory);
    // Catalog discovery independently verifies the created configuration after
    // publication. The creator must not add a second directory probe before it.
    expect(aclMocks.verifyPath).toHaveBeenCalledTimes(2);
    expect(aclMocks.verifyPath).toHaveBeenNthCalledWith(1, expect.stringMatching(/[/\\]miftah$/u), "directory");
    expect(aclMocks.verifyPath).toHaveBeenNthCalledWith(2, expect.stringMatching(/[/\\]miftah\.json$/u), "file");
    expect(aclMocks.verifyPaths).not.toHaveBeenCalled();
    expect(aclMocks.secureFile).toHaveBeenCalledWith(configPath);
  });

  it("fails closed if a created config directory becomes a symlink before the first write", async () => {
    const parent = await mkdtemp(join(tmpdir(), "miftah-console-windows-first-run-swap-"));
    temporaryDirectories.push(parent);
    const configDirectory = join(parent, "miftah");
    const redirectedDirectory = join(parent, "redirected");
    const configPath = join(configDirectory, "miftah.json");
    let swapStage = "not-started";
    await mkdir(redirectedDirectory);
    aclMocks.createPrivateDirectoryInParent.mockImplementationOnce(async (_parent, directory) => {
      await mkdir(directory);
      swapStage = "created";
      await rm(directory, { recursive: true });
      swapStage = "removed";
      await symlink(redirectedDirectory, directory);
      swapStage = "symlinked";
      return true;
    });
    const service = new ConsoleDashboardApplicationService({ configDirectory, defaultConfigPath: configPath });

    await expect(service.onboardNativeOAuth({
      name: "first-run",
      profile: "default",
      resource: "https://mcp.example.test/mcp",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: ["openid"]
    })).rejects.toMatchObject({ code: "CONFIG_CREATE_FAILED" });

    expect(swapStage).toBe("symlinked");
    await expect(readFile(join(redirectedDirectory, "miftah.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fully verifies a first-run config directory created by another Windows process", async () => {
    const parent = await mkdtemp(join(tmpdir(), "miftah-console-windows-first-run-race-"));
    temporaryDirectories.push(parent);
    const configDirectory = join(parent, "miftah");
    const configPath = join(configDirectory, "miftah.json");
    aclMocks.createPrivateDirectoryInParent.mockImplementationOnce(async (_parent, directory) => {
      await mkdir(directory);
      return false;
    });
    const service = new ConsoleDashboardApplicationService({ configDirectory, defaultConfigPath: configPath });

    await expect(service.onboardNativeOAuth({
      name: "first-run",
      profile: "default",
      resource: "https://mcp.example.test/mcp",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: ["openid"]
    })).resolves.toMatchObject({ changed: true, write: true });

    expect(aclMocks.verifyPaths).toHaveBeenCalledWith([
      { path: parent, kind: "directory" },
      { path: configDirectory, kind: "directory" }
    ]);
    expect(aclMocks.verifyPath).toHaveBeenCalledTimes(2);
    expect(aclMocks.verifyPath).toHaveBeenNthCalledWith(1, expect.stringMatching(/[/\\]miftah$/u), "directory");
    expect(aclMocks.verifyPath).toHaveBeenNthCalledWith(2, expect.stringMatching(/[/\\]miftah\.json$/u), "file");
  });

  it("fails closed before audit or config creation when the standard directory cannot be verified", async () => {
    const parent = await mkdtemp(join(tmpdir(), "miftah-console-windows-first-run-denied-"));
    temporaryDirectories.push(parent);
    const configDirectory = join(parent, "miftah");
    const configPath = join(configDirectory, "miftah.json");
    aclMocks.createPrivateDirectoryInParent.mockResolvedValue(false);
    aclMocks.verifyPaths.mockResolvedValue(false);
    const service = new ConsoleDashboardApplicationService({ configDirectory, defaultConfigPath: configPath });

    await expect(service.onboardNativeOAuth({
      name: "first-run",
      profile: "default",
      resource: "https://mcp.example.test/mcp",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: ["openid"]
    })).rejects.toMatchObject({ code: "CONFIG_CREATE_FAILED" });

    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reuses an existing verified setup-draft directory for a later mutation", async () => {
    const parent = await mkdtemp(join(tmpdir(), "miftah-setup-draft-windows-"));
    temporaryDirectories.push(parent);
    const store = new FileSetupDraftStore({ directory: join(parent, "setup-draft") });

    const draft = await store.save({
      source: "connector",
      name: "posthog-work",
      preset: "generic",
      stage: "connection"
    });

    await expect(store.discard(draft.revision)).resolves.toBeUndefined();
    expect(aclMocks.createPrivateDirectoryInParent).toHaveBeenCalledWith(parent, join(parent, "setup-draft"));
    expect(aclMocks.verifyPaths).toHaveBeenCalledWith([
      { path: parent, kind: "directory" },
      { path: join(parent, "setup-draft"), kind: "directory" }
    ]);
  });

  it("does not reverify a known draft during first-run cleanup", async () => {
    const parent = await mkdtemp(join(tmpdir(), "miftah-console-windows-first-run-draft-lifecycle-"));
    temporaryDirectories.push(parent);
    const configDirectory = join(parent, "miftah");
    const configPath = join(configDirectory, "miftah.json");
    const draftStore = new FileSetupDraftStore({ directory: join(parent, "setup-draft") });
    const service = new ConsoleDashboardApplicationService({
      configDirectory,
      defaultConfigPath: configPath,
      setupDraftStore: draftStore
    });
    const saveSetupDraft = service.saveSetupDraft;
    const loadSetupDraft = service.loadSetupDraft;
    if (saveSetupDraft === undefined || loadSetupDraft === undefined) {
      throw new Error("Expected the first-run service to expose the configured setup-draft capability.");
    }

    const draft = await saveSetupDraft({
      source: "connector",
      name: "support-tools",
      preset: "generic",
      stage: "connection"
    });
    await expect(loadSetupDraft()).resolves.toEqual(draft);
    await expect(service.onboardNativeOAuth({
      name: "first-run",
      profile: "default",
      resource: "https://mcp.example.test/mcp",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: ["openid"]
    })).resolves.toMatchObject({ changed: true, write: true });
    await expect(draftStore.load()).resolves.toBeUndefined();
    await expect(loadSetupDraft()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });

    expect(aclMocks.createPrivateDirectory).not.toHaveBeenCalled();
    expect(aclMocks.createPrivateDirectoryInParent).toHaveBeenCalledTimes(2);
    expect(aclMocks.secureFile).toHaveBeenCalledTimes(2);
    expect(aclMocks.verifyPath).toHaveBeenCalledTimes(5);
    expect(aclMocks.verifyPaths).toHaveBeenCalledTimes(3);
  });

  it("attributes Windows ACL helper launches across the complete first-run draft lifecycle", async () => {
    const parent = await mkdtemp(join(tmpdir(), "miftah-console-windows-first-run-draft-boundaries-"));
    temporaryDirectories.push(parent);
    const configDirectory = join(parent, "miftah");
    const configPath = join(configDirectory, "miftah.json");
    const draftStore = new FileSetupDraftStore({ directory: join(parent, "setup-draft") });
    const service = new ConsoleDashboardApplicationService({
      configDirectory,
      defaultConfigPath: configPath,
      setupDraftStore: draftStore
    });
    const saveSetupDraft = service.saveSetupDraft;
    const loadSetupDraft = service.loadSetupDraft;
    if (saveSetupDraft === undefined || loadSetupDraft === undefined) {
      throw new Error("Expected the first-run service to expose the configured setup-draft capability.");
    }

    const snapshot = (): Readonly<Record<"create" | "createInParent" | "secure" | "verify" | "verifyBatch", number>> => ({
      create: aclMocks.createPrivateDirectory.mock.calls.length,
      createInParent: aclMocks.createPrivateDirectoryInParent.mock.calls.length,
      secure: aclMocks.secureFile.mock.calls.length,
      verify: aclMocks.verifyPath.mock.calls.length,
      verifyBatch: aclMocks.verifyPaths.mock.calls.length
    });

    const draft = await saveSetupDraft({
      source: "connector",
      name: "support-tools",
      preset: "generic",
      stage: "connection"
    });
    const afterSave = snapshot();
    await expect(loadSetupDraft()).resolves.toEqual(draft);
    const afterLoad = snapshot();
    await expect(service.onboardNativeOAuth({
      name: "first-run",
      profile: "default",
      resource: "https://mcp.example.test/mcp",
      issuer: "https://auth.example.test",
      clientRegistration: "dynamic",
      scopes: ["openid"]
    })).resolves.toMatchObject({ changed: true, write: true });
    const afterPublication = snapshot();
    await expect(draftStore.load()).resolves.toBeUndefined();
    const afterDraftRead = snapshot();
    await expect(loadSetupDraft()).rejects.toMatchObject({ code: "CONSOLE_CONFIGURATION_SELECTION_REQUIRED" });
    const afterConfiguredRead = snapshot();

    expect({ afterSave, afterLoad, afterPublication, afterDraftRead, afterConfiguredRead }).toEqual({
      afterSave: { create: 0, createInParent: 1, secure: 1, verify: 0, verifyBatch: 0 },
      afterLoad: { create: 0, createInParent: 1, secure: 1, verify: 0, verifyBatch: 1 },
      afterPublication: { create: 0, createInParent: 2, secure: 2, verify: 3, verifyBatch: 2 },
      afterDraftRead: { create: 0, createInParent: 2, secure: 2, verify: 3, verifyBatch: 3 },
      afterConfiguredRead: { create: 0, createInParent: 2, secure: 2, verify: 5, verifyBatch: 3 }
    });
  });

  it("checks each stable setup-draft path ACL once before retaining its opened identity", async () => {
    const parent = await mkdtemp(join(tmpdir(), "miftah-setup-draft-windows-read-"));
    temporaryDirectories.push(parent);
    const directory = join(parent, "setup-draft");
    const store = new FileSetupDraftStore({ directory });
    const draft = await store.save({
      source: "connector",
      name: "posthog-work",
      preset: "generic",
      stage: "connection"
    });
    aclMocks.verifyPath.mockClear();
    aclMocks.verifyPaths.mockClear();

    await expect(store.load()).resolves.toEqual(draft);

    expect(aclMocks.verifyPath).not.toHaveBeenCalled();
    expect(aclMocks.verifyPaths).toHaveBeenCalledWith([
      { path: directory, kind: "directory" },
      { path: expect.stringMatching(/setup-draft-v1\.json$/u), kind: "file" }
    ]);
  });

  it("checks the protected parent chain before accepting an absent setup draft", async () => {
    const parent = await mkdtemp(join(tmpdir(), "miftah-setup-draft-windows-absent-"));
    temporaryDirectories.push(parent);
    const directory = join(parent, "setup-draft");
    const store = new FileSetupDraftStore({ directory });
    const draft = await store.save({
      source: "connector",
      name: "posthog-work",
      preset: "generic",
      stage: "connection"
    });
    await store.discard(draft.revision);
    aclMocks.verifyPath.mockClear();
    aclMocks.verifyPaths.mockClear();

    await expect(store.load()).resolves.toBeUndefined();

    expect(aclMocks.verifyPath).not.toHaveBeenCalled();
    expect(aclMocks.verifyPaths).toHaveBeenCalledWith([
      { path: parent, kind: "directory" },
      { path: directory, kind: "directory" }
    ]);
  });

  it("relies on completed Windows ACL helper verification when publishing a new draft", async () => {
    const parent = await mkdtemp(join(tmpdir(), "miftah-setup-draft-windows-write-"));
    temporaryDirectories.push(parent);
    const directory = join(parent, "setup-draft");
    const store = new FileSetupDraftStore({ directory });

    await expect(store.save({
      source: "connector",
      name: "posthog-work",
      preset: "generic",
      stage: "connection"
    })).resolves.toMatchObject({ revision: 1 });

    expect(aclMocks.createPrivateDirectoryInParent).toHaveBeenCalledWith(parent, directory);
    expect(aclMocks.secureFile).toHaveBeenCalledOnce();
    expect(aclMocks.verifyPath).not.toHaveBeenCalled();
    expect(aclMocks.verifyPaths).not.toHaveBeenCalled();
  });
});
