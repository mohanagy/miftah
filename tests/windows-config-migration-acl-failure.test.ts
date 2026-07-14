import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aclMocks = vi.hoisted(() => ({
  copy: vi.fn<() => Promise<boolean>>(),
  createDirectory: vi.fn<(directory: string) => Promise<boolean>>()
}));

vi.mock("../src/cli/windows-config-acl.js", () => ({
  copyWindowsConfigSecurityDescriptor: aclMocks.copy,
  createWindowsPrivateMigrationDirectory: aclMocks.createDirectory
}));

import { runMigrateConfigCommand } from "../src/cli/migrate-config.js";

const temporaryDirectories: string[] = [];
const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

beforeEach(() => {
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  aclMocks.createDirectory.mockImplementation(async (directory) => {
    await mkdir(directory, { mode: 0o700 });
    return true;
  });
  aclMocks.copy.mockResolvedValue(false);
});

afterEach(async () => {
  if (platformDescriptor !== undefined) Object.defineProperty(process, "platform", platformDescriptor);
  aclMocks.copy.mockReset();
  aclMocks.createDirectory.mockReset();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Windows migration ACL failure boundary", () => {
  it("fails closed before writing a backup or candidate when descriptor setup cannot be verified", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-windows-config-acl-failure-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify(
      {
        version: "1",
        name: "acl-failure-contract",
        defaultProfile: "default",
        upstream: { transport: "http", url: "https://mcp.example.test" },
        profiles: { default: {} }
      },
      null,
      2
    )}\n`;
    await writeFile(configPath, original, "utf8");

    await expect(runMigrateConfigCommand({ configPath, write: true })).rejects.toMatchObject({
      code: "CONFIG_MIGRATION_WRITE_FAILED"
    });

    expect(aclMocks.copy).toHaveBeenCalledOnce();
    expect(await readFile(configPath, "utf8")).toBe(original);
    await expect(access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(directory)).some((entry) => entry.startsWith(".miftah.json.miftah-migrate-"))).toBe(false);
  });
});
