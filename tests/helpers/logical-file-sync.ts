import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";

type FileHandlePrototype = {
  sync: FileHandle["sync"];
};

let fileHandlePrototype: FileHandlePrototype | undefined;

async function resolveFileHandlePrototype(): Promise<FileHandlePrototype> {
  if (fileHandlePrototype !== undefined) return fileHandlePrototype;
  const directory = await mkdtemp(join(tmpdir(), "miftah-logical-sync-probe-"));
  const probe = await open(join(directory, "probe"), "w", 0o600);
  try {
    fileHandlePrototype = Object.getPrototypeOf(probe) as FileHandlePrototype;
    return fileHandlePrototype;
  } finally {
    await probe.close();
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * Logical filesystem suites exercise production transaction and reader behavior
 * without benchmarking host disk-flush latency. Dedicated audit and OAuth rename
 * durability suites intentionally retain real sync integration coverage.
 */
export async function stubFileSyncForLogicalTest(): Promise<void> {
  const prototype = await resolveFileHandlePrototype();
  vi.spyOn(prototype, "sync").mockResolvedValue(undefined);
}
