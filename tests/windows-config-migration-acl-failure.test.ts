import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const aclMocks = vi.hoisted(() => ({
  copy: vi.fn<() => Promise<boolean>>(),
  copyBatch: vi.fn<(source: string, targets: readonly string[]) => Promise<boolean>>(),
  createDirectory: vi.fn<(directory: string) => Promise<boolean>>()
}));

vi.mock("../src/cli/windows-config-acl.js", () => ({
  copyWindowsConfigSecurityDescriptor: aclMocks.copy,
  copyWindowsConfigSecurityDescriptors: aclMocks.copyBatch,
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
  aclMocks.copyBatch.mockResolvedValue(false);
});

afterEach(async () => {
  if (platformDescriptor !== undefined) Object.defineProperty(process, "platform", platformDescriptor);
  aclMocks.copy.mockReset();
  aclMocks.copyBatch.mockReset();
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

    expect(aclMocks.copyBatch).toHaveBeenCalledOnce();
    expect(aclMocks.copy).not.toHaveBeenCalled();
    expect(await readFile(configPath, "utf8")).toBe(original);
    await expect(access(`${configPath}.bak`)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readdir(directory)).some((entry) => entry.startsWith(".miftah.json.miftah-migrate-"))).toBe(false);
  });

  it("prepares both migration files before one batched descriptor verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-windows-config-acl-batch-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "miftah.json");
    const original = `${JSON.stringify(
      {
        version: "1",
        name: "acl-batch-contract",
        defaultProfile: "default",
        upstream: { transport: "http", url: "https://mcp.example.test" },
        profiles: { default: {} }
      },
      null,
      2
    )}\n`;
    await writeFile(configPath, original, "utf8");
    aclMocks.copy.mockResolvedValue(true);
    aclMocks.copyBatch.mockImplementation(async (_source, targets) => {
      expect(basename(_source)).toBe("source.miftah-migrate-hold");
      expect(targets.map((target) => basename(target))).toEqual([
        "backup.miftah-migrate.tmp",
        "candidate.miftah-migrate.tmp"
      ]);
      expect(targets).toHaveLength(2);
      await expect(Promise.all(targets.map((target) => readFile(target)))).resolves.toEqual([
        Buffer.alloc(0),
        Buffer.alloc(0)
      ]);
      return true;
    });

    await expect(runMigrateConfigCommand({ configPath, write: true })).resolves.toMatchObject({ write: true });

    expect(aclMocks.copyBatch).toHaveBeenCalledOnce();
    expect(aclMocks.copy).not.toHaveBeenCalled();
    expect(await readFile(`${configPath}.bak`, "utf8")).toBe(original);
    expect((await readdir(directory)).some((entry) => entry.startsWith(".miftah.json.miftah-migrate-"))).toBe(false);
  });
});
