import { mkdir, rm, writeFile } from "node:fs/promises";
import { delimiter, join, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { resolveExecutablePath, resolveWindowsDirectExecutablePath } from "../src/secrets/executable-resolver.js";

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

async function inWindowsPathSandbox<T>(run: () => Promise<T>): Promise<T> {
  const originalDirectory = process.cwd();
  return inSandbox(async (directory) => {
    process.chdir(directory);
    try {
      return await run();
    } finally {
      process.chdir(originalDirectory);
    }
  });
}

async function createExecutableMarker(path: string): Promise<void> {
  await writeFile(path, "", { mode: 0o700 });
}

describe("secret executable resolution", () => {
  it.runIf(process.platform === "win32")(
    "resolves a Windows PATH command only through .exe or .com candidates",
    async () => {
      await inSandbox(async (directory) => {
        const binDirectory = win32.join(directory, "bin");
        const executable = win32.join(binDirectory, "provider.exe");
        const commandShim = win32.join(binDirectory, "provider.cmd");
        await mkdir(binDirectory);
        await Promise.all([createExecutableMarker(executable), createExecutableMarker(commandShim)]);

        await expect(
          resolveWindowsDirectExecutablePath("provider", {
            platform: "win32",
            environment: { PATH: binDirectory }
          })
        ).resolves.toBe(executable);
        await expect(
          resolveWindowsDirectExecutablePath(commandShim, {
            platform: "win32",
            environment: { PATH: binDirectory }
          })
        ).resolves.toBeUndefined();
      });
    }
  );

  it.runIf(process.platform !== "win32")(
    "applies the direct Windows executable policy with Windows PATH semantics",
    async () => {
      await inWindowsPathSandbox(async () => {
        const executable = "C:\\tools\\provider.exe";
        const comExecutable = "C:\\tools\\provider.com";
        await Promise.all([createExecutableMarker(executable), createExecutableMarker(comExecutable)]);

        await expect(
          resolveWindowsDirectExecutablePath("provider", {
            platform: "win32",
            environment: { Path: '"C:\\tools"' }
          })
        ).resolves.toBe(executable);
        await expect(
          resolveWindowsDirectExecutablePath("provider.com", {
            platform: "win32",
            environment: { PATH: "relative;C:\\tools" }
          })
        ).resolves.toBe(comExecutable);
        await expect(
          resolveWindowsDirectExecutablePath("C:\\tools\\missing.exe", { platform: "win32", environment: {} })
        ).resolves.toBeUndefined();
      });
    }
  );

  it("fails closed when a Windows direct executable cannot be established", async () => {
    await expect(resolveWindowsDirectExecutablePath("provider", { platform: "darwin" })).resolves.toBeUndefined();
    await expect(resolveWindowsDirectExecutablePath("", { platform: "win32", environment: {} })).resolves.toBeUndefined();
    await expect(resolveWindowsDirectExecutablePath("provider\u0000", { platform: "win32", environment: {} })).resolves.toBeUndefined();
    await expect(resolveWindowsDirectExecutablePath("provider", { platform: "win32", environment: {} })).resolves.toBeUndefined();
    await expect(resolveWindowsDirectExecutablePath(".\\provider.exe", { platform: "win32", environment: {} })).resolves.toBeUndefined();
    await expect(resolveWindowsDirectExecutablePath("C:\\tools\\provider.cmd", { platform: "win32", environment: {} })).resolves.toBeUndefined();
  });

  it("resolves a bare command from an absolute PATH entry", async () => {
    await inSandbox(async (directory) => {
      const binDirectory = join(directory, "bin");
      const executable = join(binDirectory, "provider");
      await mkdir(binDirectory);
      await createExecutableMarker(executable);

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
      await createExecutableMarker(shadowedExecutable);

      await expect(
        resolveExecutablePath("provider", {
          cwd: workingDirectory,
          environment: { PATH: join(directory, "empty-path") + delimiter }
        })
      ).resolves.toBeUndefined();
    });
  });

  it.runIf(process.platform !== "win32")(
    "uses the selected Windows platform delimiter instead of the host delimiter",
    async () => {
      await inSandbox(async (directory) => {
        const firstBinDirectory = join(directory, "first-bin");
        const secondBinDirectory = join(directory, "second-bin");
        const executable = win32.join(firstBinDirectory, "provider");
        await mkdir(firstBinDirectory);
        await mkdir(secondBinDirectory);
        await createExecutableMarker(executable);

        try {
          await expect(
            resolveExecutablePath("provider", {
              platform: "win32",
              environment: { PATH: `${firstBinDirectory};${secondBinDirectory}`, PATHEXT: "" }
            })
          ).resolves.toBe(executable);
        } finally {
          await rm(executable, { force: true });
        }
      });
    }
  );

  it("resolves explicit relative paths and case-insensitive quoted PATH entries", async () => {
    await inSandbox(async (directory) => {
      const binDirectory = join(directory, "bin");
      const executable = join(binDirectory, "provider");
      await mkdir(binDirectory);
      await createExecutableMarker(executable);

      await expect(
        resolveExecutablePath("./provider", {
          cwd: binDirectory,
          environment: {}
        })
      ).resolves.toBe(executable);
      await expect(
        resolveExecutablePath("provider", {
          environment: { Path: `"${binDirectory}"` }
        })
      ).resolves.toBe(executable);
      await expect(resolveExecutablePath("", { environment: {} })).resolves.toBeUndefined();
      await expect(resolveExecutablePath("provider\u0000", { environment: {} })).resolves.toBeUndefined();
    });
  });
});
