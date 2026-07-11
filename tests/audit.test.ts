import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AuditLogger } from "../src/audit/audit-logger.js";

describe("audit logger", () => {
  it("writes structured events without secret arguments", async () => {
    const directory = await mkdtemp(join(tmpdir(), "miftah-audit-"));
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path, { secretValues: ["hidden-token"] });

    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "whoami",
      status: "success",
      durationMs: 4,
      arguments: { token: "hidden-token" }
    });

    const line = await readFile(path, "utf8");
    expect(line).not.toContain("hidden-token");
    expect(JSON.parse(line)).toMatchObject({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      status: "success"
    });
  });

  it.skipIf(process.platform === "win32")("creates audit directories and files with owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "miftah-audit-permissions-"));
    const directory = join(root, "private");
    const path = join(directory, "audit.jsonl");
    const logger = new AuditLogger(path);

    await logger.log({
      wrapper: "github",
      profile: "work",
      operation: "tools/call",
      name: "whoami",
      status: "success",
      durationMs: 4
    });

    expect((await stat(directory)).mode & 0o077).toBe(0);
    expect((await stat(path)).mode & 0o077).toBe(0);
  });
});
