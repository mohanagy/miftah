import { mkdtemp, readFile } from "node:fs/promises";
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
});
