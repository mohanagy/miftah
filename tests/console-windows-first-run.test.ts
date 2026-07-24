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

import { ConsoleDashboardApplicationService } from "../src/console/console-dashboard-application-service.js";

const temporaryDirectories: string[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  aclMocks.verifyPath.mockResolvedValue(true);
  aclMocks.secureFile.mockResolvedValue(true);
  aclMocks.createPrivateDirectory.mockImplementation(async (directory) => {
    await mkdir(directory, { recursive: true });
    return true;
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
  it("creates and verifies the standard config directory before writing the first configuration", async () => {
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
    expect(aclMocks.verifyPath).toHaveBeenCalledWith(configDirectory, "directory");
    expect(aclMocks.secureFile).toHaveBeenCalledWith(configPath);
    expect(aclMocks.verifyPath).toHaveBeenCalledWith(expect.stringMatching(/[/\\]miftah\.json$/u), "file");
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
});
