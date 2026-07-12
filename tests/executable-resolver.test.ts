import { copyFile, mkdir, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { resolveExecutablePath } from "../src/secrets/executable-resolver.js";

const testRoot = join(process.cwd(), ".miftah-executable-resolver-tests");

afterAll(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

async function inSandbox<T>(run: (directory: string) => Promise<T>): Promise<T> {
  const directory = join(testRoot, randomUUID());
  await mkdir(directory, { recursive: true });
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("secret executable resolution", () => {
  it("resolves a bare command from an absolute PATH entry", async () => {
    await inSandbox(async (directory) => {
      const binDirectory = join(directory, "bin");
      const executable = join(binDirectory, "provider");
      await mkdir(binDirectory);
      await copyFile(process.execPath, executable);

      await expect(
        resolveExecutablePath("provider", {
          environment: { PATH: binDirectory }
        })
      ).resolves.toBe(executable);
    });
  });

  it("does not search the current directory for a bare command", async () => {
    await inSandbox(async (directory) => {
      const workingDirectory = join(directory, "working-directory");
      const shadowedExecutable = join(workingDirectory, "provider");
      await mkdir(workingDirectory);
      await copyFile(process.execPath, shadowedExecutable);

      await expect(
        resolveExecutablePath("provider", {
          cwd: workingDirectory,
          environment: { PATH: join(directory, "empty-path") + delimiter }
        })
      ).resolves.toBeUndefined();
    });
  });
});
