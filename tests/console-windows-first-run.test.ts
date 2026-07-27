import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aclMocks = vi.hoisted(() => ({
  createPrivateDirectory: vi.fn<(directory: string) => Promise<boolean>>(),
  secureFile: vi.fn<(path: string) => Promise<boolean>>(),
  verifyPath: vi.fn<(path: string, kind: "file" | "directory") => Promise<boolean>>()
}));

vi.mock("../src/cli/windows-config-acl.js", () => ({
  createWindowsPrivateDirectory: aclMocks.createPrivateDirectory,
  secureWindowsConfigFile: aclMocks.secureFile,
  verifyWindowsConfigPathSecurity: aclMocks.verifyPath
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
  aclMocks.secureFile.mockResolvedValue(true);
  aclMocks.createPrivateDirectory.mockImplementation(async (directory) => {
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
  aclMocks.secureFile.mockReset();
  aclMocks.verifyPath.mockReset();
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

    expect(aclMocks.createPrivateDirectory).toHaveBeenCalledWith(configDirectory);
    // Catalog discovery independently verifies the created configuration after
    // publication. The creator must not add a second directory probe before it.
    expect(aclMocks.verifyPath).toHaveBeenCalledTimes(3);
    expect(aclMocks.verifyPath).toHaveBeenNthCalledWith(1, parent, "directory");
    expect(aclMocks.verifyPath).toHaveBeenNthCalledWith(2, expect.stringMatching(/[/\\]miftah$/u), "directory");
    expect(aclMocks.verifyPath).toHaveBeenNthCalledWith(3, expect.stringMatching(/[/\\]miftah\.json$/u), "file");
    expect(aclMocks.secureFile).toHaveBeenCalledWith(configPath);
  });

  it("fully verifies a first-run config directory created by another Windows process", async () => {
    const parent = await mkdtemp(join(tmpdir(), "miftah-console-windows-first-run-race-"));
    temporaryDirectories.push(parent);
    const configDirectory = join(parent, "miftah");
    const configPath = join(configDirectory, "miftah.json");
    aclMocks.createPrivateDirectory.mockImplementationOnce(async (directory) => {
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

    expect(aclMocks.verifyPath).toHaveBeenCalledTimes(4);
    expect(aclMocks.verifyPath).toHaveBeenNthCalledWith(1, parent, "directory");
    expect(aclMocks.verifyPath).toHaveBeenNthCalledWith(2, configDirectory, "directory");
    expect(aclMocks.verifyPath).toHaveBeenNthCalledWith(3, expect.stringMatching(/[/\\]miftah$/u), "directory");
    expect(aclMocks.verifyPath).toHaveBeenNthCalledWith(4, expect.stringMatching(/[/\\]miftah\.json$/u), "file");
  });

  it("fails closed before audit or config creation when the standard directory cannot be verified", async () => {
    const parent = await mkdtemp(join(tmpdir(), "miftah-console-windows-first-run-denied-"));
    temporaryDirectories.push(parent);
    const configDirectory = join(parent, "miftah");
    const configPath = join(configDirectory, "miftah.json");
    aclMocks.createPrivateDirectory.mockResolvedValue(false);
    aclMocks.verifyPath.mockResolvedValue(false);
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
    expect(aclMocks.createPrivateDirectory).toHaveBeenCalledTimes(1);
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

    await expect(store.load()).resolves.toEqual(draft);

    expect(aclMocks.verifyPath).toHaveBeenCalledTimes(2);
    expect(aclMocks.verifyPath).toHaveBeenNthCalledWith(1, directory, "directory");
    expect(aclMocks.verifyPath).toHaveBeenNthCalledWith(2, expect.stringMatching(/setup-draft-v1\.json$/u), "file");
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

    expect(aclMocks.createPrivateDirectory).toHaveBeenCalledWith(directory);
    expect(aclMocks.secureFile).toHaveBeenCalledOnce();
    expect(aclMocks.verifyPath).toHaveBeenCalledTimes(1);
    expect(aclMocks.verifyPath).toHaveBeenCalledWith(parent, "directory");
  });
});
