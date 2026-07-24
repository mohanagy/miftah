import { appendFile, mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClientEntryImportError } from "../src/setup/client-entry-import.js";
import { readClientEntryImportFile } from "../src/setup/client-entry-import-file.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "miftah-client-entry-import-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("client entry import source files", () => {
  it("reads one explicitly selected absolute regular file without modifying its bytes", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "claude-desktop.json");
    const document = JSON.stringify({ mcpServers: { posthog: { command: "npx", args: ["--yes", "@posthog/mcp@1.2.3"] } } });
    await writeFile(source, document, { mode: 0o600 });

    await expect(readClientEntryImportFile(source)).resolves.toBe(document);
    await expect(readClientEntryImportFile(source)).resolves.toBe(document);
  });

  it("rejects relative paths and symlinks without revealing source content", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "cursor.json");
    const link = join(directory, "cursor-link.json");
    const secret = "client-file-secret-that-must-not-escape";
    await writeFile(source, JSON.stringify({ secret }), { mode: 0o600 });
    await symlink(source, link);

    await expect(readClientEntryImportFile("cursor.json")).rejects.toBeInstanceOf(ClientEntryImportError);
    await expect(readClientEntryImportFile(link)).rejects.toBeInstanceOf(ClientEntryImportError);
    await expect(readClientEntryImportFile(link)).rejects.not.toThrow(secret);
  });

  it("rejects a same-file growth race without falling back to an unbounded handle read", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "growing-client.json");
    const document = JSON.stringify({ mcpServers: { example: { command: "node", args: ["server.mjs"] } } });
    await writeFile(source, document, { mode: 0o600 });
    const probe = await open(source, "r");
    const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read; readFile: typeof probe.readFile };
    await probe.close();
    const originalRead = prototype.read;
    const originalReadFile = prototype.readFile;
    let grew = false;
    const grow = async (): Promise<void> => {
      if (grew) return;
      grew = true;
      await appendFile(source, "x".repeat(64 * 1024));
    };
    const read = vi.spyOn(prototype, "read").mockImplementation(async function (
      this: typeof probe,
      ...args: Parameters<typeof probe.read>
    ) {
      await grow();
      return originalRead.call(this, ...args);
    });
    const readFile = vi.spyOn(prototype, "readFile").mockImplementation(async function (
      this: typeof probe,
      ...args: Parameters<typeof probe.readFile>
    ) {
      await grow();
      return originalReadFile.call(this, ...args);
    });

    try {
      await expect(readClientEntryImportFile(source)).rejects.toBeInstanceOf(ClientEntryImportError);
      expect(read).toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
    } finally {
      read.mockRestore();
      readFile.mockRestore();
    }
  });
});
