import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const snapshotAuditJournal = vi.hoisted(() => vi.fn());

vi.mock("../src/audit/audit-journal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/audit/audit-journal.js")>();
  return { ...actual, snapshotAuditJournal };
});

import { runLogsCommand } from "../src/cli/logs.js";

const pollIntervalMs = 10;

function snapshot(
  segments: readonly { readonly name: string; readonly path: string; readonly identity?: string }[]
) {
  return {
    segments,
    cleanup: async (): Promise<void> => undefined
  };
}

describe("managed audit log follower", () => {
  it("fails closed when an identity-less retention gap makes archive-prefix transfer ambiguous", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-managed-audit-follow-"));
    const configPath = join(directory, "miftah.json");
    const priorActivePath = join(directory, "prior-active.jsonl");
    const survivingArchivePath = join(directory, "surviving-archive.jsonl");
    const replacementActivePath = join(directory, "replacement-active.jsonl");
    const archiveName = "audit.jsonl.miftah-00000000000000000002-00000000-0000-4000-8000-000000000002";
    try {
      await writeFile(
        configPath,
        JSON.stringify({
          version: "1",
          name: "managed-audit-follow",
          defaultProfile: "default",
          upstream: { transport: "stdio", command: process.execPath },
          profiles: { default: {} },
          audit: { path: "audit.jsonl", rotation: { maxBytes: 1, retainFiles: 1 } }
        })
      );
      await writeFile(priorActivePath, '{"name":"prior-active-event"}\n');
      await writeFile(survivingArchivePath, '{"name":"surviving-archive-event"}\n');
      await writeFile(replacementActivePath, '{"name":"replacement-active-event"}\n');

      let calls = 0;
      snapshotAuditJournal.mockImplementation(async () => {
        calls += 1;
        if (calls === 1) return snapshot([{ name: "audit.jsonl", path: priorActivePath }]);
        if (calls === 2) {
          // Two rotations completed before the next poll; retention has already removed the prior active archive.
          return snapshot([
            { name: archiveName, path: survivingArchivePath },
            { name: "audit.jsonl", path: replacementActivePath }
          ]);
        }
        throw new Error("test follower should have stopped at the ambiguous rotation boundary");
      });

      const output: string[] = [];
      const follower = runLogsCommand({
        configPath,
        follow: true,
        write: (chunk) => output.push(chunk),
        pollIntervalMs
      });

      await expect(follower).rejects.toThrow(
        "Audit journal rotation cannot be followed safely without stable file identity."
      );
      expect(output).toEqual(['{"name":"prior-active-event"}\n']);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
